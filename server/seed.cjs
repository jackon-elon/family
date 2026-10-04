"use strict";

const crypto = require("node:crypto");
const { readConfig } = require("./config.cjs");
const { SqliteStore } = require("./store.cjs");
const { FamilyRepository } = require("./family-repository.cjs");
const { passwordHash } = require("./auth.cjs");
const { ApiService } = require("../backend/dist/service.js");

const DEMO_PASSWORD = "LocalDemo2026!";

async function seed(env = process.env) {
  if (env.NODE_ENV === "production")
    throw new Error("演示数据禁止写入生产环境。");
  const config = readConfig(env);
  const store = new SqliteStore(config.dataDir);
  try {
    const previous = await store.exclusive((db) =>
      db.prepare("SELECT value FROM metadata WHERE key = 'demo_seed'").get(),
    );
    if (previous) {
      const { classmateId: _archivedClassmateId, ...familySeed } = JSON.parse(
        previous.value,
      );
      return familySeed;
    }
    const saved = await passwordHash(DEMO_PASSWORD);
    const owner = `web_${crypto.randomUUID()}`;
    const member = `web_${crypto.randomUUID()}`;
    await store.exclusive((db) => {
      if (
        db.prepare("SELECT COUNT(*) AS total FROM accounts").get().total ||
        db.prepare("SELECT COUNT(*) AS total FROM documents").get().total
      )
        throw new Error(
          "只可向空数据库加入演示数据；当前资料已保留。请使用单独的 DATA_DIR。",
        );
      for (const [id, phone] of [
        [owner, "+8613800000000"],
        [member, "+8613800000001"],
      ])
        db.prepare("INSERT INTO accounts VALUES(?, ?, ?, ?)").run(
          id,
          phone,
          saved,
          Date.now(),
        );
    });
    const api = new ApiService(new FamilyRepository(store));
    const call = async (actor, action, payload = {}) => {
      const response = await api.invoke({ action, payload }, actor);
      if (!response.ok)
        throw new Error(
          `${action}: ${response.error.code} ${response.error.message}`,
        );
      return response.data;
    };
    const hangzhou = {
      country: "中国",
      province: "浙江省",
      city: "杭州市",
      latitude: 30.3,
      longitude: 120.2,
    };
    const shanghai = {
      country: "中国",
      province: "上海市",
      city: "上海市",
      latitude: 31.2,
      longitude: 121.5,
    };
    const lunar = { calendar: "lunar", month: 8, day: 15, year: 1969 };
    const ownerProfile = {
      name: "李航",
      gender: "male",
      ...hangzhou,
      birthday: { calendar: "solar", month: 11, day: 16, year: 1998 },
      industry: "互联网",
      occupation: "产品设计师",
      bio: "本地演示人物，资料为虚构。",
    };
    await call(owner, "account.profile.update", { patch: ownerProfile });
    await call(member, "account.profile.update", {
      patch: {
        name: "李建国",
        gender: "male",
        ...hangzhou,
        birthday: lunar,
        occupation: "工程师",
        bio: "本地演示人物，资料为虚构。",
      },
    });
    const family = (
      await call(owner, "circle.create", {
        type: "family",
        name: "李家亲友录",
        mode: "shared",
      })
    ).circle;
    const me = (
      await call(owner, "person.create", {
        circleId: family.id,
        ...ownerProfile,
        claimSelf: true,
      })
    ).person;
    const invite = (await call(owner, "invite.create", { circleId: family.id }))
      .invite;
    const application = (
      await call(member, "invite.apply", {
        token: invite.token,
        note: "李航的爸爸（本地虚构示例）",
      })
    ).application;
    await call(owner, "join.approve", {
      circleId: family.id,
      applicationId: application.id,
      initialRelation: { anchorPersonId: me.id, kind: "newParent" },
    });
    const dad = (
      await call(owner, "person.list", { circleId: family.id })
    ).persons.find((person) => person.name === "李建国");
    const add = async (name, gender, birthday, location, initialRelation) =>
      (
        await call(owner, "person.create", {
          circleId: family.id,
          name,
          gender,
          birthday,
          ...location,
          initialRelation,
        })
      ).person;
    const mom = await add(
      "王芳",
      "female",
      { calendar: "solar", month: 10, day: 12, year: 1971 },
      hangzhou,
      { anchorPersonId: me.id, kind: "newParent" },
    );
    await call(owner, "relation.create", {
      circleId: family.id,
      from: dad.id,
      to: mom.id,
      type: "spouse",
    });
    const uncle = await add(
      "李建华",
      "male",
      { calendar: "solar", month: 5, day: 19, year: 1966 },
      shanghai,
      { anchorPersonId: dad.id, kind: "sibling" },
    );
    await add(
      "李晨",
      "male",
      { calendar: "solar", month: 6, day: 18, year: 1995 },
      {
        country: "中国",
        province: "四川省",
        city: "成都市",
        latitude: 30.7,
        longitude: 104.1,
      },
      { anchorPersonId: uncle.id, kind: "newChild" },
    );
    await add(
      "张秀英",
      "female",
      { calendar: "lunar", month: 9, day: 9, year: 1946 },
      hangzhou,
      { anchorPersonId: dad.id, kind: "newParent" },
    );
    const sister = await add(
      "李悦",
      "female",
      { calendar: "solar", month: 10, day: 7, year: 2000 },
      {
        country: "英国",
        province: "英格兰",
        city: "伦敦",
        latitude: 51.5,
        longitude: -0.1,
      },
      { anchorPersonId: me.id, kind: "sibling" },
    );
    // Siblings may share only one parent. Record both parents explicitly in this
    // fictional family so either parent's own view can identify their daughter.
    for (const parent of [dad, mom])
      await call(owner, "relation.create", {
        circleId: family.id,
        from: parent.id,
        to: sister.id,
        type: "parent",
      });
    const result = {
      familyId: family.id,
      ownerPhone: "13800000000",
      memberPhone: "13800000001",
      seededAt: Date.now(),
    };
    await store.exclusive((db) =>
      db
        .prepare("INSERT INTO metadata VALUES(?, ?)")
        .run("demo_seed", JSON.stringify(result)),
    );
    return result;
  } finally {
    await store.close();
  }
}

if (require.main === module)
  seed()
    .then((result) => {
      console.log("本地虚构演示数据已就绪：家人 7 人。");
      console.log(
        `管理员：${result.ownerPhone}；普通成员：${result.memberPhone}；密码：${DEMO_PASSWORD}`,
      );
      console.log("演示账号手机号均未验证，不会按手机号自动关联已有资料。");
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });

module.exports = { seed };
