"use strict";

const path = require("node:path");

function readConfig(env = process.env) {
  const production = env.NODE_ENV === "production";
  if (production && (!env.DATA_DIR || !env.FRONTEND_ORIGIN))
    throw new Error("Production requires DATA_DIR and FRONTEND_ORIGIN.");
  if (production && !path.isAbsolute(env.DATA_DIR))
    throw new Error(
      "Production DATA_DIR must be an absolute persistent directory.",
    );
  const frontendOrigin = env.FRONTEND_ORIGIN || "http://localhost:5173";
  const origins = new Set([
    frontendOrigin,
    ...(env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ]);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password ||
      (production && parsed.protocol !== "https:")
    ) {
      throw new Error(
        "Allowed origins must be exact http(s) origins without paths; production requires HTTPS.",
      );
    }
  }
  if (!production && !env.FRONTEND_ORIGIN) origins.add("http://127.0.0.1:5173");
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT.");
  const proxyHopsText = env.TRUST_PROXY_HOPS || "0";
  if (!/^(0|[1-9]|1[0-6])$/.test(proxyHopsText))
    throw new Error("TRUST_PROXY_HOPS must be an integer between 0 and 16.");
  const trustProxyHops = Number(proxyHopsText);
  return {
    production,
    port,
    trustProxyHops,
    host: env.HOST || "127.0.0.1",
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, "data")),
    frontendOrigin,
    origins,
    cookieName: production ? "__Host-kin_session" : "kin_session",
    sessionLifetime: 7 * 24 * 60 * 60 * 1000,
    rememberedSessionLifetime: 90 * 24 * 60 * 60 * 1000,
    reauthenticationLifetime: 10 * 60 * 1000,
    guestCookieName: production ? "__Host-kin_guest" : "kin_guest",
    guestSessionLifetime: 4 * 60 * 60 * 1000,
    guestSessionLimit: 1000,
    guestIpLimit: 30,
    authWindow: 15 * 60 * 1000,
    authIpLimit: 50,
    authPhoneLimit: 12,
    jsonLimit: 128 * 1024,
    photoLimit: 1500 * 1024,
  };
}

module.exports = { readConfig };
