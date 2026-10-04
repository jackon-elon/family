"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createApp } = require("../app.cjs");
const { readConfig } = require("../config.cjs");
const { BirthdayCalendar } = require("../../backend/dist/birthday.js");
const ORIGIN = "http://localhost:5173";
const solar = (month, day) => ({ calendar: "solar", year: 1990, month, day });
const lunar = (month, day, leapMonth = false) => ({
  calendar: "lunar",
  year: 1990,
  month,
  day,
  leapMonth,
});

async function fixture(t, initial = "2026-06-01T12:00:00+08:00") {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "kin-guest-birthday-"),
  );
  let now = Date.parse(initial);
  const config = readConfig({ DATA_DIR: directory, FRONTEND_ORIGIN: ORIGIN });
  const app = createApp({ config, now: () => now });
  const address = await app.listen(0);
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await app.store.atomic(async (tx) => {
    await tx.put("circles", {
      id: "family",
      name: "生日之家",
      type: "family",
      mode: "shared",
      ownerId: "owner",
    });
    await tx.put("circles", {
      id: "other",
      name: "别的家庭",
      type: "family",
      mode: "shared",
    });
    await tx.put("circles", {
      id: "class",
      name: "同学",
      type: "classmate",
      mode: "shared",
    });
  });
  const request = async (route, body, cookie) => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/guest/${route}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          ...(body
            ? { Origin: ORIGIN, "Content-Type": "application/json" }
            : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.getSetCookie()[0]?.split(";")[0],
    };
  };
  return {
    app,
    config,
    request,
    now: () => now,
    setNow: (value) => {
      now = Date.parse(value);
    },
    person: (id, birthday, extra = {}) =>
      app.store.atomic((tx) =>
        tx.put("persons", {
          id,
          circleId: "family",
          name: id,
          country: "中国",
          city: "杭州",
          birthday,
          ...extra,
        }),
      ),
    enter: () => request("enter", { familyName: "生日之家" }),
  };
}

test("guest birthday snapshot includes every family member, today and day 30, excludes other families and day 31, and sorts", async (t) => {
  const f = await fixture(t);
  await f.person("last", solar(7, 1));
  await f.person("tomorrow", solar(6, 2));
  await f.person("owner-person", solar(6, 1), { claimedBy: "owner" });
  await f.person("outside-window", solar(7, 2));
  await f.person("other-person", solar(6, 1), { circleId: "other" });
  await f.person("class-person", solar(6, 1), { circleId: "class" });
  const entered = await f.enter();
  assert.equal(entered.status, 200);
  const data = entered.body.data;
  assert.equal(data.persons.length, data.family.personCount);
  assert.equal(data.family.personCount, 4);
  assert.deepEqual(
    data.birthdays.events.map((e) => [e.personId, e.daysUntil]),
    [
      ["owner-person", 0],
      ["tomorrow", 1],
      ["last", 30],
    ],
  );
  assert.ok(
    data.birthdays.events.every((e) =>
      data.persons.some((p) => p.id === e.personId),
    ),
  );
  assert.equal(data.serverTime, f.now());
  assert.equal(data.birthdays.asOf, "2026-06-01");
  assert.equal(
    data.birthdays.refreshAt,
    Date.parse("2026-06-02T00:00:00+08:00"),
  );
});

test("guest refresh crosses the China midnight and session expiry still refuses the entire snapshot", async (t) => {
  const f = await fixture(t, "2026-06-01T23:59:59+08:00");
  await f.person("yesterday", solar(6, 1));
  await f.person("today", solar(6, 2));
  const entered = await f.enter();
  assert.deepEqual(
    entered.body.data.birthdays.events.map((e) => e.daysUntil),
    [0, 1],
  );
  f.setNow("2026-06-02T00:00:01+08:00");
  const updated = await f.request("family", undefined, entered.cookie);
  assert.equal(updated.body.data.birthdays.asOf, "2026-06-02");
  assert.deepEqual(
    updated.body.data.birthdays.events.map((e) => [e.personId, e.daysUntil]),
    [["today", 0]],
  );
  f.setNow("2026-06-02T04:00:00+08:00");
  const expired = await f.request("family", undefined, entered.cookie);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.code, "GUEST_SESSION_EXPIRED");
  assert.equal(expired.body.data, undefined);
});

