"use strict";

const crypto = require("node:crypto");
const { isIP } = require("node:net");
const { promisify } = require("node:util");
const { ApiError } = require("../backend/dist/service.js");
const { accountAccess, inviteEligibility } = require("./account-access.cjs");
const { reserveAttempts, refundAttempts } = require("./rate-limit.cjs");
const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

class HttpError extends Error {
  constructor(status, code, message, retryAfterSeconds) {
    super(message);
    this.status = status;
    this.code = code;
    if (retryAfterSeconds !== undefined)
      this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}
const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

function canonicalIp(value) {
  if (typeof value !== "string" || value.includes("%")) return undefined;
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return undefined;
  // Equivalent IPv6 spellings must share a limit bucket, including IPv4-mapped
  // addresses reported by a dual-stack server socket.
  const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(normalized);
  if (!mapped) return normalized;
  const upper = parseInt(mapped[1], 16);
  const lower = parseInt(mapped[2], 16);
  return [upper >>> 8, upper & 255, lower >>> 8, lower & 255].join(".");
}

function clientIp(req, trustProxyHops = 0) {
  const direct = canonicalIp(req.socket.remoteAddress) || "unknown";
  if (
    !Number.isInteger(trustProxyHops) ||
    trustProxyHops < 1 ||
    trustProxyHops > 16
  )
    return direct;
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded !== "string" || forwarded.length > 2048) return direct;
  const chain = forwarded.split(",").map((value) => value.trim());
  if (chain.length < trustProxyHops) return direct;
  // The socket itself is the final trusted hop. Walk only the configured
  // number of entries from the right; attacker-supplied left entries do not
  // select the client. Deployment must make direct access to this API private.
  const trustedSuffix = chain.slice(-trustProxyHops).map(canonicalIp);
  return trustedSuffix.every(Boolean) ? trustedSuffix[0] : direct;
}

function normalizePhone(value) {
  if (typeof value !== "string" || value.length > 30)
    throw new HttpError(400, "INVALID_INPUT", "请输入正确的手机号");
  let phone = value.replace(/[\s()-]/g, "");
  if (/^1[3-9]\d{9}$/.test(phone)) phone = `+86${phone}`;
  if (
    !/^\+[1-9]\d{7,14}$/.test(phone) ||
    (phone.startsWith("+86") && !/^\+861[3-9]\d{9}$/.test(phone))
  )
    throw new HttpError(
      400,
      "INVALID_INPUT",
      "大陆手机号直接填写，其他地区请加国家区号",
    );
  return phone;
}

function validatePassword(value) {
  if (typeof value !== "string" || value.length < 6 || value.length > 128)
    throw new HttpError(400, "INVALID_PASSWORD", "密码须为 6–128 位");
}

