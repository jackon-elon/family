"use strict";

const crypto = require("node:crypto");
const { reserveAttempts, refundAttempts } = require("./rate-limit.cjs");
const { HttpError, clientIp } = require("./auth.cjs");
const { FamilyRepository } = require("./family-repository.cjs");
const { BirthdayCalendar } = require("../backend/dist/birthday.js");

const DAY = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;

function familyBirthdays(persons, family, now) {
  const asOf = new Date(now + BEIJING_OFFSET).toISOString().slice(0, 10);
  const refreshAt = Date.parse(`${asOf}T00:00:00+08:00`) + DAY;
  const candidates = persons.filter((person) => person.birthday);
  const solar = new BirthdayCalendar(now, 30, false);
  let lunar,
    incomplete = false;
  if (candidates.some((person) => person.birthday.calendar === "lunar")) {
    try {
      lunar = new BirthdayCalendar(now, 30, true);
    } catch {
      incomplete = true;
    }
  }
  const events = candidates
    .flatMap((person) => {
      try {
        const birthday = person.birthday;
        if (
          !["solar", "lunar"].includes(birthday.calendar) ||
          !Number.isInteger(birthday.month) ||
          birthday.month < 1 ||
          birthday.month > 12 ||
          !Number.isInteger(birthday.day) ||
          birthday.day < 1 ||
          birthday.day >
            (birthday.calendar === "lunar"
              ? 30
              : new Date(Date.UTC(2000, birthday.month, 0)).getUTCDate())
        )
          throw new Error("INVALID_BIRTHDAY");
        const calendar = birthday.calendar === "lunar" ? lunar : solar;
        if (!calendar) return [];
        const occurrence = calendar.next(birthday);
        return occurrence
          ? [
              {
                personId: person.id,
                personName: person.name,
                circleId: family.id,
                circleName: family.name,
                ...occurrence,
                birthdayCalendar: birthday.calendar,
              },
            ]
          : [];
      } catch {
        incomplete = true;
        return [];
      }
    })
    .sort(
      (a, b) =>
        a.daysUntil - b.daysUntil ||
        a.personName.localeCompare(b.personName, "zh-CN") ||
        a.personId.localeCompare(b.personId),
    );
  return {
    events,
    asOf,
    refreshAt,
    ...(incomplete ? { error: "部分生日暂时无法换算，请稍后刷新。" } : {}),
  };
}

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
// These are the profile fields normally visible within a family. Identity,
// authority, applications, audit records and another user's private remarks
// are deliberately absent, even when a source document gains new properties.
const profileFields = [
  "name",
  "nickname",
  "gender",
  "birthday",
  "country",
  "province",
  "city",
  "latitude",
  "longitude",
  "status",
  "school",
  "industry",
  "occupation",
  "bio",
  "phone",
  "wechatId",
  "photoFileId",
];