test("guest lunar reminders use the existing annual, leap month, short month and leap day rules", async (t) => {
  const f = await fixture(t);
  for (const [now, birthday, expected] of [
    ["2026-02-16", lunar(1, 1), "2026-02-17"],
    ["2027-02-05", lunar(1, 1), "2027-02-06"],
    ["2025-07-01", lunar(6, 1, true), "2025-07-25"],
    ["2025-06-01", lunar(6, 1), "2025-06-25"],
    ["2026-07-01", lunar(6, 1, true), "2026-07-14"],
    ["2025-03-01", lunar(2, 30), "2025-03-28"],
    ["2026-02-27", solar(2, 29), "2026-02-28"],
  ]) {
    f.setNow(`${now}T12:00:00+08:00`);
    await f.person("birthday", birthday);
    const result = await f.enter();
    assert.equal(result.status, 200);
    const event = result.body.data.birthdays.events[0];
    assert.equal(event?.date, expected, `${now} ${JSON.stringify(birthday)}`);
    assert.equal(event.birthdayCalendar, birthday.calendar);
    assert.ok(
      event.birthdayText.includes(`${birthday.month}月${birthday.day}日`),
    );
    assert.equal(
      event.birthdayText.includes("闰"),
      Boolean(birthday.leapMonth),
    );
  }
});

test("guest reminders and person cards share canonical birthday, administrator override, cleared fields and removal", async (t) => {
  const f = await fixture(t);
  const hash = crypto
    .createHash("sha256")
    .update("member")
    .digest("hex")
    .slice(0, 40);
  await f.person("member-person", solar(6, 2), {
    claimedBy: "member",
    profileOverrides: { birthday: { baseRevision: 1, value: lunar(5, 5) } },
  });
  const profile = {
    id: `user_profile_${hash}`,
    userId: "member",
    name: "最新家人",
    birthday: solar(6, 3),
    fieldRevisions: { birthday: 1 },
  };
  await f.app.store.atomic(async (tx) => {
    await tx.put("members", {
      id: `family_${hash}`,
      userId: "member",
      personId: "member-person",
      circleId: "family",
      status: "active",
      role: "member",
    });
    await tx.put("userProfiles", profile);
  });
  const entered = await f.enter();
  const check = (data) => {
    assert.deepEqual(data.persons[0].birthday, lunar(5, 5));
    assert.equal(data.birthdays.events[0].date, "2026-06-19");
    assert.equal(data.birthdays.events[0].personName, "最新家人");
  };
  check(entered.body.data);
  await f.app.store.atomic((tx) =>
    tx.put("userProfiles", {
      ...profile,
      birthday: solar(6, 4),
      fieldRevisions: { birthday: 2 },
    }),
  );
  let next = (await f.request("family", undefined, entered.cookie)).body.data;
  assert.equal(next.persons[0].birthday.day, 4);
  assert.equal(next.birthdays.events[0].date, "2026-06-04");
  await f.app.store.atomic((tx) =>
    tx.put("userProfiles", {
      ...profile,
      birthday: undefined,
      clearedFields: ["birthday"],
      fieldRevisions: { birthday: 3 },
    }),
  );
  next = (await f.request("family", undefined, entered.cookie)).body.data;
  assert.equal(next.persons[0].birthday, undefined);
  assert.deepEqual(next.birthdays.events, []);
  await f.app.store.atomic((tx) => tx.delete("persons", "member-person"));
  next = (await f.request("family", undefined, entered.cookie)).body.data;
  assert.equal(next.family.personCount, 0);
  assert.deepEqual(next.birthdays.events, []);
});

test("unsupported lunar year does not hide solar birthdays or break the family snapshot", async (t) => {
  const f = await fixture(t, "2200-06-01T12:00:00+08:00");
  await f.person("solar", solar(6, 2));
  await f.person("lunar", lunar(5, 1));
  const result = await f.enter();
  assert.equal(result.status, 200);
  assert.equal(result.body.data.persons.length, 2);
  assert.deepEqual(
    result.body.data.birthdays.events.map((e) => e.personId),
    ["solar"],
  );
  assert.match(result.body.data.birthdays.error, /部分生日/);
});

test("an impossible stored solar date is reported separately from a valid leap birthday", async (t) => {
  const f = await fixture(t, "2026-02-27T12:00:00+08:00");
  await f.person("invalid", solar(2, 31));
  await f.person("leap", solar(2, 29));
  const result = await f.enter();
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.data.birthdays.events.map((e) => [e.personId, e.date]),
    [["leap", "2026-02-28"]],
  );
  assert.match(result.body.data.birthdays.error, /部分生日/);
});

test("a single conversion failure is isolated and reported while the other reminders remain", async (t) => {
  const f = await fixture(t);
  await f.person("valid", solar(6, 2));
  await f.person("failed", lunar(5, 5));
  const original = BirthdayCalendar.prototype.next;
  t.mock.method(BirthdayCalendar.prototype, "next", function (birthday) {
    if (birthday.calendar === "lunar") throw Error("calendar read failed");
    return original.call(this, birthday);
  });
  const result = await f.enter();
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.data.birthdays.events.map((e) => e.personId),
    ["valid"],
  );
  assert.match(result.body.data.birthdays.error, /部分生日/);
});