async function passwordHash(password) {
  validatePassword(password);
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function passwordMatches(password, saved) {
  if (typeof password !== "string" || password.length > 128) return false;
  const parts = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(saved || "");
  // Equal-cost work for unknown accounts avoids a timing-based account probe.
  const salt = parts ? Buffer.from(parts[1], "hex") : Buffer.alloc(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return Boolean(
    parts && crypto.timingSafeEqual(key, Buffer.from(parts[2], "hex")),
  );
}

const publicUser = (row, access) => ({
  id: row.id,
  phone: row.phone,
  phoneVerified: false,
  canCreateFamily: false,
  ...access,
});

function remembered(body) {
  if (body.remember !== undefined && typeof body.remember !== "boolean")
    throw new HttpError(400, "INVALID_INPUT", "记住登录状态须为明确选择");
  return body.remember === true;
}

function deviceName(req) {
  const ua = String(req.headers["user-agent"] || "").slice(0, 512);
  const platform = /iPhone|iPad/i.test(ua)
    ? "iPhone/iPad"
    : /Android/i.test(ua)
      ? "安卓"
      : /Windows/i.test(ua)
        ? "Windows"
        : /Macintosh|Mac OS/i.test(ua)
          ? "Mac"
          : /Linux/i.test(ua)
            ? "Linux"
            : "未知设备";
  const browser = /MicroMessenger/i.test(ua)
    ? "微信浏览器"
    : /Edg\//i.test(ua)
      ? "Edge"
      : /Firefox\//i.test(ua)
        ? "Firefox"
        : /Chrome\//i.test(ua)
          ? "Chrome"
          : /Safari\//i.test(ua)
            ? "Safari"
            : "浏览器";
  return `${platform} · ${browser}`;
}

function readDocument(db, collection, id) {
  const row = db
    .prepare("SELECT body FROM documents WHERE collection = ? AND id = ?")
    .get(collection, id);
  return row ? JSON.parse(row.body) : undefined;
}

function availableInvite(db, token, now, accountId) {
  if (token === undefined || token === "")
    throw new HttpError(
      403,
      "INVITE_REQUIRED",
      "请使用家人发给你的邀请链接注册",
    );
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(token))
    throw new HttpError(403, "INVALID_INVITE", "邀请不存在或已失效");
  const id = hashToken(token);
  const invite = readDocument(db, "invites", id);
  const circle = invite
    ? readDocument(db, "circles", invite.circleId)
    : undefined;
  if (
    !invite ||
    invite.tokenHash !== id ||
    circle?.type !== "family" ||
    circle.mode !== "shared"
  )
    throw new HttpError(403, "INVALID_INVITE", "邀请不存在或已失效");
  if (invite.revokedAt || invite.usedAt || now >= invite.expiresAt)
    throw new HttpError(
      403,
      "INVITE_INACTIVE",
      "邀请已使用、过期或被撤销，请联系家人重新邀请",
    );
  const assigned = db
    .prepare("SELECT account_id FROM invite_accounts WHERE invite_id = ?")
    .get(id);
  if (assigned && assigned.account_id !== accountId)
    throw new HttpError(
      403,
      "INVITE_ASSIGNED",
      "这份邀请已绑定一个账号，请使用原账号登录或联系家人重新邀请",
    );
  if (!assigned) {
    const other = db
      .prepare(
        "SELECT 1 FROM documents WHERE collection = 'applications' AND json_extract(body, '$.inviteId') = ? AND json_extract(body, '$.status') = 'pending' AND json_extract(body, '$.userId') IS NOT ? LIMIT 1",
      )
      .get(id, accountId ?? null);
    if (other)
      throw new HttpError(
        403,
        "INVITE_ASSIGNED",
        "这份邀请已有其他人的申请，请联系家人重新邀请",
      );
  }
  if (accountId && !inviteEligibility(db, invite, accountId, now))
    throw new HttpError(
      403,
      "INVITE_INACTIVE",
      "这份邀请不能继续使用，请管理员重新发送邀请",
    );
  return invite;
}

class Authentication {
  constructor(store, config, now = Date.now) {
    this.store = store;
    this.config = config;
    this.now = now;
    this.hashesInFlight = 0;
    this.passwordQueue = [];
  }

  async withPasswordWork(work) {
    const busy = () =>
      new HttpError(429, "RATE_LIMITED", "登录人数较多，请稍后再试", 2);
    if (this.hashesInFlight >= 4) {
      if (this.passwordQueue.length >= 64) throw busy();
      await new Promise((resolve, reject) => {
        const entry = { resolve, timer: undefined };
        entry.timer = setTimeout(() => {
          const index = this.passwordQueue.indexOf(entry);
          if (index !== -1) this.passwordQueue.splice(index, 1);
          reject(busy());
        }, 15_000);
        this.passwordQueue.push(entry);
      });
      // The finishing job hands its slot directly to the oldest waiter.
    } else this.hashesInFlight++;
    try {
      return await work();
    } finally {
      const next = this.passwordQueue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve();
      } else this.hashesInFlight--;
    }
  }

  async limit(ip, phone) {
    const { retryAfter, reservations } = await this.store.exclusive((db) =>
      reserveAttempts(
        db,
        [
          [`ip:${hashToken(ip)}`, this.config.authIpLimit],
          [`phone:${hashToken(phone)}`, this.config.authPhoneLimit],
        ],
        this.now(),
        this.config.authWindow,
      ),
    );
    if (retryAfter)
      throw new HttpError(
        429,
        "RATE_LIMITED",
        `尝试次数较多，请约 ${retryAfter < 60 ? `${retryAfter} 秒` : `${Math.ceil(retryAfter / 60)} 分钟`}后再试`,
        retryAfter,
      );
    return () => this.store.exclusive((db) => refundAttempts(db, reservations));
  }

  async passwordAttempt(req, phone, work) {
    return this.withPasswordWork(async () => {
      // Check inside the queue: previous failures are visible before hashing,
      // while successful users on the same Wi-Fi return their budget promptly.
      const refund = await this.limit(
        clientIp(req, this.config.trustProxyHops),
        phone,
      );
      const result = await work();
      await refund();
      return result;
    });
  }

  cookie(token, clear = false, lifetime = this.config.sessionLifetime) {
    return `${this.config.cookieName}=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : Math.floor(lifetime / 1000)}${this.config.production ? "; Secure" : ""}`;
  }

  readToken(req) {
    const items = String(req.headers.cookie || "")
      .split(";")
      .map((value) => value.trim());
    const values = items.filter((value) =>
      value.startsWith(`${this.config.cookieName}=`),
    );
    if (values.length !== 1) return undefined;
    const token = values[0].slice(this.config.cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  }

  async current(req) {
    const token = this.readToken(req);
    if (!token) return undefined;
    const tokenHash = hashToken(token);
    const row = await this.store.exclusive((db) => {
      const current = db
        .prepare(
          "SELECT a.*, s.token_hash, s.public_id, s.remembered, s.last_seen_at FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ?",
        )
        .get(tokenHash, this.now());
      if (!current) return undefined;
      const access = accountAccess(db, current.id, this.now());
      if (!access) {
        db.prepare("DELETE FROM sessions WHERE account_id = ?").run(current.id);
        return { ineligible: true };
      }
      if (this.now() - current.last_seen_at >= 60_000)
        db.prepare(
          "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?",
        ).run(this.now(), tokenHash);
      return { ...current, access };
    });
    if (row?.ineligible) return row;
    return row
      ? { user: publicUser(row, row.access), row, tokenHash }
      : undefined;
  }

  issue(
    db,
    accountId,
    priorToken,
    req,
    remember = false,
    reauthenticatedAt = 0,
  ) {
    const now = this.now();
    const token = crypto.randomBytes(32).toString("base64url");
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    if (priorToken)
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(
        hashToken(priorToken),
      );
    // Limit retained devices without exposing tokens to either logs or JSON.
    db.prepare(
      "DELETE FROM sessions WHERE account_id = ? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE account_id = ? ORDER BY created_at DESC LIMIT 9)",
    ).run(accountId, accountId);
    const lifetime = remember
      ? this.config.rememberedSessionLifetime
      : this.config.sessionLifetime;
    db.prepare(
      "INSERT INTO sessions(token_hash, account_id, expires_at, created_at, public_id, device_name, last_seen_at, reauthenticated_at, remembered) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      hashToken(token),
      accountId,
      now + lifetime,
      now,
      crypto.randomUUID(),
      deviceName(req),
      now,
      reauthenticatedAt,
      Number(remember),
    );
    return { token, sessionLifetime: lifetime };
  }

  async register(body, req) {
    const phone = normalizePhone(body.phone);
    return this.passwordAttempt(req, phone, () =>
      this.registerAttempt(body, req),
    );
  }

  async registerAttempt(body, req) {
    const phone = normalizePhone(body.phone);
    const remember = remembered(body);
    // Reject missing/invalid invitations before spending a password hash.
    await this.store.exclusive((db) =>
      availableInvite(db, body.inviteToken, this.now()),
    );
    const saved = await passwordHash(body.password);
    return this.store.exclusive((db) => {
      const invite = availableInvite(db, body.inviteToken, this.now());
      if (db.prepare("SELECT id FROM accounts WHERE phone = ?").get(phone))
        throw new HttpError(409, "ACCOUNT_EXISTS", "该手机号已注册，请登录");
      const row = { id: `web_${crypto.randomUUID()}`, phone };
      db.prepare("INSERT INTO accounts VALUES(?, ?, ?, ?)").run(
        row.id,
        phone,
        saved,
        this.now(),
      );
      db.prepare("INSERT INTO invite_accounts VALUES(?, ?, ?)").run(
        invite.id,
        row.id,
        this.now(),
      );
      return {
        user: publicUser(row, accountAccess(db, row.id, this.now())),
        ...this.issue(
          db,
          row.id,
          this.readToken(req),
          req,
          remember,
          this.now(),
        ),
      };
    });
  }

  async registrationAvailable(token) {
    return this.store.exclusive((db) => {
      try {
        availableInvite(db, token, this.now());
        return true;
      } catch (error) {
        if (error instanceof HttpError) return false;
        throw error;
      }
    });
  }

  async login(body, req) {
    const phone = normalizePhone(body.phone);
    return this.passwordAttempt(req, phone, () => this.loginAttempt(body, req));
  }

  async loginAttempt(body, req) {
    const phone = normalizePhone(body.phone);
    const remember = remembered(body);
    const row = await this.store.exclusive((db) =>
      db.prepare("SELECT * FROM accounts WHERE phone = ?").get(phone),
    );
    const matches = await passwordMatches(body.password, row?.password_hash);
    if (!matches)
      throw new HttpError(401, "BAD_CREDENTIALS", "手机号或密码错误");
    return this.store.exclusive((db) => {
      const latest = db
        .prepare("SELECT * FROM accounts WHERE id = ?")
        .get(row.id);
      if (!latest || latest.password_hash !== row.password_hash)
        throw new HttpError(401, "BAD_CREDENTIALS", "密码已更改，请重新登录");
      let access = accountAccess(db, row.id, this.now());
      const restoringAccess = !access;
      if (body.inviteToken !== undefined && body.inviteToken !== "") {
        // A valid password is required before an old account may reserve a
        // new invitation. A used/expired link does not lock an active member.
        if (access?.access !== "member") {
          const invite = availableInvite(
            db,
            body.inviteToken,
            this.now(),
            row.id,
          );
          db.prepare(
            "INSERT INTO invite_accounts(invite_id, account_id, created_at) VALUES(?, ?, ?) ON CONFLICT(invite_id) DO NOTHING",
          ).run(invite.id, row.id, this.now());
          access = accountAccess(db, row.id, this.now());
        }
      }
      if (!access) throw this.accessDenied();
      if (restoringAccess)
        db.prepare("DELETE FROM sessions WHERE account_id = ?").run(row.id);
      return {
        user: publicUser(latest, access),
        ...this.issue(
          db,
          row.id,
          this.readToken(req),
          req,
          remember,
          this.now(),
        ),
      };
    });
  }

  async changePassword(body, req, current) {
    return this.passwordAttempt(req, current.user.phone, () =>
      this.changePasswordAttempt(body, req, current),
    );
  }

  async changePasswordAttempt(body, req, current) {
    if (!(await passwordMatches(body.currentPassword, current.row.password_hash)))
      throw new HttpError(401, "BAD_CREDENTIALS", "当前密码错误");
    const saved = await passwordHash(body.newPassword);
    return this.store.exclusive((db) => {
      this.requireSession(db, current);
      const row = db
        .prepare("SELECT * FROM accounts WHERE id = ?")
        .get(current.user.id);
      const session = db
        .prepare(
          "SELECT account_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
        )
        .get(current.tokenHash, this.now());
      if (!session || !row || row.password_hash !== current.row.password_hash)
        throw new HttpError(401, "UNAUTHENTICATED", "请重新登录");
      db.prepare("UPDATE accounts SET password_hash = ? WHERE id = ?").run(
        saved,
        row.id,
      );
      db.prepare("DELETE FROM sessions WHERE account_id = ?").run(row.id);
      return {
        user: publicUser(row, accountAccess(db, row.id, this.now())),
        ...this.issue(
          db,
          row.id,
          undefined,
          req,
          Boolean(current.row.remembered),
          this.now(),
        ),
      };
    });
  }

  requireSession(db, current, requireRecent = false) {
    const row =
      current &&
      db
        .prepare(
          "SELECT * FROM sessions WHERE token_hash = ? AND account_id = ? AND expires_at > ?",
        )
        .get(current.tokenHash, current.user.id, this.now());
    if (!row)
      throw new HttpError(401, "UNAUTHENTICATED", "登录已失效，请重新登录");
    if (!accountAccess(db, current.user.id, this.now()))
      throw this.accessDenied();
    if (
      requireRecent &&
      (!row.reauthenticated_at ||
        this.now() >=
          row.reauthenticated_at + this.config.reauthenticationLifetime)
    )
      throw new HttpError(
        403,
        "REAUTH_REQUIRED",
        "请再确认一次密码后继续此操作",
      );
    return row;
  }

  accessDenied() {
    return new HttpError(
      403,
      "ACCOUNT_NOT_INVITED",
      "此账号尚未获邀或加入资格已失效，请通过管理员的新邀请登录",
    );
  }

  async invalidateIneligible(current) {
    if (!current?.user) return;
    await this.store.exclusive((db) => {
      if (!accountAccess(db, current.user.id, this.now()))
        db.prepare("DELETE FROM sessions WHERE account_id = ?").run(
          current.user.id,
        );
    });
  }

  revokeIneligibleForAction(db, current, action, payload = {}) {
    const affected = new Set();
    if (action === "member.leave") affected.add(current.user.id);
    if (action === "member.remove") {
      const member =
        typeof payload.memberId === "string" &&
        readDocument(db, "members", payload.memberId);
      if (member?.userId) affected.add(member.userId);
    }
    if (action === "join.reject") {
      const application = readDocument(
        db,
        "applications",
        payload.applicationId,
      );
      if (application?.userId) affected.add(application.userId);
    }
    if (action === "invite.revoke") {
      const assigned = db
        .prepare("SELECT account_id FROM invite_accounts WHERE invite_id = ?")
        .get(payload.inviteId);
      if (assigned) affected.add(assigned.account_id);
      for (const row of db
        .prepare(
          "SELECT json_extract(body, '$.userId') AS user_id FROM documents WHERE collection = 'applications' AND json_extract(body, '$.inviteId') = ?",
        )
        .all(payload.inviteId))
        if (row.user_id) affected.add(row.user_id);
    }
    for (const accountId of affected)
      if (!accountAccess(db, accountId, this.now()))
        db.prepare("DELETE FROM sessions WHERE account_id = ?").run(accountId);
  }

  guard(current, { requireRecent = false, action, payload = {} } = {}) {
    return (db) => {
      try {
        this.requireSession(db, current, requireRecent);
        if (action === "invite.apply") {
          const invite = availableInvite(
            db,
            payload.token,
            this.now(),
            current.user.id,
          );
          db.prepare(
            "INSERT INTO invite_accounts(invite_id, account_id, created_at) VALUES(?, ?, ?) ON CONFLICT(invite_id) DO NOTHING",
          ).run(invite.id, current.user.id, this.now());
        }
        if (
          action === "join.approve" &&
          typeof payload.applicationId === "string"
        ) {
          const application = readDocument(
            db,
            "applications",
            payload.applicationId,
          );
          const assigned =
            application &&
            db
              .prepare(
                "SELECT account_id FROM invite_accounts WHERE invite_id = ?",
              )
              .get(application.inviteId);
          if (assigned && assigned.account_id !== application.userId)
            throw new HttpError(
              403,
              "INVITE_ASSIGNED",
              "这份邀请已绑定另一个账号，请让申请人使用新邀请",
            );
        }
      } catch (error) {
        if (error instanceof HttpError)
          throw new ApiError(error.code, error.message);
        throw error;
      }
    };
  }

  async sessions(current) {
    return this.store.exclusive((db) => {
      this.requireSession(db, current);
      const rows = db
        .prepare(
          "SELECT public_id, token_hash, device_name, created_at, last_seen_at, expires_at FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY last_seen_at DESC, created_at DESC",
        )
        .all(current.user.id, this.now());
      return {
        sessions: rows.map((row) => ({
          id: row.public_id,
          deviceName: row.device_name,
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at,
          expiresAt: row.expires_at,
          isCurrent: row.token_hash === current.tokenHash,
        })),
      };
    });
  }

  async revokeSession(current, sessionId) {
    if (typeof sessionId !== "string" || !/^[a-f0-9-]{36}$/.test(sessionId))
      throw new HttpError(400, "INVALID_INPUT", "请选择需要退出的设备");
    return this.store.exclusive((db) => {
      this.requireSession(db, current);
      const target = db
        .prepare(
          "SELECT token_hash FROM sessions WHERE public_id = ? AND account_id = ?",
        )
        .get(sessionId, current.user.id);
      if (!target) throw new HttpError(404, "NOT_FOUND", "设备已退出或不存在");
      db.prepare(
        "DELETE FROM sessions WHERE public_id = ? AND account_id = ?",
      ).run(sessionId, current.user.id);
      return { currentRevoked: target.token_hash === current.tokenHash };
    });
  }

  async revokeOtherSessions(current) {
    return this.store.exclusive((db) => {
      this.requireSession(db, current);
      return {
        revokedCount: db
          .prepare(
            "DELETE FROM sessions WHERE account_id = ? AND token_hash <> ?",
          )
          .run(current.user.id, current.tokenHash).changes,
      };
    });
  }

  async reauthenticate(body, req, current) {
    return this.passwordAttempt(req, current.user.phone, () =>
      this.reauthenticateAttempt(body, req, current),
    );
  }

  async reauthenticateAttempt(body, req, current) {
    const matches = await passwordMatches(
      body.password,
      current.row.password_hash,
    );
    if (!matches)
      throw new HttpError(401, "BAD_CREDENTIALS", "密码错误，请重新输入");
    return this.store.exclusive((db) => {
      const session = this.requireSession(db, current);
      const account = db
        .prepare("SELECT password_hash FROM accounts WHERE id = ?")
        .get(current.user.id);
      if (!account || account.password_hash !== current.row.password_hash)
        throw new HttpError(401, "UNAUTHENTICATED", "密码已更改，请重新登录");
      db.prepare(
        "UPDATE sessions SET reauthenticated_at = ? WHERE token_hash = ?",
      ).run(this.now(), current.tokenHash);
      return {
        reauthenticatedUntil: Math.min(
          session.expires_at,
          this.now() + this.config.reauthenticationLifetime,
        ),
      };
    });
  }

  async logout(req) {
    const token = this.readToken(req);
    if (token)
      await this.store.exclusive((db) =>
        db
          .prepare("DELETE FROM sessions WHERE token_hash = ?")
          .run(hashToken(token)),
      );
  }
}

module.exports = {
  Authentication,
  HttpError,
  normalizePhone,
  passwordHash,
  publicUser,
  clientIp,
  availableInvite,
};
