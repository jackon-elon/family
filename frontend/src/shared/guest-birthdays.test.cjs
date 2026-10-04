const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const subject = { exports: {} };
new Function(
  "module",
  "exports",
  ts.transpileModule(
    fs.readFileSync(path.join(__dirname, "guest-birthdays.ts"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
)(subject, subject.exports);
const {
  birthdayRefreshDelay,
  birthdayCountdown,
  occurrenceDate,
  guestSessionDelay,
  birthdayDateDescription,
} = subject.exports;

test("guest expiry uses remaining server lifetime despite a fast or slow device, with legacy fallback", () => {
  const serverTime = Date.parse("2026-10-04T12:00:00+08:00");
  const lifetime = 4 * 60 * 60 * 1000;
  for (const offset of [-86400000, 86400000]) {
    const receivedAt = serverTime + offset;
    const snapshot = {
      serverTime,
      receivedAt,
      expiresAt: serverTime + lifetime,
    };
    assert.equal(guestSessionDelay(snapshot, receivedAt), lifetime);
    assert.equal(
      guestSessionDelay(snapshot, receivedAt + 60000),
      lifetime - 60000,
    );
    assert.equal(guestSessionDelay(snapshot, receivedAt + lifetime), 0);
  }
  assert.equal(
    guestSessionDelay({ expiresAt: serverTime + lifetime }, serverTime),
    lifetime,
  );
});

test("birthday midnight refresh follows the server China day instead of the device clock or timezone", () => {
  const serverTime = Date.parse("2026-10-04T23:59:00+08:00");
  const refreshAt = Date.parse("2026-10-05T00:00:00+08:00");
  const receivedAt = Date.parse("2025-01-01T12:00:00Z");
  const snapshot = { birthdays: { refreshAt }, serverTime, receivedAt };
  assert.equal(birthdayRefreshDelay(snapshot, receivedAt), 60000);
  assert.equal(birthdayRefreshDelay(snapshot, receivedAt + 59000), 1000);
  assert.equal(birthdayRefreshDelay(snapshot, receivedAt + 60000), 0);
  assert.equal(birthdayRefreshDelay(snapshot, receivedAt + 120000), 0);
  assert.equal(birthdayRefreshDelay(snapshot, receivedAt - 1000), 60000);
});

test("old or incomplete guest responses have no midnight timer and cannot create a refresh loop", () => {
  for (const old of [
    {},
    { serverTime: 1 },
    { birthdays: {} },
    { birthdays: { refreshAt: 100 }, serverTime: NaN, receivedAt: 1 },
  ])
    assert.equal(birthdayRefreshDelay(old), null);
});

test("birthday display distinguishes today and tomorrow, and keeps the occurrence year across New Year", () => {
  assert.equal(birthdayCountdown(0), "今天生日");
  assert.equal(birthdayCountdown(1), "明天生日");
  assert.equal(birthdayCountdown(30), "30 天后");
  assert.equal(occurrenceDate("2027-01-02"), "2027年1月2日");
  assert.equal(
    birthdayDateDescription({
      date: "2026-02-28",
      birthdayCalendar: "solar",
      birthdayText: "阳历2月29日",
    }),
    "阳历2月29日 · 本次公历：2026年2月28日",
  );
  assert.equal(
    birthdayDateDescription({
      date: "2027-01-02",
      birthdayCalendar: "solar",
      birthdayText: "阳历1月2日",
    }),
    "阳历 · 2027年1月2日",
  );
});
