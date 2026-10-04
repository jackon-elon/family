// Reusable fictional fixture. Never seeds the normal server/data directory.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { setupFamily } = require("../server/setup.cjs");
const { passwordHash } = require("../server/auth.cjs");
const PASSWORD = "ScaleTest2026!";
async function seedScale(app, env, now = Date.now()) {
  if (
    env.NODE_ENV === "production" ||
    !env.DATA_DIR ||
    path.resolve(env.DATA_DIR) === path.resolve(__dirname, "../server/data")
  )
    throw new Error(
      "Stress fixtures require a separate non-production DATA_DIR.",
    );
  const init = await setupFamily({
    env,
    phone: "13900000000",
    password: PASSWORD,
    familyName: "四代百人验收家庭",
  });
  const call = async (action, payload) => {
    const result = await app.api.invoke({ action, payload }, init.accountId);
    if (!result.ok)
      throw new Error(`${action}: ${JSON.stringify(result.error)}`);
    return result.data;
  };
  const source = fs.readFileSync(
    path.join(__dirname, "../frontend/src/shared/city-catalog.ts"),
    "utf8",
  );
  const catalog = JSON.parse(
    source
      .slice(
        source.indexOf("= [", source.indexOf("export const CITY_CATALOG")) + 2,
      )
      .trim()
      .replace(/;$/, "")
      .replace(/,\s*]/g, "]"),
  );
  const provinces = new Set(),
    countries = new Set();
  const cities = catalog
    .filter(
      (row) =>
        row[0] === "中国" && !provinces.has(row[1]) && provinces.add(row[1]),
    )
    .slice(0, 30);
  cities.push(
    ...catalog
      .filter(
        (row) =>
          row[0] !== "中国" && !countries.has(row[0]) && countries.add(row[0]),
      )
      .slice(0, 9),
  );
  cities.push(["测试国", "测试州", "未收录小城", undefined, undefined]);
  const plans = [],
    edges = [];
  const add = (generation, gender) => {
    const index = plans.length;
    plans.push({ generation, gender });
    return index;
  };
  const parent = (from, to) => edges.push({ from, to, type: "parent" });
  const spouse = (from, to) => edges.push({ from, to, type: "spouse" });
  add(0, "male");
  add(0, "female");
  spouse(0, 1);
  const middle = [];
  for (let i = 0; i < 6; i++) {
    const a = add(1, i % 2 ? "female" : "male"),
      b = add(1, i % 2 ? "male" : "female");
    spouse(a, b);
    parent(0, a);
    parent(1, a);
    middle.push([a, b]);
  }
  const younger = [];
  for (let i = 0; i < 18; i++) {
    const a = add(2, i % 2 ? "female" : "male"),
      b = add(2, i % 2 ? "male" : "female");
    spouse(a, b);
    const pair = middle[Math.floor(i / 3)];
    parent(pair[0], a);
    parent(pair[1], a);
    younger.push([a, b]);
  }
  for (let i = 0; i < 40; i++) {
    const child = add(3, i % 2 ? "female" : "male"),
      pair = younger[i % 18];
    parent(pair[0], child);
    parent(pair[1], child);
  }
  for (let i = 0; i < 10; i++) add(null, i % 2 ? "female" : "male");
  const beijing = new Date(now + 8 * 3600000);
  const persons = [];
  for (let i = 0; i < 100; i++) {
    const plan = plans[i],
      city = cities[i % 40];
    const nextBirthday = new Date(beijing.getTime() + (i % 12) * 86400000);
    const birthday = {
      calendar: i % 7 === 0 ? "lunar" : "solar",
      month: i % 7 === 0 ? 9 : nextBirthday.getUTCMonth() + 1,
      day: i % 7 === 0 ? 9 : nextBirthday.getUTCDate(),
      year: [1942, 1964, 1986, 2010][plan.generation ?? 2],
    };
    if (birthday.month === 2 && birthday.day === 29) birthday.day = 28;
    if (i % 11 === 0) delete birthday.year;
    const profile = {
      name:
        i === 90 || i === 91
          ? "李同名"
          : `${["长辈", "父辈", "家人", "晚辈"][plan.generation ?? 2]}${String(i + 1).padStart(3, "0")}`,
      gender: plan.gender,
      country: city[0],
      province: city[1],
      city: city[2],
      latitude: city[3],
      longitude: city[4],
      birthday,
      phone: `1390000${String(i).padStart(4, "0")}`,
      occupation: i % 3 ? "" : "退休",
      bio: "虚构压力验收资料",
    };
    if (i === 14) await call("account.profile.update", { patch: profile });
    const person = (
      await call("person.create", {
        circleId: init.familyId,
        ...profile,
        deferRelation: true,
        ...(i === 14 ? { claimSelf: true } : {}),
      })
    ).person;
    persons.push(person);
  }
  for (const edge of edges)
    await call("relation.create", {
      circleId: init.familyId,
      ...edge,
      from: persons[edge.from].id,
      to: persons[edge.to].id,
    });
  const memberId = "scale_member";
  const saved = await passwordHash(PASSWORD);
  await app.store.exclusive((db) =>
    db
      .prepare("INSERT INTO accounts VALUES(?,?,?,?)")
      .run(memberId, "+8613900000001", saved, now),
  );
  await app.store.atomic(async (tx) => {
    const person = await tx.get("persons", persons[15].id);
    person.claimedBy = memberId;
    await tx.put("persons", person);
    await tx.put("members", {
      id: `${init.familyId}_${crypto.createHash("sha256").update(memberId).digest("hex").slice(0, 40)}`,
      circleId: init.familyId,
      userId: memberId,
      personId: person.id,
      role: "member",
      status: "active",
      joinedAt: now,
    });
    // Legacy incomplete record: still counted and reachable, never hidden from lists.
    const incomplete = await tx.get("persons", persons[99].id);
    delete incomplete.city;
    delete incomplete.latitude;
    delete incomplete.longitude;
    await tx.put("persons", incomplete);
  });
  const profileFields = ["name", "gender", "country", "province", "city", "latitude", "longitude", "birthday", "phone", "occupation", "bio"];
  const memberProfile = await app.api.invoke({action: "account.profile.update", payload: {patch: Object.fromEntries(profileFields.filter(key => persons[15][key] !== undefined).map(key => [key, persons[15][key]]))}}, memberId);
  if (!memberProfile.ok) throw new Error(`Member fixture profile: ${JSON.stringify(memberProfile.error)}`);
  return {
    ...init,
    persons,
    plans,
    ownerPhone: "13900000000",
    memberPhone: "13900000001",
    password: PASSWORD,
  };
}
module.exports = { seedScale };

