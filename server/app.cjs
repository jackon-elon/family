"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { SqliteStore } = require("./store.cjs");
const { FamilyRepository } = require("./family-repository.cjs");
const { readConfig } = require("./config.cjs");
const { Authentication, HttpError } = require("./auth.cjs");
const { ApiService, ApiError } = require("../backend/dist/service.js");
const { handlePhotoUpload } = require("./photo-upload.cjs");
const { completeMemberProfiles } = require("./onboarding.cjs");
const { Guests } = require("./guest.cjs");
const {
  WebOnboarding,
  beforeWebWork,
  afterWebWork,
  approvedMemberMatch,
  fillBlanks,
} = require("./web-onboarding.cjs");

const sensitiveActions = new Set([
  "circle.transferOwner",
  "circle.acceptOwnerTransfer",
  "circle.cancelOwnerTransfer",
  "member.setRole",
  "member.remove",
  "person.unclaim",
  "person.delete",
]);

function send(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
function okay(res, data) {
  send(res, 200, { ok: true, data });
}

async function readJson(req, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || ""))
    throw new HttpError(415, "INVALID_CONTENT_TYPE", "请求须使用 JSON");
  if (
    req.headers["content-encoding"] &&
    req.headers["content-encoding"] !== "identity"
  )
    throw new HttpError(415, "INVALID_CONTENT_TYPE", "不支持压缩请求");
  const advertised = Number(req.headers["content-length"]);
  if (Number.isFinite(advertised) && advertised > limit)
    throw new HttpError(413, "BODY_TOO_LARGE", "请求内容过大");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw new HttpError(413, "BODY_TOO_LARGE", "请求内容过大");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "请求内容不是有效 JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpError(400, "INVALID_INPUT", "请求内容格式错误");
  return body;
}

function filePath(root, fileId) {
  const match =
    /^cloud:\/\/local\/(photos\/[a-f0-9]{40}\/[a-f0-9-]{36}\.jpg)$/.exec(
      fileId || "",
    );
  if (!match) throw new HttpError(404, "NOT_FOUND", "照片不存在");
  return path.join(root, ...match[1].split("/"));
}

function photoUrl(payload, fileId) {
  const params = new URLSearchParams();
  if (payload.circleId !== undefined) params.set("circleId", payload.circleId);
  if (payload.personId !== undefined) params.set("personId", payload.personId);
  params.set(
    "v",
    crypto.createHash("sha256").update(fileId).digest("hex").slice(0, 20),
  );
  return `/api/photos?${params}`;
}

