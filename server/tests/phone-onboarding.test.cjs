"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createApp } = require("../app.cjs");
const { readConfig } = require("../config.cjs");
const { setupFamily } = require("../setup.cjs");

const ORIGIN = "http://localhost:5173",
  PASSWORD = "OnboardingPassword2026!";
const PHONE = "13800000022";
const PROFILE = {
  name: "小晴",
  gender: "female",
  country: "中国",
  province: "浙江省",
  city: "杭州市",
  latitude: 30.3,
  longitude: 120.2,
  birthday: { calendar: "solar", year: 1997, month: 6, day: 8 },
};
const memberId = (family, id) =>
  `${family}_${crypto.createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kin-phone-"));
  const env = { DATA_DIR: directory, FRONTEND_ORIGIN: ORIGIN };
  const setup = await setupFamily({
    env,
    phone: "13800000011",
    password: PASSWORD,
    familyName: "手机号测试家庭",
  });
  const app = createApp({
    config: { ...readConfig(env), authIpLimit: 500, authPhoneLimit: 100 },
  });
  const address = await app.listen(0),
    url = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const request = async (route, body, cookie) => {
    const response = await fetch(url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined
          ? {}
          : { Origin: ORIGIN, "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      json: response.headers.get("content-type")?.includes("json")
        ? JSON.parse(bytes)
        : undefined,
      bytes,
      cookie: response.headers.getSetCookie()[0]?.split(";")[0],
    };
  };
  const owner = await request("/api/auth/login", {
    phone: "13800000011",
    password: PASSWORD,
  });
  const rpc = (cookie, action, payload = {}) =>
    request("/api/rpc", { action, payload }, cookie);
  const ok = async (cookie, action, payload = {}) => {
    const result = await rpc(cookie, action, payload);
    assert.equal(result.json.ok, true, JSON.stringify(result.json));
    return result.json.data;
  };
  const circleId = setup.familyId;
  const add = async (phone = PHONE, extra = {}) =>
    (
      await ok(owner.cookie, "person.create", {
        circleId,
        ...PROFILE,
        phone,
        deferRelation: true,
        ...extra,
      })
    ).person;
  const invite = async () =>
    (await ok(owner.cookie, "invite.create", { circleId })).invite;
  const register = async (invitation, phone = PHONE) => {
    const result = await request("/api/auth/register", {
      phone,
      password: PASSWORD,
      inviteToken: invitation.token,
    });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    return result;
  };
  const preview = async (user, invitation) => {
    const result = await request(
      "/api/onboarding/preview",
      { inviteToken: invitation.token },
      user.cookie,
    );
    assert.equal(result.status, 200, JSON.stringify(result.json));
    return result.json.data;
  };
  const confirm = async (user, invitation, info) => {
    info ??= await preview(user, invitation);
    const result = await request(
      "/api/onboarding/import",
      {
        inviteToken: invitation.token,
        personId: info.match.person.id,
        personUpdatedAt: info.match.person.updatedAt,
        profileVersion: info.profileVersion,
      },
      user.cookie,
    );
    assert.equal(result.status, 200, JSON.stringify(result.json));
    return result.json.data;
  };
  const apply = async (user, invitation) =>
    (await ok(user.cookie, "invite.apply", { token: invitation.token }))
      .application;
  const approve = async (application, target) =>
    ok(owner.cookie, "join.approve", {
      circleId,
      applicationId: application.id,
      ...(target
        ? { targetPersonId: target.id, targetPersonUpdatedAt: target.updatedAt }
        : { deferRelation: true }),
    });
  return {
    app,
    setup,
    circleId,
    owner,
    request,
    rpc,
    ok,
    add,
    invite,
    register,
    preview,
    confirm,
    apply,
    approve,
  };
}

test("admin requires normalized login phone at create, prevents duplicates, preserves exact retries", async (t) => {
  const f = await fixture(t);
  const payload = { circleId: f.circleId, ...PROFILE, deferRelation: true };
  for (const phone of [undefined, "", "01012345678", "1381"]) {
    assert.equal(
      (await f.rpc(f.owner.cookie, "person.create", { ...payload, phone })).json
        .error.code,
      "PHONE_REQUIRED",
    );
  }
  const requestId = "phone_create_retry_2026",
    first = await f.add("138 0000 0022", { requestId });
  assert.equal(first.phone, "+8613800000022");
  assert.equal((await f.add("+86 13800000022", { requestId })).id, first.id);
  assert.equal(
    (await f.rpc(f.owner.cookie, "person.create", { ...payload, phone: PHONE }))
      .json.error.code,
    "PHONE_ALREADY_USED",
  );
  assert.equal(
    (
      await f.rpc(f.owner.cookie, "person.create", {
        ...payload,
        phone: PHONE,
        requestId,
        name: "不同内容",
      })
    ).json.error.code,
    "IDEMPOTENCY_CONFLICT",
  );
  const other = await f.add("13800000033");
  assert.equal(
    (
      await f.rpc(f.owner.cookie, "person.update", {
        circleId: f.circleId,
        personId: other.id,
        patch: { phone: PHONE },
      })
    ).json.error.code,
    "PHONE_ALREADY_USED",
  );
  assert.equal(
    (
      await f.rpc(f.owner.cookie, "person.update", {
        circleId: f.circleId,
        personId: other.id,
        patch: { phone: null },
      })
    ).json.error.code,
    "PHONE_REQUIRED",
  );
});

test("same login phone confirms existing profile, approval keeps person, relationship and photo, self edits work", async (t) => {
  const f = await fixture(t);
  const parent = await f.add("13800000033", { name: "妈妈" });
  const target = await f.add(PHONE, {
    deferRelation: undefined,
    initialRelation: { anchorPersonId: parent.id, kind: "newChild" },
  });
  const bytes = await fs.readFile(
    path.resolve(__dirname, "../../backend/tests/fixtures/tiny.jpg"),
  );
  const uploaded = await f.request(
    "/api/photos",
    {
      circleId: f.circleId,
      personId: target.id,
      base64: bytes.toString("base64"),
    },
    f.owner.cookie,
  );
  assert.equal(uploaded.json.ok, true, JSON.stringify(uploaded.json));
  await f.ok(f.owner.cookie, "person.update", {
    circleId: f.circleId,
    personId: target.id,
    patch: { industry: "教育", wechatId: "family-contact" },
  });
  const invitation = await f.invite(),
    user = await f.register(invitation);
  assert.equal(user.json.data.user.phoneVerified, false);
  const info = await f.preview(user, invitation);
  assert.equal(info.match.status, "unique");
  assert.equal(info.match.person.id, target.id);
  assert.equal(info.match.person.profile.hasPhoto, true);
  assert.equal(
    (await f.rpc(user.cookie, "invite.apply", { token: invitation.token })).json
      .error.code,
    "PROFILE_CONFIRMATION_REQUIRED",
  );
  const imported = await f.confirm(user, invitation, info);
  assert.equal(imported.profile.name, PROFILE.name);
  assert.equal(imported.profile.industry, "教育");
  assert.equal(imported.profile.hasPhoto, false);
  assert.equal(
    (await f.rpc(user.cookie, "photo.url", {})).json.error.code,
    "FORBIDDEN",
  );
  assert.equal(
    (await f.rpc(user.cookie, "person.list", { circleId: f.circleId })).json
      .error.code,
    "FORBIDDEN",
  );
  const application = await f.apply(user, invitation);
  const pending = (
    await f.ok(f.owner.cookie, "join.list", { circleId: f.circleId })
  ).applications[0];
  assert.equal(pending.loginPhone, "+8613800000022");
  assert.equal(pending.phoneMatch.personId, target.id);
  assert.equal(
    (
      await f.rpc(f.owner.cookie, "join.approve", {
        circleId: f.circleId,
        applicationId: application.id,
        deferRelation: true,
      })
    ).json.error.code,
    "PHONE_TARGET_REQUIRED",
  );
  await f.approve(application, {
    id: pending.phoneMatch.personId,
    updatedAt: pending.phoneMatch.personUpdatedAt,
  });
  let list = await f.ok(user.cookie, "person.list", { circleId: f.circleId });
  assert.equal(list.persons.length, 2);
  assert.equal(
    list.persons.find((person) => person.id === target.id).isSelf,
    true,
  );
  assert.equal(
    list.persons.find((person) => person.id === target.id).hasPhoto,
    true,
  );
  assert.equal(
    (await f.ok(user.cookie, "relation.list", { circleId: f.circleId }))
      .relations.length,
    1,
  );
  assert.equal(
    (
      await f.request(
        (
          await f.ok(user.cookie, "photo.url", {
            circleId: f.circleId,
            personId: target.id,
          })
        ).url,
        undefined,
        user.cookie,
      )
    ).status,
    200,
  );
  await f.ok(user.cookie, "account.profile.update", {
    patch: { name: "小晴本人修改", industry: "设计" },
  });
  list = await f.ok(f.owner.cookie, "person.list", { circleId: f.circleId });
  assert.equal(list.persons.length, 2);
  assert.equal(
    list.persons.find((person) => person.id === target.id).name,
    "小晴本人修改",
  );
  assert.equal(
    (
      await f.rpc(user.cookie, "person.update", {
        circleId: f.circleId,
        personId: parent.id,
        patch: { name: "越权" },
      })
    ).json.error.code,
    "FORBIDDEN",
  );
});

test("matching trusts accounts phone only and imports never overwrite account choices or explicit removals", async (t) => {
  const f = await fixture(t),
    target = await f.add();
  await f.ok(f.owner.cookie, "person.update", {
    circleId: f.circleId,
    personId: target.id,
    patch: { industry: "旧行业", wechatId: "旧微信" },
  });
  const invitation = await f.invite(),
    user = await f.register(invitation);
  await f.ok(user.cookie, "account.profile.update", {
    patch: {
      ...PROFILE,
      name: "本人名字",
      phone: "13800000999",
      city: "上海市",
      province: "上海市",
      latitude: 31.2,
      longitude: 121.5,
      wechatId: null,
    },
  });
  const info = await f.preview(user, invitation);
  assert.equal(info.match.status, "unique");
  const imported = (await f.confirm(user, invitation, info)).profile;
  assert.equal(imported.name, "本人名字");
  assert.equal(imported.city, "上海市");
  assert.equal(imported.longitude, 121.5);
  assert.equal(imported.phone, "+8613800000999");
  assert.equal(imported.wechatId, undefined);
  assert.equal(imported.industry, "旧行业");
  const secondInvite = await f.invite(),
    outsider = await f.register(secondInvite, "13800000044");
  await f.ok(outsider.cookie, "account.profile.update", {
    patch: { ...PROFILE, phone: PHONE },
  });
  assert.equal((await f.preview(outsider, secondInvite)).match.status, "none");
  const application = await f.apply(outsider, secondInvite);
  assert.equal(
    (
      await f.rpc(f.owner.cookie, "join.approve", {
        circleId: f.circleId,
        applicationId: application.id,
        targetPersonId: target.id,
        targetPersonUpdatedAt: target.updatedAt,
      })
    ).json.error.code,
    "PHONE_MISMATCH",
  );
});

test("legacy duplicate numbers, already bound profiles and verified-phone gates do not accidentally bind", async (t) => {
  const f = await fixture(t),
    target = await f.add(),
    invitation = await f.invite(),
    user = await f.register(invitation);
  await f.app.store.atomic(async (tx) => {
    const person = await tx.get("persons", target.id);
    await tx.put("persons", { ...person, id: crypto.randomUUID() });
  });
  assert.equal((await f.preview(user, invitation)).match.status, "conflict");
  assert.equal(
    (await f.rpc(user.cookie, "invite.apply", { token: invitation.token })).json
      .error.code,
    "PHONE_MATCH_CONFLICT",
  );
  await f.app.store.atomic(async (tx) => {
    const people = await tx.find("persons", { circleId: f.circleId });
    for (const person of people)
      if (person.id !== target.id) await tx.delete("persons", person.id);
    const person = await tx.get("persons", target.id);
    person.matchPhone = "+8613800000022";
    await tx.put("persons", person);
  });
  assert.equal(
    (await f.preview(user, invitation)).match.status,
    "verification-required",
  );
  assert.equal(
    (await f.rpc(user.cookie, "invite.apply", { token: invitation.token })).json
      .error.code,
    "PHONE_MISMATCH",
  );
  await f.app.store.atomic(async (tx) => {
    const person = await tx.get("persons", target.id);
    delete person.matchPhone;
    person.claimedBy = "some_other_account";
    await tx.put("persons", person);
  });
  const bound = await f.preview(user, invitation);
  assert.equal(bound.match.status, "bound");
  assert.equal(bound.match.person, undefined);
});

test("profile changes between preview, confirmation and review are rechecked before binding", async (t) => {
  const f = await fixture(t),
    target = await f.add(),
    invitation = await f.invite(),
    user = await f.register(invitation);
  const stale = await f.preview(user, invitation);
  await f.ok(user.cookie, "account.profile.update", {
    patch: { nickname: "新昵称" },
  });
  assert.equal(
    (
      await f.request(
        "/api/onboarding/import",
        {
          inviteToken: invitation.token,
          personId: target.id,
          personUpdatedAt: stale.match.person.updatedAt,
          profileVersion: stale.profileVersion,
        },
        user.cookie,
      )
    ).json.error.code,
    "PROFILE_CHANGED",
  );
  await f.confirm(user, invitation);
  const application = await f.apply(user, invitation);
  await f.ok(f.owner.cookie, "person.update", {
    circleId: f.circleId,
    personId: target.id,
    patch: { name: "管理员更正" },
  });
  assert.equal(
    (
      await f.rpc(f.owner.cookie, "join.approve", {
        circleId: f.circleId,
        applicationId: application.id,
        targetPersonId: target.id,
        targetPersonUpdatedAt: target.updatedAt,
      })
    ).json.error.code,
    "PROFILE_CONFIRMATION_REQUIRED",
  );
  const refreshed = await f.confirm(user, invitation);
  assert.equal(refreshed.profile.name, "管理员更正");
  const fresh = (
    await f.ok(f.owner.cookie, "join.list", { circleId: f.circleId })
  ).applications[0];
  await f.ok(f.owner.cookie, "person.update", {
    circleId: f.circleId,
    personId: target.id,
    patch: { phone: "13800000777" },
  });
  assert.equal(
    (
      await f.rpc(f.owner.cookie, "join.approve", {
        circleId: f.circleId,
        applicationId: application.id,
        targetPersonId: target.id,
        targetPersonUpdatedAt: fresh.phoneMatch.personUpdatedAt,
      })
    ).json.error.code,
    "PHONE_MATCH_CONFLICT",
  );
  assert.match(
    (await f.preview(user, invitation)).match.message,
    /重新发送邀请/,
  );
  assert.equal(
    (await f.ok(f.owner.cookie, "person.list", { circleId: f.circleId }))
      .persons.length,
    1,
  );
});

test("already logged-in account can preview then reserve a new invitation without signing in again", async (t) => {
  const f = await fixture(t),
    target = await f.add(),
    first = await f.invite(),
    user = await f.register(first),
    second = await f.invite();
  const before = await f.preview(user, second);
  assert.equal(before.match.person.id, target.id);
  await f.confirm(user, second, before);
  assert.equal((await f.preview(user, second)).match.confirmed, true);
  await f.apply(user, second);
  const unrelated = await f.register(await f.invite(), "13800000055");
  assert.equal(
    (
      await f.request(
        "/api/onboarding/preview",
        { inviteToken: second.token },
        unrelated.cookie,
      )
    ).json.error.code,
    "INVITE_ASSIGNED",
  );
});

test("already approved members without a node reuse their sole matching existing record", async (t) => {
  const f = await fixture(t),
    target = await f.add("13800000011");
  assert.equal(
    (
      await f.rpc(f.owner.cookie, "person.create", {
        circleId: f.circleId,
        ...PROFILE,
        claimSelf: true,
        phone: "13800009999",
        deferRelation: true,
      })
    ).json.error.code,
    "PHONE_TARGET_REQUIRED",
  );
  assert.equal(
    (await f.ok(f.owner.cookie, "person.list", { circleId: f.circleId }))
      .persons.length,
    1,
  );
  await f.ok(f.owner.cookie, "account.profile.update", {
    patch: { ...PROFILE, name: "创建者本人" },
  });
  const list = (
    await f.ok(f.owner.cookie, "person.list", { circleId: f.circleId })
  ).persons;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, target.id);
  assert.equal(list[0].isSelf, true);
  assert.equal(list[0].name, "创建者本人");
  await f.ok(f.owner.cookie, "account.profile.update", {
    patch: { industry: "再次保存" },
  });
  assert.equal(
    (await f.ok(f.owner.cookie, "person.list", { circleId: f.circleId }))
      .persons.length,
    1,
  );
  const member = await f.app.store.atomic((tx) =>
    tx.get("members", memberId(f.circleId, f.setup.accountId)),
  );
  assert.equal(member.personId, target.id);
});

test("reconfirmation refreshes untouched automatic fills, keeps explicit edits, and concurrent approvals bind only once", async (t) => {
  const f = await fixture(t),
    target = await f.add(),
    invitation = await f.invite(),
    user = await f.register(invitation);
  await f.confirm(user, invitation);
  // An explicit same-value edit is still the person's own confirmed choice.
  await f.ok(user.cookie, "account.profile.update", {
    patch: { name: PROFILE.name },
  });
  const application = await f.apply(user, invitation);
  await f.ok(f.owner.cookie, "person.update", {
    circleId: f.circleId,
    personId: target.id,
    patch: {
      name: "管理员新的称呼",
      city: "上海市",
      province: "上海市",
      latitude: 31.2,
      longitude: 121.5,
      birthday: { calendar: "solar", year: 1997, month: 8, day: 9 },
    },
  });
  const imported = (await f.confirm(user, invitation)).profile;
  assert.equal(imported.name, PROFILE.name);
  assert.equal(imported.city, "上海市");
  assert.equal(imported.longitude, 121.5);
  assert.equal(imported.birthday.month, 8);
  const current = (
    await f.ok(f.owner.cookie, "join.list", { circleId: f.circleId })
  ).applications[0];
  assert.equal(current.phoneMatch.confirmed, true);
  const payload = {
    circleId: f.circleId,
    applicationId: application.id,
    reviewToken: current.reviewToken,
    targetPersonId: target.id,
    targetPersonUpdatedAt: current.phoneMatch.personUpdatedAt,
  };
  const result = await Promise.all([
    f.rpc(f.owner.cookie, "join.approve", payload),
    f.rpc(f.owner.cookie, "join.approve", payload),
  ]);
  assert.equal(result.filter((response) => response.json.ok).length, 1);
  assert.equal(
    (await f.ok(user.cookie, "person.list", { circleId: f.circleId })).persons
      .length,
    1,
  );
});

test("a revoked matching invitation cannot expose or import the family record while another invitation keeps the account signed in", async (t) => {
  const f = await fixture(t),
    target = await f.add(),
    first = await f.invite(),
    user = await f.register(first),
    second = await f.invite();
  const info = await f.preview(user, second);
  await f.ok(f.owner.cookie, "invite.revoke", {
    circleId: f.circleId,
    inviteId: second.id,
  });
  assert.equal(
    (
      await f.request(
        "/api/onboarding/preview",
        { inviteToken: second.token },
        user.cookie,
      )
    ).json.error.code,
    "INVITE_INACTIVE",
  );
  assert.equal(
    (
      await f.request(
        "/api/onboarding/import",
        {
          inviteToken: second.token,
          personId: target.id,
          personUpdatedAt: info.match.person.updatedAt,
          profileVersion: info.profileVersion,
        },
        user.cookie,
      )
    ).json.error.code,
    "INVITE_INACTIVE",
  );
  assert.equal((await f.ok(user.cookie, "account.profile.get")).profile, null);
  assert.equal(
    (await f.ok(f.owner.cookie, "person.list", { circleId: f.circleId }))
      .persons.length,
    1,
  );
});

test("reconfirmation keeps the entire chosen location when the person changed only their city", async (t) => {
  const f = await fixture(t),
    target = await f.add(),
    invitation = await f.invite(),
    user = await f.register(invitation);
  await f.confirm(user, invitation);
  await f.ok(user.cookie, "account.profile.update", {
    patch: { city: "上海市", province: "上海市" },
  });
  await f.ok(f.owner.cookie, "person.update", {
    circleId: f.circleId,
    personId: target.id,
    patch: {
      country: "美国",
      province: "Washington",
      city: "Seattle",
      latitude: 47.6,
      longitude: -122.3,
    },
  });
  const profile = (await f.confirm(user, invitation)).profile;
  assert.equal(profile.country, "中国");
  assert.equal(profile.province, "上海市");
  assert.equal(profile.city, "上海市");
  assert.equal(profile.latitude, undefined);
  assert.equal(profile.longitude, undefined);
});

test("member and admin edits cannot clear or corrupt a required contact phone", async (t) => {
  const f = await fixture(t),
    target = await f.add(),
    invitation = await f.invite();
  const user = await f.register(invitation);
  await f.confirm(user, invitation);
  const application = await f.apply(user, invitation);
  const pending = (
    await f.ok(f.owner.cookie, "join.list", { circleId: f.circleId })
  ).applications[0];
  await f.approve(application, {
    id: pending.phoneMatch.personId,
    updatedAt: pending.phoneMatch.personUpdatedAt,
  });
  const before = (
    await f.ok(user.cookie, "person.list", { circleId: f.circleId })
  ).persons;
  for (const phone of [null, "", " ", "12345", "02012345678"]) {
    for (const [cookie, action, scope] of [
      [user.cookie, "account.profile.update", {}],
      [f.owner.cookie, "account.profile.update", {}],
      [
        user.cookie,
        "person.update",
        { circleId: f.circleId, personId: target.id },
      ],
      [
        f.owner.cookie,
        "person.update",
        { circleId: f.circleId, personId: target.id },
      ],
    ]) {
      const response = await f.rpc(cookie, action, {
        ...scope,
        patch: { phone, name: "不应保存" },
      });
      assert.equal(
        response.json.error?.code,
        "PHONE_REQUIRED",
        JSON.stringify(response.json),
      );
    }
  }
  assert.deepEqual(
    (await f.ok(user.cookie, "person.list", { circleId: f.circleId })).persons,
    before,
  );
  await f.ok(user.cookie, "account.profile.update", {
    patch: { phone: "138 0000 0022", name: "本人修改" },
  });
  await f.ok(f.owner.cookie, "person.update", {
    circleId: f.circleId,
    personId: target.id,
    patch: { phone: "+86 13800000022", name: "管理员更正" },
  });
  const saved = (
    await f.ok(user.cookie, "person.list", { circleId: f.circleId })
  ).persons.find((p) => p.id === target.id);
  assert.equal(saved.phone, "+8613800000022");
  assert.equal(saved.name, "管理员更正");
});