function parseCookie(req, cookieName) {
  const values = String(req.headers.cookie || "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${cookieName}=`));
  if (values.length !== 1) return undefined;
  const token = values[0].slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

async function familyPerson(tx, person) {
  const view = { ...person };
  if (!person.claimedBy) return view;
  const userHash = hash(person.claimedBy).slice(0, 40);
  const member = await tx.get("members", `${person.circleId}_${userHash}`);
  if (
    member?.status !== "active" ||
    member.circleId !== person.circleId ||
    member.personId !== person.id ||
    member.userId !== person.claimedBy
  )
    return view;
  const profile = await tx.get("userProfiles", `user_profile_${userHash}`);
  if (profile?.userId !== person.claimedBy) return view;
  for (const field of profileFields) {
    if (
      !profile.cardFallback ||
      profile[field] !== undefined ||
      profile.clearedFields?.includes(field)
    )
      view[field] = profile[field];
    const correction = person.profileOverrides?.[field];
    if (
      correction &&
      correction.baseRevision === (profile.fieldRevisions?.[field] ?? 0)
    )
      view[field] = correction.value === null ? undefined : correction.value;
  }
  return view;
}

function personView(person) {
  const result = {
    id: person.id,
    circleId: person.circleId,
    isSelf: false,
    hasPhoto: Boolean(person.photoFileId),
    hasMapLocation: Boolean(
      person.city &&
      Number.isFinite(person.latitude) &&
      Number.isFinite(person.longitude),
    ),
    profileComplete: Boolean(
      person.name?.trim() &&
      person.country?.trim() &&
      person.city?.trim() &&
      person.birthday,
    ),
  };
  for (const field of [...profileFields, "birthOrder"])
    if (field !== "photoFileId" && person[field] !== undefined)
      result[field] = person[field];
  if (person.photoFileId) {
    const params = new URLSearchParams({
      personId: person.id,
      v: hash(person.photoFileId).slice(0, 20),
    });
    result.photoUrl = `/api/guest/photos?${params}`;
  }
  return result;
}

class Guests {
  constructor(store, config, now = Date.now) {
    this.store = store;
    this.config = config;
    this.now = now;
  }

  cookie(token, clear = false) {
    return `${this.config.guestCookieName}=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : Math.floor(this.config.guestSessionLifetime / 1000)}${this.config.production ? "; Secure" : ""}`;
  }

  token(req) {
    return parseCookie(req, this.config.guestCookieName);
  }

  limit(req, db) {
    const key = `guest:ip:${hash(clientIp(req, this.config.trustProxyHops))}`;
    const { retryAfter, reservations } = reserveAttempts(
      db,
      [[key, this.config.guestIpLimit]],
      this.now(),
      this.config.authWindow,
    );
    if (retryAfter)
      throw new HttpError(
        429,
        "GUEST_RATE_LIMITED",
        `查询次数较多，请约 ${retryAfter < 60 ? `${retryAfter} 秒` : `${Math.ceil(retryAfter / 60)} 分钟`}后再试`,
        retryAfter,
      );
    return () => refundAttempts(db, reservations);
  }

  grant(db, token) {
    const session =
      token &&
      db
        .prepare(
          "SELECT circle_id, expires_at FROM guest_sessions WHERE token_hash = ? AND expires_at > ?",
        )
        .get(hash(token), this.now());
    if (!session)
      throw new HttpError(
        401,
        "GUEST_SESSION_EXPIRED",
        "游客浏览已结束，请重新输入家庭名称",
      );
    const row = db
      .prepare(
        "SELECT body FROM documents WHERE collection = 'circles' AND id = ?",
      )
      .get(session.circle_id);
    const circle = row && JSON.parse(row.body);
    if (circle?.type !== "family" || circle.mode !== "shared")
      throw new HttpError(
        401,
        "GUEST_SESSION_EXPIRED",
        "这个家庭已停止游客浏览",
      );
    return { circle, expiresAt: session.expires_at };
  }

  async enter(req, body) {
    if (
      typeof body.familyName !== "string" ||
      !body.familyName.trim() ||
      body.familyName.trim().length > 60
    )
      throw new HttpError(400, "INVALID_INPUT", "请输入完整的家庭名称");
    const token = crypto.randomBytes(32).toString("base64url");
    const prior = this.token(req);
    const entryError = await this.store.exclusive((db) => {
      const refund = this.limit(req, db);
      const rows = db
        .prepare(
          "SELECT id FROM documents WHERE collection = 'circles' AND json_extract(body, '$.type') = 'family' AND json_extract(body, '$.mode') = 'shared' AND json_extract(body, '$.name') = ? LIMIT 2",
        )
        .all(body.familyName.trim());
      if (!rows.length)
        return new HttpError(
          404,
          "FAMILY_NOT_FOUND",
          "没有找到这个家庭，请核对完整名称",
        );
      if (rows.length > 1)
        return new HttpError(
          409,
          "FAMILY_NAME_AMBIGUOUS",
          "家庭名称重复，暂时无法进入，请联系网站维护者处理",
        );
      refund();
      const now = this.now();
      db.prepare("DELETE FROM guest_sessions WHERE expires_at <= ?").run(now);
      if (prior)
        db.prepare("DELETE FROM guest_sessions WHERE token_hash = ?").run(
          hash(prior),
        );
      if (
        db.prepare("SELECT COUNT(*) AS total FROM guest_sessions").get()
          .total >= this.config.guestSessionLimit
      )
        throw new HttpError(
          429,
          "GUEST_BUSY",
          "当前浏览人数较多，请稍后再试",
          30,
        );
      db.prepare("INSERT INTO guest_sessions VALUES(?, ?, ?, ?)").run(
        hash(token),
        rows[0].id,
        now + this.config.guestSessionLifetime,
        now,
      );
    });
    if (entryError) throw entryError;
    return { token, data: await this.readToken(token, true) };
  }

  async readToken(token, full) {
    let grant;
    const repository = new FamilyRepository(this.store, {
      beforeWork: (db) => {
        grant = this.grant(db, token);
      },
    });
    return repository.atomic(async (tx) => {
      const rows = await tx.find("persons", { circleId: grant.circle.id });
      const family = {
        id: grant.circle.id,
        name: grant.circle.name,
        type: "family",
        personCount: rows.length,
      };
      if (!full) return { family, expiresAt: grant.expiresAt };
      const persons = await Promise.all(
        rows.map(async (person) => personView(await familyPerson(tx, person))),
      );
      const ids = new Set(persons.map((person) => person.id));
      const relations = (
        await tx.find("relations", { circleId: grant.circle.id })
      )
        .filter((relation) => ids.has(relation.from) && ids.has(relation.to))
        .map(({ id, from, to, type, olderId }) => ({
          id,
          from,
          to,
          type,
          ...(olderId ? { olderId } : {}),
        }));
      const serverTime = this.now();
      return {
        family,
        persons,
        relations,
        birthdays: familyBirthdays(persons, family, serverTime),
        serverTime,
        expiresAt: grant.expiresAt,
      };
    });
  }

  read(req, full) {
    return this.readToken(this.token(req), full);
  }

  async photo(req, personId) {
    if (typeof personId !== "string" || !personId || personId.length > 120)
      throw new HttpError(400, "INVALID_INPUT", "照片请求格式错误");
    let grant;
    const repository = new FamilyRepository(this.store, {
      beforeWork: (db) => {
        grant = this.grant(db, this.token(req));
      },
    });
    return repository.atomic(async (tx) => {
      const stored = await tx.get("persons", personId);
      if (!stored || stored.circleId !== grant.circle.id)
        throw new HttpError(404, "NOT_FOUND", "照片不存在");
      const person = await familyPerson(tx, stored);
      if (!person.photoFileId)
        throw new HttpError(404, "NOT_FOUND", "照片不存在");
      return person.photoFileId;
    });
  }

  async logout(req) {
    const token = this.token(req);
    if (token)
      await this.store.exclusive((db) =>
        db
          .prepare("DELETE FROM guest_sessions WHERE token_hash = ?")
          .run(hash(token)),
      );
  }
}

module.exports = { Guests };