function createApp(options = {}) {
  const config = options.config || readConfig(options.env);
  const store = options.store || new SqliteStore(config.dataDir);
  const now = options.now || Date.now;
  const auth = new Authentication(store, config, now);
  const guests = new Guests(store, config, now);
  const onboarding = new WebOnboarding(store, auth, now);
  // The raw file ID never leaves this module. HTTP routes replace it with a
  // protected URL which reruns domain authorization on every image request.
  const api = new ApiService(
    new FamilyRepository(store),
    now,
    async (fileId) => fileId,
  );
  const sessionApi = (current, action, payload) => {
    let transactionDb;
    let webState;
    return new ApiService(
      new FamilyRepository(store, {
        beforeWork: (db) => {
          transactionDb = db;
          auth.guard(current, {
            action,
            payload,
            requireRecent: sensitiveActions.has(action),
          })(db);
          webState = beforeWebWork(db, current, action, payload, now());
        },
        afterWork: async (tx, result) => {
          await afterWebWork(
            transactionDb,
            tx,
            action,
            payload,
            result,
            webState,
            now(),
          );
          if (action === "account.profile.update")
            await completeMemberProfiles(tx, current.user.id, now(), {
              findExisting: (member) =>
                approvedMemberMatch(transactionDb, member, now()),
              fillBlanks,
            });
          auth.revokeIneligibleForAction(
            transactionDb,
            current,
            action,
            payload,
          );
        },
      }),
      now,
      async (fileId) => fileId,
    );
  };
  const uploadRoot = path.join(config.dataDir, "uploads");
  const storage = {
    async uploadFile({ cloudPath, fileContent }) {
      const fileID = `cloud://local/${cloudPath}`;
      const destination = filePath(uploadRoot, fileID);
      await fs.mkdir(path.dirname(destination), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(destination, fileContent, { flag: "wx", mode: 0o600 });
      return { fileID };
    },
    async deleteFile({ fileList }) {
      const results = [];
      for (const fileID of fileList) {
        await fs.rm(filePath(uploadRoot, fileID), { force: true });
        results.push({ fileID, status: 0 });
      }
      return { fileList: results };
    },
  };

  async function handler(req, res) {
    let current;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    if (config.production)
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    try {
      const origin = req.headers.origin;
      if (origin && !config.origins.has(origin))
        throw new HttpError(403, "ORIGIN_DENIED", "请求来源未获允许");
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Expose-Headers", "Retry-After");
        res.setHeader("Vary", "Origin");
      }
      if (req.method === "OPTIONS") {
        if (
          !origin ||
          !["GET", "POST"].includes(
            req.headers["access-control-request-method"],
          )
        )
          throw new HttpError(403, "ORIGIN_DENIED", "请求来源未获允许");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Max-Age", "600");
        res.writeHead(204);
        res.end();
        return;
      }
      if (!["GET", "POST"].includes(req.method))
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "不支持此请求方式");
      if (req.method === "POST" && (!origin || !config.origins.has(origin)))
        throw new HttpError(403, "ORIGIN_DENIED", "请求来源未获允许");
      const url = new URL(req.url, "http://api.local");
      const route = url.pathname;
      if (req.method === "GET" && route === "/api/health") {
        okay(res, { service: "kin-api", storage: "sqlite" });
        return;
      }
      if (req.method === "GET" && route === "/api/auth/config") {
        okay(res, {
          registration: "invite-only",
          canCreateFamily: false,
          sessionDays: 7,
          rememberDays: 90,
        });
        return;
      }
      if (route.startsWith("/api/guest/")) {
        if (req.method === "POST" && route === "/api/guest/enter") {
          const result = await guests.enter(
            req,
            await readJson(req, config.jsonLimit),
          );
          res.setHeader("Set-Cookie", guests.cookie(result.token));
          okay(res, result.data);
          return;
        }
        if (req.method === "POST" && route === "/api/guest/logout") {
          await readJson(req, config.jsonLimit);
          await guests.logout(req);
          res.setHeader("Set-Cookie", guests.cookie("", true));
          okay(res, {});
          return;
        }
        if (
          req.method === "GET" &&
          ["/api/guest/me", "/api/guest/family"].includes(route)
        ) {
          okay(res, await guests.read(req, route === "/api/guest/family"));
          return;
        }
        if (req.method === "GET" && route === "/api/guest/photos") {
          if (
            [...url.searchParams.keys()].some(
              (key) => !["personId", "v"].includes(key),
            )
          )
            throw new HttpError(400, "INVALID_INPUT", "照片请求格式错误");
          const personId = url.searchParams.get("personId");
          const fileId = await guests.photo(req, personId);
          let bytes;
          try {
            bytes = await fs.readFile(filePath(uploadRoot, fileId));
          } catch (error) {
            if (error.code === "ENOENT")
              throw new HttpError(404, "NOT_FOUND", "照片文件不存在");
            throw error;
          }
          if ((await guests.photo(req, personId)) !== fileId)
            throw new HttpError(403, "FORBIDDEN", "照片已更新或访问权限已改变");
          res.writeHead(200, {
            "Content-Type": "image/jpeg",
            "Content-Length": bytes.length,
          });
          res.end(bytes);
          return;
        }
        throw new HttpError(404, "NOT_FOUND", "接口不存在");
      }
      const admitted = await auth.current(req);
      current = admitted?.ineligible ? undefined : admitted;
      const requireCurrent = () => {
        if (!current) {
          if (admitted?.ineligible) throw auth.accessDenied();
          throw new HttpError(401, "UNAUTHENTICATED", "请先登录");
        }
      };
      if (req.method === "GET" && route === "/api/auth/me") {
        requireCurrent();
        okay(res, { user: current.user });
        return;
      }
      if (
        req.method === "POST" &&
        ["/api/onboarding/preview", "/api/onboarding/import"].includes(route)
      ) {
        requireCurrent();
        try {
          okay(
            res,
            await onboarding.run(
              current,
              await readJson(req, config.jsonLimit),
              route.endsWith("/import"),
            ),
          );
        } catch (error) {
          if (error instanceof ApiError)
            throw new HttpError(409, error.code, error.message);
          throw error;
        }
        return;
      }
      if (
        route.startsWith("/api/auth/sessions") ||
        route === "/api/auth/reauthenticate"
      ) {
        requireCurrent();
        if (req.method === "GET" && route === "/api/auth/sessions") {
          okay(res, await auth.sessions(current));
          return;
        }
        if (req.method === "POST") {
          const body = await readJson(req, config.jsonLimit);
          if (route === "/api/auth/reauthenticate") {
            okay(res, await auth.reauthenticate(body, req, current));
            return;
          }
          if (route === "/api/auth/sessions/revoke") {
            const result = await auth.revokeSession(current, body.sessionId);
            if (result.currentRevoked)
              res.setHeader("Set-Cookie", auth.cookie("", true));
            okay(res, result);
            return;
          }
          if (route === "/api/auth/sessions/revoke-others") {
            okay(res, await auth.revokeOtherSessions(current));
            return;
          }
        }
        throw new HttpError(404, "NOT_FOUND", "接口不存在");
      }
      if (
        req.method === "POST" &&
        [
          "/api/auth/register",
          "/api/auth/login",
          "/api/auth/password",
          "/api/auth/logout",
        ].includes(route)
      ) {
        const body = await readJson(req, config.jsonLimit);
        if (route === "/api/auth/logout") {
          await auth.logout(req);
          await guests.logout(req);
          res.setHeader("Set-Cookie", [
            auth.cookie("", true),
            guests.cookie("", true),
          ]);
          okay(res, {});
          return;
        }
        if (route === "/api/auth/password") requireCurrent();
        const result = route.endsWith("/register")
          ? await auth.register(body, req)
          : route.endsWith("/login")
            ? await auth.login(body, req)
            : await auth.changePassword(body, req, current);
        await guests.logout(req);
        res.setHeader("Set-Cookie", [
          auth.cookie(result.token, false, result.sessionLifetime),
          guests.cookie("", true),
        ]);
        okay(res, { user: result.user });
        return;
      }
      if (req.method === "POST" && route === "/api/rpc") {
        const body = await readJson(req, config.jsonLimit);
        if (
          Object.keys(body).some((key) => !["action", "payload"].includes(key))
        )
          throw new HttpError(400, "INVALID_INPUT", "请求含不支持的字段");
        if (typeof body.action === "string") body.action = body.action.trim();
        if (!current && body.action !== "invite.preview") requireCurrent();
        if (
          typeof body.action === "string" &&
          body.action.trim() === "circle.create"
        ) {
          send(res, 200, {
            ok: false,
            error: {
              code: "FAMILY_CREATION_DISABLED",
              message: "家人录由部署者初始化，请通过家人邀请加入",
            },
          });
          return;
        }
        const requestApi = current
          ? sessionApi(current, body.action, body.payload)
          : api;
        const result = await requestApi.invoke(body, current?.user.id);
        if (result.ok && body.action === "birthday.upcoming") {
          const serverTime = now();
          const asOf = new Date(serverTime + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
          Object.assign(result.data, { serverTime, asOf,
            refreshAt: Date.parse(`${asOf}T00:00:00+08:00`) + 86400000 });
        }
        if (!result.ok && result.error.code === "ACCOUNT_NOT_INVITED")
          await auth.invalidateIneligible(current);
        if (result.ok && body.action === "invite.preview")
          result.data.canRegister = await auth.registrationAvailable(
            body.payload?.token,
          );
        if (result.ok && body.action === "photo.url")
          result.data.url = photoUrl(body.payload || {}, result.data.url);
        if (result.ok && body.action === "photo.urls") {
          for (const [personId, fileId] of Object.entries(result.data.urls))
            result.data.urls[personId] = photoUrl(
              { circleId: body.payload.circleId, personId },
              fileId,
            );
        }
        send(res, 200, result);
        return;
      }
      if (req.method === "POST" && route === "/api/photos") {
        requireCurrent();
        const payload = await readJson(req, config.photoLimit);
        send(
          res,
          200,
          await handlePhotoUpload(
            { payload },
            current.user.id,
            sessionApi(current),
            storage,
          ),
        );
        return;
      }
      if (req.method === "GET" && route === "/api/photos") {
        requireCurrent();
        if (
          [...url.searchParams.keys()].some(
            (key) => !["circleId", "personId", "v"].includes(key),
          )
        )
          throw new HttpError(400, "INVALID_INPUT", "照片请求格式错误");
        const payload = {};
        for (const key of ["circleId", "personId"])
          if (url.searchParams.has(key))
            payload[key] = url.searchParams.get(key);
        const photosApi = sessionApi(current);
        const allowed = await photosApi.invoke(
          { action: "photo.url", payload },
          current.user.id,
        );
        if (!allowed.ok) {
          if (allowed.error.code === "ACCOUNT_NOT_INVITED")
            await auth.invalidateIneligible(current);
          send(res, 403, allowed);
          return;
        }
        let bytes;
        try {
          bytes = await fs.readFile(filePath(uploadRoot, allowed.data.url));
        } catch (error) {
          if (error.code === "ENOENT")
            throw new HttpError(404, "NOT_FOUND", "照片文件不存在");
          throw error;
        }
        const rechecked = await photosApi.invoke(
          { action: "photo.url", payload },
          current.user.id,
        );
        if (!rechecked.ok && rechecked.error.code === "ACCOUNT_NOT_INVITED")
          await auth.invalidateIneligible(current);
        if (!rechecked.ok || rechecked.data.url !== allowed.data.url)
          throw new HttpError(403, "FORBIDDEN", "照片已更新或访问权限已改变");
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": bytes.length,
        });
        res.end(bytes);
        return;
      }
      throw new HttpError(404, "NOT_FOUND", "接口不存在");
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        if (error.code === "ACCOUNT_NOT_INVITED") {
          await auth.invalidateIneligible(current);
          res.setHeader("Set-Cookie", auth.cookie("", true));
        }
        const retryAfterSeconds =
          error.status === 429 ? (error.retryAfterSeconds ?? 900) : undefined;
        if (retryAfterSeconds)
          res.setHeader("Retry-After", String(retryAfterSeconds));
        send(res, error.status, {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
          },
        });
      } else {
        // Deliberately avoid logging request bodies, session cookies or phone numbers.
        console.error(
          "API request failed:",
          error.code || error.name || "Error",
        );
        send(res, 500, {
          ok: false,
          error: {
            code: "SERVER_ERROR",
            message: "服务暂时不可用，请稍后重试",
          },
        });
      }
    }
  }

  const server = http.createServer(
    { requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 16384 },
    handler,
  );
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 1000;
  let closing;
  return {
    config,
    store,
    api,
    auth,
    guests,
    server,
    handler,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      if (!closing)
        closing = (async () => {
          if (server.listening)
            await new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
          await store.close();
        })();
      return closing;
    },
  };
}

module.exports = { createApp };
