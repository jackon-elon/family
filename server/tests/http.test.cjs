"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../app.cjs");
const { readConfig } = require("../config.cjs");
const { seed } = require("../seed.cjs");
const { clientIp, passwordHash } = require("../auth.cjs");
const { ApiService } = require("../../backend/dist/service.js");
const { setupFamily } = require("../setup.cjs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ORIGIN = "http://localhost:5173";
const PASSWORD = "TestPassword2026!";
const PROFILE = {
  name: "测试家人",
  gender: "male",
  country: "中国",
  province: "浙江省",
  city: "杭州市",
  latitude: 30.3,
  longitude: 120.2,
  birthday: { calendar: "solar", month: 6, day: 18, year: 1995 },
};

async function fixture(t, overrides = {}, runtime = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kin-http-"));
  const config = {
    ...readConfig({ DATA_DIR: directory, FRONTEND_ORIGIN: ORIGIN }),
    authIpLimit: 500,
    authPhoneLimit: 100,
    ...overrides,
  };
  const state = {
    directory,
    config,
    app: createApp({ config, ...runtime }),
    url: "",
  };
  const start = async () => {
    const address = await state.app.listen(0);
    state.url = `http://127.0.0.1:${address.port}`;
  };
  await start();
  state.restart = async () => {
    await state.app.close();
    state.app = createApp({ config, ...runtime });
    await start();
  };
  t.after(async () => {
    await state.app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  state.request = async (route, body, cookie, options = {}) => {
    const response = await fetch(`${state.url}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined
          ? {}
          : { Origin: ORIGIN, "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...options.headers,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const raw = Buffer.from(await response.arrayBuffer());
    const json = response.headers.get("content-type")?.includes("json")
      ? JSON.parse(raw.toString())
      : undefined;
    return {
      status: response.status,
      json,
      raw,
      headers: response.headers,
      cookie: response.headers.getSetCookie()[0]?.split(";")[0],
    };
  };
  state.register = async (phone = "13812340000") => {
    const result = await state.request("/api/auth/register", {
      phone,
      password: PASSWORD,
      inviteToken: await state.invite(),
    });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    return result;
  };
  state.invite = async () => {
    if (!state.inviterCircle) {
      const created = await state.app.api.invoke(
        {
          action: "circle.create",
          payload: { type: "family", name: "测试初始化家庭", mode: "shared" },
        },
        "fixture_initializer",
      );
      assert.equal(created.ok, true);
      state.inviterCircle = created.data.circle.id;
    }
    const invitation = await state.app.api.invoke(
      { action: "invite.create", payload: { circleId: state.inviterCircle } },
      "fixture_initializer",
    );
    assert.equal(invitation.ok, true);
    return invitation.data.invite.token;
  };
  state.rawRpc = async (cookie, action, payload = {}) =>
    state.request("/api/rpc", { action, payload }, cookie);
  state.rpc = async (cookie, action, payload = {}) => {
    let result = await state.rawRpc(cookie, action, payload);
    if (result.json.error?.code === "REAUTH_REQUIRED") {
      assert.equal(
        (
          await state.request(
            "/api/auth/reauthenticate",
            { password: PASSWORD },
            cookie,
          )
        ).status,
        200,
      );
      result = await state.rawRpc(cookie, action, payload);
    }
    return result;
  };
  state.ok = async (cookie, action, payload = {}) => {
    const result = await state.rpc(cookie, action, payload);
    assert.equal(
      result.json.ok,
      true,
      `${action}: ${JSON.stringify(result.json)}`,
    );
    return result.json.data;
  };
  // Import a pre-existing card through the reusable legacy domain, bypassing
  // only the new web form requirement. Used solely for migration fixtures.
  state.legacyPerson = async (accountId, payload) => {
    const result = await state.app.api.invoke(
      { action: "person.create", payload },
      accountId,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  state.family = async (cookie) => {
    await state.ok(cookie, "account.profile.update", { patch: PROFILE });
    const actorId = (await state.request("/api/auth/me", undefined, cookie))
      .json.data.user.id;
    const created = await state.app.api.invoke(
      {
        action: "circle.create",
        payload: {
          name: "测试家庭",
          type: "family",
          mode: "shared",
        },
      },
      actorId,
    );
    assert.equal(created.ok, true);
    const circle = created.data.circle;
    const person = (
      await state.ok(cookie, "person.create", {
        circleId: circle.id,
        ...PROFILE,
        claimSelf: true,
      })
    ).person;
    return { circle, person };
  };
  state.join = async (owner, member, circleId, options = {}) => {
    await state.ok(member, "account.profile.update", {
      patch: { ...PROFILE, name: "新家人" },
    });
    const invite = (await state.ok(owner, "invite.create", { circleId }))
      .invite;
    const application = (
      await state.ok(member, "invite.apply", {
        token: invite.token,
        note: "亲友介绍",
      })
    ).application;
    await state.ok(owner, "join.approve", {
      circleId,
      applicationId: application.id,
      deferRelation: true,
      ...options,
    });
    return { invite, application };
  };
  return state;
}

test("registration and opaque sessions do not verify phones or trust client actors", async (t) => {
  const f = await fixture(t);
  const registered = await f.register();
  assert.match(registered.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
  assert.equal(registered.json.data.user.phone, "+8613812340000");
  assert.equal(registered.json.data.user.phoneVerified, false);
  assert.equal(
    (await f.request("/api/auth/me", undefined, registered.cookie)).json.data
      .user.id,
    registered.json.data.user.id,
  );
  assert.equal((await f.request("/api/auth/me")).status, 401);
  assert.equal(
    (await f.request("/api/auth/me", undefined, `${registered.cookie}fake`))
      .status,
    401,
  );
  const secretRows = await f.app.store.exclusive((db) => ({
    account: db.prepare("SELECT * FROM accounts").get(),
    session: db.prepare("SELECT * FROM sessions").get(),
  }));
  assert.match(secretRows.account.password_hash, /^scrypt\$/);
  assert.notEqual(
    secretRows.session.token_hash,
    registered.cookie.split("=")[1],
  );
  assert.equal(
    (await f.app.store.atomic((tx) => tx.find("phoneIdentities", {}))).length,
    0,
  );
  assert.deepEqual((await f.rpc(registered.cookie, "account.sync")).json.data, {
    hasVerifiedPhone: false,
    linked: [],
    alreadyLinked: [],
    skipped: 0,
  });
  const forged = await f.request("/api/rpc", {
    action: "circle.list",
    actorId: registered.json.data.user.id,
  });
  assert.equal(forged.status, 400);
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13812340000",
        password: "wrong-password",
      })
    ).json.error.code,
    "BAD_CREDENTIALS",
  );
  await f.request("/api/auth/logout", {}, registered.cookie);
  assert.equal(
    (await f.request("/api/auth/me", undefined, registered.cookie)).status,
    401,
  );
});

test("strict origin, JSON limits, and production settings reject unsafe requests", async (t) => {
  const f = await fixture(t);
  const badOrigin = await f.request(
    "/api/auth/register",
    { phone: "13812340000", password: PASSWORD },
    undefined,
    { headers: { Origin: "https://evil.example" } },
  );
  assert.equal(badOrigin.status, 403);
  const missingOrigin = await fetch(`${f.url}/api/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missingOrigin.status, 403);
  const textBody = await f.request("/api/auth/logout", {}, undefined, {
    headers: { "Content-Type": "text/plain" },
  });
  assert.equal(textBody.status, 415);
  assert.equal((await f.request("/api/auth/logout", "{")).status, 400);
  assert.equal(
    (await f.request("/api/auth/logout", { tooLarge: "x".repeat(130 * 1024) }))
      .status,
    413,
  );
  assert.throws(() => readConfig({ NODE_ENV: "production" }), /requires/);
  assert.throws(
    () =>
      readConfig({
        NODE_ENV: "production",
        DATA_DIR: f.directory,
        FRONTEND_ORIGIN: ORIGIN,
      }),
    /HTTPS/,
  );
  const production = readConfig({
    NODE_ENV: "production",
    DATA_DIR: f.directory,
    FRONTEND_ORIGIN: "https://kin.example.com",
  });
  const { Authentication } = require("../auth.cjs");
  assert.match(
    new Authentication(f.app.store, production).cookie("test"),
    /^__Host-kin_session=.*; Secure$/,
  );
});

test("concurrent registration is unique and auth writes cannot be rolled back by a domain transaction", async (t) => {
  const f = await fixture(t);
  const results = await Promise.all(
    [1, 2].map(async () =>
      f.request("/api/auth/register", {
        phone: "13812340000",
        password: PASSWORD,
        inviteToken: await f.invite(),
      }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  let release;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const failedTransaction = f.app.store.atomic(async (tx) => {
    await tx.put("audit", { id: "must-rollback", circleId: "none" });
    entered();
    await barrier;
    throw new Error("intentional rollback");
  });
  const rejection = assert.rejects(failedTransaction, /intentional rollback/);
  await started;
  const registration = f.register("13812340001");
  release();
  await rejection;
  const created = await registration;
  assert.equal(
    (await f.request("/api/auth/me", undefined, created.cookie)).status,
    200,
  );
  assert.equal(
    await f.app.store.atomic((tx) => tx.get("audit", "must-rollback")),
    undefined,
  );
  assert.equal(
    await f.app.store.exclusive(
      (db) => db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count,
    ),
    2,
  );
});

test("accounts, memberships, session and profile survive a server restart", async (t) => {
  const f = await fixture(t);
  const { cookie } = await f.register();
  const { circle, person } = await f.family(cookie);
  await f.restart();
  assert.equal(
    (await f.request("/api/auth/me", undefined, cookie)).status,
    200,
  );
  const circles = (await f.ok(cookie, "circle.list")).circles;
  assert.equal(circles[0].id, circle.id);
  assert.equal(circles[0].personCount, 1);
  assert.equal(
    (
      await f.ok(cookie, "person.get", {
        circleId: circle.id,
        personId: person.id,
      })
    ).person.name,
    PROFILE.name,
  );
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13812340000",
        password: PASSWORD,
      })
    ).status,
    200,
  );
});

test("invite approval works for unverified users, with role isolation and verified phone gate intact", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const newcomer = await f.register("13812340001");
  const outsider = await f.register("13812340002");
  const { circle, person } = await f.family(owner.cookie);
  await f.ok(newcomer.cookie, "account.profile.update", {
    patch: { ...PROFILE, name: "新家人" },
  });
  const recorded = (
    await f.legacyPerson(owner.json.data.user.id, {
      circleId: circle.id,
      ...PROFILE,
      name: "已有资料",
      matchPhone: "13812340001",
      deferRelation: true,
    })
  ).person;
  const invite = (
    await f.ok(owner.cookie, "invite.create", { circleId: circle.id })
  ).invite;
  assert.equal(
    (await f.rpc(undefined, "invite.preview", { token: invite.token })).json.ok,
    true,
  );
  const application = (
    await f.ok(newcomer.cookie, "invite.apply", { token: invite.token })
  ).application;
  const badBind = await f.rpc(owner.cookie, "join.approve", {
    circleId: circle.id,
    applicationId: application.id,
    targetPersonId: recorded.id,
    targetPersonUpdatedAt: recorded.updatedAt,
  });
  assert.equal(badBind.json.error.code, "PHONE_MISMATCH");
  await f.ok(owner.cookie, "join.approve", {
    circleId: circle.id,
    applicationId: application.id,
    initialRelation: { anchorPersonId: person.id, kind: "sibling" },
  });
  assert.equal((await f.ok(newcomer.cookie, "circle.list")).circles.length, 1);
  assert.equal(
    (await f.ok(owner.cookie, "person.list", { circleId: circle.id })).persons
      .length,
    3,
  );
  assert.equal(
    (
      await f.rpc(newcomer.cookie, "person.update", {
        circleId: circle.id,
        personId: person.id,
        patch: { name: "篡改" },
      })
    ).json.error.code,
    "FORBIDDEN",
  );
  assert.equal(
    (await f.rpc(newcomer.cookie, "invite.create", { circleId: circle.id }))
      .json.error.code,
    "FORBIDDEN",
  );
  assert.equal(
    (await f.rpc(outsider.cookie, "person.list", { circleId: circle.id })).json
      .error.code,
    "FORBIDDEN",
  );
  assert.equal(
    (await f.rpc(outsider.cookie, "invite.apply", { token: invite.token })).json
      .ok,
    false,
  );
  const remarks = await f.ok(newcomer.cookie, "person.remark.update", {
    circleId: circle.id,
    personId: person.id,
    remark: "表哥",
  });
  assert.equal(remarks.remark, "表哥");
  assert.equal(
    (
      await f.ok(owner.cookie, "person.remark.get", {
        circleId: circle.id,
        personId: person.id,
      })
    ).remark,
    "",
  );
  const member = (
    await f.ok(owner.cookie, "member.list", { circleId: circle.id })
  ).members.find((value) => !value.isSelf);
  await f.ok(owner.cookie, "member.remove", {
    circleId: circle.id,
    memberId: member.id,
  });
  assert.equal(
    (await f.rpc(newcomer.cookie, "person.list", { circleId: circle.id })).json
      .error.code,
    "FORBIDDEN",
  );
});

test("photos strip private metadata, require current membership, and remain protected after restart", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const member = await f.register("13812340001");
  const outsider = await f.register("13812340002");
  const { circle, person } = await f.family(owner.cookie);
  await f.join(owner.cookie, member.cookie, circle.id);
  const jpeg = await fs.readFile(
    path.resolve(__dirname, "../../backend/tests/fixtures/tiny.jpg"),
  );
  const metadata = Buffer.from("Exif\0\0PRIVATE-GPS-TEST");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(metadata.length + 2);
  const withExif = Buffer.concat([
    jpeg.subarray(0, 2),
    Buffer.from([0xff, 0xe1]),
    length,
    metadata,
    jpeg.subarray(2),
  ]);
  assert.equal(
    (
      await f.request(
        "/api/photos",
        { base64: withExif.toString("base64") },
        owner.cookie,
      )
    ).json.ok,
    true,
  );
  const payload = { circleId: circle.id, personId: person.id };
  const url = (await f.ok(owner.cookie, "photo.url", payload)).url;
  assert.match(url, /^\/api\/photos\?/);
  assert.doesNotMatch(url, /cloud:|uploads/);
  assert.equal((await f.request(url)).status, 401);
  assert.equal((await f.request(url, undefined, outsider.cookie)).status, 403);
  const viewed = await f.request(url, undefined, member.cookie);
  assert.equal(viewed.status, 200);
  assert.equal(viewed.headers.get("cache-control"), "no-store");
  assert.equal(viewed.raw.includes(metadata), false);
  assert.equal(
    (
      await f.request(
        "/api/photos",
        { base64: jpeg.toString("base64"), ...payload },
        member.cookie,
      )
    ).json.error.code,
    "FORBIDDEN",
  );
  await f.restart();
  assert.equal((await f.request(url, undefined, member.cookie)).status, 200);
  const row = (
    await f.ok(owner.cookie, "member.list", { circleId: circle.id })
  ).members.find((value) => !value.isSelf);
  await f.ok(owner.cookie, "member.remove", {
    circleId: circle.id,
    memberId: row.id,
  });
  assert.equal((await f.request(url, undefined, member.cookie)).status, 403);
  assert.equal(
    (
      await f.request(
        "/api/photos?file=../../kin.sqlite",
        undefined,
        owner.cookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        "/api/photos",
        { base64: Buffer.from("<svg onload=alert(1)>").toString("base64") },
        owner.cookie,
      )
    ).json.error.code,
    "INVALID_IMAGE",
  );
});

test("an administrator can manually link a legacy record without a contact phone or match key", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const newcomer = await f.register("13812340001");
  const { circle, person } = await f.family(owner.cookie);
  const existing = (
    await f.legacyPerson(owner.json.data.user.id, {
      circleId: circle.id,
      ...PROFILE,
      name: "妈妈",
      gender: "female",
      initialRelation: { anchorPersonId: person.id, kind: "newParent" },
    })
  ).person;
  await f.ok(newcomer.cookie, "account.profile.update", {
    patch: { ...PROFILE, name: "妈妈", gender: "female" },
  });
  const invite = (
    await f.ok(owner.cookie, "invite.create", { circleId: circle.id })
  ).invite;
  const application = (
    await f.ok(newcomer.cookie, "invite.apply", {
      token: invite.token,
      note: "管理员人工核对为已有家人",
    })
  ).application;
  await f.ok(owner.cookie, "join.approve", {
    circleId: circle.id,
    applicationId: application.id,
    targetPersonId: existing.id,
    targetPersonUpdatedAt: existing.updatedAt,
  });
  const people = (
    await f.ok(newcomer.cookie, "person.list", { circleId: circle.id })
  ).persons;
  assert.equal(
    people.length,
    2,
    "manual linking must not create a duplicate person",
  );
  const self = (
    await f.ok(newcomer.cookie, "member.list", { circleId: circle.id })
  ).members.find((member) => member.isSelf);
  assert.equal(self.personId, existing.id);
  assert.equal(
    (await f.app.store.atomic((tx) => tx.find("phoneIdentities", {}))).length,
    0,
  );
  await f.ok(newcomer.cookie, "person.update", {
    circleId: circle.id,
    personId: existing.id,
    patch: { nickname: "妈妈的昵称" },
  });
  assert.equal(
    (await f.ok(owner.cookie, "relation.list", { circleId: circle.id }))
      .relations.length,
    1,
  );
});

test("management transfer displays the recipient's current account profile name", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const recipient = await f.register("13812340001");
  const { circle } = await f.family(owner.cookie);
  await f.join(owner.cookie, recipient.cookie, circle.id);
  const member = (
    await f.ok(recipient.cookie, "member.list", { circleId: circle.id })
  ).members.find((value) => value.isSelf);
  await f.ok(recipient.cookie, "account.profile.update", {
    patch: { name: "已更正的姓名" },
  });

  const requested = await f.ok(owner.cookie, "circle.transferOwner", {
    circleId: circle.id,
    memberId: member.id,
  });
  assert.equal(requested.ownerTransfer.targetName, "已更正的姓名");
  assert.equal(
    (await f.ok(recipient.cookie, "circle.detail", { circleId: circle.id }))
      .ownerTransfer.targetName,
    "已更正的姓名",
  );

  // Administrator corrections are local to this record and should agree
  // with its member picker and review panel, without changing the account.
  await f.ok(owner.cookie, "person.update", {
    circleId: circle.id,
    personId: member.personId,
    patch: { name: "本记录核对姓名" },
  });
  assert.equal(
    (await f.ok(owner.cookie, "circle.detail", { circleId: circle.id }))
      .ownerTransfer.targetName,
    "本记录核对姓名",
  );
  assert.equal(
    (await f.ok(recipient.cookie, "account.profile.get")).profile.name,
    "已更正的姓名",
  );
});

test("live sessions follow owner/admin/member changes and revoke record access after leaving", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const admin = await f.register("13812340001");
  const member = await f.register("13812340002");
  const { circle, person } = await f.family(owner.cookie);
  await f.join(owner.cookie, admin.cookie, circle.id);
  await f.join(owner.cookie, member.cookie, circle.id);
  const ownMember = async (cookie) =>
    (await f.ok(cookie, "member.list", { circleId: circle.id })).members.find(
      (value) => value.isSelf,
    );
  const ownerRow = await ownMember(owner.cookie);
  const adminRow = await ownMember(admin.cookie);
  const memberRow = await ownMember(member.cookie);
  const denied = async (cookie, action, payload = {}, code = "FORBIDDEN") => {
    const result = await f.rpc(cookie, action, {
      circleId: circle.id,
      ...payload,
    });
    assert.equal(result.json.error?.code, code, JSON.stringify(result.json));
  };

  await f.ok(owner.cookie, "member.setRole", {
    circleId: circle.id,
    memberId: adminRow.id,
    role: "admin",
  });
  await f.ok(admin.cookie, "person.update", {
    circleId: circle.id,
    personId: person.id,
    patch: { bio: "管理员核对的本记录资料" },
  });
  await denied(member.cookie, "audit.list");
  await denied(admin.cookie, "member.setRole", {
    memberId: memberRow.id,
    role: "admin",
  });
  await denied(admin.cookie, "member.remove", { memberId: ownerRow.id });
  const transfer = (
    await f.ok(owner.cookie, "circle.transferOwner", {
      circleId: circle.id,
      memberId: memberRow.id,
    })
  ).ownerTransfer;
  assert.equal(
    (await f.ok(member.cookie, "circle.detail", { circleId: circle.id })).role,
    "member",
  );
  await denied(admin.cookie, "circle.acceptOwnerTransfer", {
    transferId: transfer.id,
  });
  await f.ok(member.cookie, "circle.acceptOwnerTransfer", {
    circleId: circle.id,
    transferId: transfer.id,
  });
  await denied(owner.cookie, "member.setRole", {
    memberId: adminRow.id,
    role: "member",
  });
  await f.ok(member.cookie, "member.setRole", {
    circleId: circle.id,
    memberId: adminRow.id,
    role: "member",
  });
  await denied(admin.cookie, "invite.create");
  await denied(admin.cookie, "person.update", {
    personId: person.id,
    patch: { bio: "过期管理员操作" },
  });
  await denied(member.cookie, "member.leave", {}, "OWNER_REQUIRED");

  await f.restart();
  assert.equal(
    (await f.ok(owner.cookie, "circle.detail", { circleId: circle.id })).role,
    "admin",
  );
  assert.equal(
    (await f.ok(member.cookie, "circle.detail", { circleId: circle.id })).role,
    "owner",
  );
  await f.ok(admin.cookie, "member.leave", { circleId: circle.id });
  await denied(admin.cookie, "person.list");
  await denied(admin.cookie, "relation.list");
  await denied(admin.cookie, "birthday.upcoming");
  assert.deepEqual((await f.ok(admin.cookie, "circle.list")).circles, []);
  assert.equal(
    (await f.request("/api/auth/me", undefined, admin.cookie)).status,
    200,
  );
  assert.equal(
    (await f.ok(admin.cookie, "account.profile.get")).profile.name,
    "新家人",
  );
});

test("the family-only web API hides archived classmate records and blocks their direct IDs, invitations and photos", async (t) => {
  const f = await fixture(t, {}, { now: () => Date.UTC(2026, 5, 18) });
  const owner = await f.register();
  const applicant = await f.register("13812340001");
  const { circle: family, person: familyPerson } = await f.family(owner.cookie);
  await f.ok(applicant.cookie, "account.profile.update", { patch: PROFILE });
  // Recreate records saved by the earlier release through the unchanged
  // shared business service. Only the HTTP service applies the new scope.
  const archived = new ApiService(f.app.store, () => Date.UTC(2026, 5, 18));
  const legacy = async (actor, action, payload) => {
    const result = await archived.invoke({ action, payload }, actor);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  const ownerId = owner.json.data.user.id;
  const applicantId = applicant.json.data.user.id;
  const classPayload = {
    type: "classmate",
    name: "旧同窗录",
    school: "旧中学",
    cohort: "2020",
    className: "三班",
    mode: "shared",
  };
  const classroom = (await legacy(ownerId, "circle.create", classPayload))
    .circle;
  const classPerson = (
    await legacy(ownerId, "person.create", {
      circleId: classroom.id,
      ...PROFILE,
      claimSelf: true,
    })
  ).person;
  await legacy(ownerId, "person.create", {
    circleId: classroom.id,
    ...PROFILE,
    name: "今天生日的旧同学",
  });
  const invite = (
    await legacy(ownerId, "invite.create", { circleId: classroom.id })
  ).invite;
  assert.equal(
    (
      await f.request("/api/auth/register", {
        phone: "13812340009",
        password: PASSWORD,
        inviteToken: invite.token,
      })
    ).json.error.code,
    "INVALID_INVITE",
    "archived classmate invitations must not create web accounts",
  );
  const application = (
    await legacy(applicantId, "invite.apply", {
      token: invite.token,
      note: "以前的同班申请",
    })
  ).application;
  const classMember = (
    await legacy(ownerId, "member.list", { circleId: classroom.id })
  ).members[0];

  const creation = await f.rpc(owner.cookie, "circle.create", classPayload);
  assert.equal(creation.json.error.code, "FAMILY_CREATION_DISABLED");
  assert.equal(
    (await f.rpc(owner.cookie, "circle.create", { type: "classmate" })).json
      .error.code,
    "FAMILY_CREATION_DISABLED",
  );
  assert.equal(
    (await f.rpc(owner.cookie, "circle.create", { name: "缺类型" })).json.error
      .code,
    "FAMILY_CREATION_DISABLED",
  );
  assert.deepEqual(
    (await f.ok(owner.cookie, "circle.list")).circles.map((row) => row.id),
    [family.id],
  );
  assert.deepEqual(
    (await f.ok(owner.cookie, "birthday.upcoming", { days: 0 })).events,
    [],
  );
  assert.deepEqual(
    (await f.ok(applicant.cookie, "join.mine")).applications,
    [],
  );
  assert.equal(
    (await f.ok(owner.cookie, "account.profile.get")).photoUploadTarget
      .circleId,
    family.id,
  );
  assert.deepEqual((await f.ok(owner.cookie, "account.sync")).linked, []);

  for (const action of [
    "circle.detail",
    "person.list",
    "member.list",
    "relation.list",
    "invite.list",
    "join.list",
    "audit.list",
    "birthday.upcoming",
    "invite.create",
  ])
    assert.equal(
      (await f.rpc(owner.cookie, action, { circleId: classroom.id })).json.error
        .code,
      "NOT_FOUND",
      action,
    );
  for (const [action, payload] of [
    ["person.get", { circleId: family.id, personId: classPerson.id }],
    [
      "person.update",
      {
        circleId: family.id,
        personId: classPerson.id,
        patch: { name: "不应写入" },
      },
    ],
    ["person.delete", { circleId: family.id, personId: classPerson.id }],
    [
      "person.remark.update",
      { circleId: family.id, personId: classPerson.id, remark: "不应写入" },
    ],
    ["member.remove", { circleId: family.id, memberId: classMember.id }],
    [
      "relation.create",
      {
        circleId: family.id,
        from: familyPerson.id,
        to: classPerson.id,
        type: "sibling",
      },
    ],
    [
      "join.approve",
      {
        circleId: family.id,
        applicationId: application.id,
        deferRelation: true,
      },
    ],
    ["photo.url", { circleId: family.id, personId: classPerson.id }],
    ["photo.urls", { circleId: classroom.id, personIds: [classPerson.id] }],
  ])
    assert.equal(
      (await f.rpc(owner.cookie, action, payload)).json.error.code,
      "NOT_FOUND",
      action,
    );
  assert.equal(
    (await f.rpc(undefined, "invite.preview", { token: invite.token })).json
      .error.code,
    "INVALID_INVITE",
  );
  assert.equal(
    (await f.rpc(applicant.cookie, "invite.apply", { token: invite.token }))
      .json.error.code,
    "INVALID_INVITE",
  );
  assert.equal(
    (await f.rpc(applicant.cookie, "join.mine", { inviteToken: invite.token }))
      .json.error.code,
    "INVALID_INVITE",
  );
  assert.equal(
    (
      await f.rpc(applicant.cookie, "join.mine", {
        applicationId: application.id,
      })
    ).json.error.code,
    "NOT_FOUND",
  );

  const jpeg = (
    await fs.readFile(
      path.resolve(__dirname, "../../backend/tests/fixtures/tiny.jpg"),
    )
  ).toString("base64");
  assert.equal(
    (await f.request("/api/photos", { base64: jpeg }, owner.cookie)).json.ok,
    true,
  );
  const personalPhoto = (await f.ok(owner.cookie, "photo.url")).url;
  assert.equal(
    (await f.request(personalPhoto, undefined, owner.cookie)).status,
    200,
  );
  const hiddenPhoto = `/api/photos?circleId=${classroom.id}&personId=${classPerson.id}`;
  assert.equal(
    (await f.request(hiddenPhoto, undefined, owner.cookie)).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        "/api/photos",
        { base64: jpeg, circleId: classroom.id, personId: classPerson.id },
        owner.cookie,
      )
    ).json.error.code,
    "NOT_FOUND",
  );
  await f.restart();
  assert.equal(
    (await f.request(hiddenPhoto, undefined, owner.cookie)).status,
    403,
  );
  assert.deepEqual(
    (await f.ok(owner.cookie, "circle.list")).circles.map((row) => row.id),
    [family.id],
  );
  assert.equal(
    (await f.app.store.atomic((tx) => tx.get("circles", classroom.id))).type,
    "classmate",
    "archived data must remain intact",
  );
  assert.equal(
    (await f.app.store.atomic((tx) => tx.get("applications", application.id)))
      .status,
    "pending",
  );
});

test("archived classmate applications are excluded before query limits and family application pagination", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const applicant = await f.register("13812340001");
  const { circle } = await f.family(owner.cookie);
  await f.ok(applicant.cookie, "account.profile.update", { patch: PROFILE });
  const invite = (
    await f.ok(owner.cookie, "invite.create", { circleId: circle.id })
  ).invite;
  const application = (
    await f.ok(applicant.cookie, "invite.apply", { token: invite.token })
  ).application;
  await f.app.store.atomic(async (tx) => {
    await tx.put("circles", {
      id: "archived-class",
      type: "classmate",
      name: "历史同窗录",
    });
    // More archived rows than the raw repository limit, all newer than the
    // real family application, must neither block it nor fill its first page.
    for (let index = 0; index < 5005; index++)
      await tx.put("applications", {
        id: `archived-${index}`,
        circleId: "archived-class",
        inviteId: "old-invite",
        userId: applicant.json.data.user.id,
        name: "历史同学",
        status: "pending",
        createdAt: Date.now() + index,
      });
  });
  const result = await f.ok(applicant.cookie, "join.mine");
  assert.equal(result.hasMore, false);
  assert.deepEqual(
    result.applications.map((row) => row.id),
    [application.id],
  );
});

test("password change requires the current password and revokes all old sessions", async (t) => {
  const f = await fixture(t);
  const first = await f.register();
  const second = await f.request("/api/auth/login", {
    phone: "13812340000",
    password: PASSWORD,
  });
  assert.equal(
    (
      await f.request(
        "/api/auth/password",
        { currentPassword: "wrong", newPassword: "UpdatedPass2026!" },
        first.cookie,
      )
    ).json.error.code,
    "BAD_CREDENTIALS",
  );
  const updated = await f.request(
    "/api/auth/password",
    { currentPassword: PASSWORD, newPassword: "UpdatedPass2026!" },
    first.cookie,
  );
  assert.equal(updated.status, 200);
  assert.notEqual(updated.cookie, first.cookie);
  for (const cookie of [first.cookie, second.cookie])
    assert.equal(
      (await f.request("/api/auth/me", undefined, cookie)).status,
      401,
    );
  assert.equal(
    (await f.request("/api/auth/me", undefined, updated.cookie)).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13812340000",
        password: PASSWORD,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13812340000",
        password: "UpdatedPass2026!",
      })
    ).status,
    200,
  );
});

test("authentication rate limits persist across restart", async (t) => {
  const f = await fixture(
    t,
    { authPhoneLimit: 2 },
    { now: () => Date.UTC(2026, 9, 4) },
  );
  await f.register();
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13812340000",
        password: "wrong",
      })
    ).status,
    401,
  );
  await f.restart();
  const limited = await f.request("/api/auth/login", {
    phone: "13812340000",
    password: PASSWORD,
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "900");
});

test("forwarded addresses are ignored unless proxy trust is explicitly enabled", async (t) => {
  const f = await fixture(t, { authIpLimit: 1 });
  const first = await f.request(
    "/api/auth/register",
    { phone: "13812340000", password: PASSWORD, inviteToken: await f.invite() },
    undefined,
    { headers: { "X-Forwarded-For": "198.51.100.1" } },
  );
  const next = await f.request(
    "/api/auth/register",
    { phone: "13812340001", password: PASSWORD },
    undefined,
    { headers: { "X-Forwarded-For": "198.51.100.2" } },
  );
  assert.equal(first.status, 200);
  assert.equal(next.status, 429);
});

test("one trusted proxy isolates client IP limits and ignores spoofed leftmost entries", async (t) => {
  const f = await fixture(t, { authIpLimit: 1, trustProxyHops: 1 });
  const request = async (phone, chain) =>
    f.request(
      "/api/auth/register",
      { phone, password: PASSWORD, inviteToken: await f.invite() },
      undefined,
      {
        headers: { "X-Forwarded-For": chain },
      },
    );
  assert.equal(
    (await request("13812340000", "203.0.113.50, 198.51.100.1")).status,
    200,
  );
  assert.equal(
    (await request("13812340001", "203.0.113.51, 198.51.100.1")).status,
    429,
  );
  assert.equal(
    (await request("13812340002", "203.0.113.50, 198.51.100.2")).status,
    200,
  );
});

test("malformed forwarded IPs fall back to the socket instead of creating new buckets", async (t) => {
  const f = await fixture(t, { authIpLimit: 1, trustProxyHops: 1 });
  const request = async (phone, chain) =>
    f.request(
      "/api/auth/register",
      { phone, password: PASSWORD, inviteToken: await f.invite() },
      undefined,
      {
        headers: { "X-Forwarded-For": chain },
      },
    );
  assert.equal(
    (await request("13812340000", "invalid-client-one")).status,
    200,
  );
  for (const chain of [
    "invalid-client-two",
    "198.51.100.1:1234",
    "198.51.100.1,",
    "[2001:db8::1]",
    "2001:db8::1%eth0",
  ]) {
    assert.equal((await request("13812340001", chain)).status, 429, chain);
  }
});

test("proxy configuration validates hop counts and normalizes equivalent address spellings", () => {
  const req = (chain) => ({
    socket: { remoteAddress: "::ffff:127.0.0.1" },
    headers: { "x-forwarded-for": chain },
  });
  assert.equal(readConfig({}).trustProxyHops, 0);
  assert.equal(readConfig({ TRUST_PROXY_HOPS: "1" }).trustProxyHops, 1);
  for (const value of ["-1", "17", "true", "1.5", "01", "*"])
    assert.throws(
      () => readConfig({ TRUST_PROXY_HOPS: value }),
      /TRUST_PROXY_HOPS/,
    );
  assert.equal(clientIp(req("198.51.100.5"), 2), "127.0.0.1");
  assert.equal(
    clientIp(req("spoofed, 198.51.100.5, 192.0.2.10"), 2),
    "198.51.100.5",
  );
  assert.equal(clientIp(req("198.51.100.5, malformed-proxy"), 2), "127.0.0.1");
  assert.equal(
    clientIp(req("2001:0DB8:0000:0000:0000:0000:0000:0001"), 1),
    "2001:db8::1",
  );
  assert.equal(clientIp(req("::ffff:192.0.2.10"), 1), "192.0.2.10");
  assert.equal(clientIp(req("::FFFF:C000:020A"), 1), "192.0.2.10");
});

test("phone rate limits still apply across trusted proxy client IPs", async (t) => {
  const f = await fixture(t, { authPhoneLimit: 1, trustProxyHops: 1 });
  const first = await f.request(
    "/api/auth/register",
    { phone: "13812340000", password: PASSWORD, inviteToken: await f.invite() },
    undefined,
    { headers: { "X-Forwarded-For": "198.51.100.1" } },
  );
  const second = await f.request(
    "/api/auth/login",
    { phone: "13812340000", password: PASSWORD },
    undefined,
    { headers: { "X-Forwarded-For": "198.51.100.2" } },
  );
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
});

test("expired sessions cannot access API data or photographs", async (t) => {
  let clock = Date.now();
  const f = await fixture(t, {}, { now: () => clock });
  const { cookie } = await f.register();
  await f.family(cookie);
  clock += f.config.sessionLifetime;
  assert.equal(
    (await f.request("/api/auth/me", undefined, cookie)).status,
    401,
  );
  assert.equal((await f.rpc(cookie, "circle.list")).status, 401);
  assert.equal((await f.request("/api/photos", undefined, cookie)).status, 401);
});

test("asynchronous domain transactions serialize read-modify-write without lost updates", async (t) => {
  const f = await fixture(t);
  await f.app.store.atomic((tx) =>
    tx.put("audit", { id: "counter", count: 0 }),
  );
  await Promise.all(
    Array.from({ length: 25 }, () =>
      f.app.store.atomic(async (tx) => {
        const row = await tx.get("audit", "counter");
        await Promise.resolve();
        row.count++;
        await tx.put("audit", row);
      }),
    ),
  );
  assert.equal(
    (await f.app.store.atomic((tx) => tx.get("audit", "counter"))).count,
    25,
  );
});

test("public registration is invitation-only and no logged-in role can create another family", async (t) => {
  const f = await fixture(t);
  const config = (await f.request("/api/auth/config")).json.data;
  assert.deepEqual(config, {
    registration: "invite-only",
    canCreateFamily: false,
    sessionDays: 7,
    rememberDays: 90,
  });
  for (const inviteToken of [undefined, "", "not-an-invitation"])
    assert.equal(
      (
        await f.request("/api/auth/register", {
          phone: "13812340000",
          password: PASSWORD,
          inviteToken,
        })
      ).status,
      403,
    );
  assert.equal(
    await f.app.store.exclusive(
      (db) => db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n,
    ),
    0,
  );
  const owner = await f.register();
  const { circle } = await f.family(owner.cookie);
  assert.equal(owner.json.data.user.canCreateFamily, false);
  for (const [action, payload] of [
    ["circle.create", { type: "family", name: "不应创建" }],
    [
      " circle.create ",
      { type: "family", name: "重放", requestId: "setup-retry-request-001" },
    ],
    ["circle.create", { type: "classmate" }],
  ])
    assert.equal(
      (await f.rawRpc(owner.cookie, action, payload)).json.error.code,
      "FAMILY_CREATION_DISABLED",
    );
  assert.deepEqual(
    (await f.ok(owner.cookie, "circle.list")).circles.map((row) => row.id),
    [circle.id],
  );
});

test("one invitation can register only one account under concurrency and cannot be reused by another applicant", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const { circle } = await f.family(owner.cookie);
  const invite = (
    await f.ok(owner.cookie, "invite.create", { circleId: circle.id })
  ).invite;
  assert.equal(
    (await f.rpc(undefined, "invite.preview", { token: invite.token })).json
      .data.canRegister,
    true,
  );
  const results = await Promise.all(
    ["13812340001", "13812340002"].map((phone) =>
      f.request("/api/auth/register", {
        phone,
        password: PASSWORD,
        inviteToken: invite.token,
        remember: true,
      }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 403]);
  const newcomer = results.find((result) => result.status === 200);
  assert.equal(
    results.find((result) => result.status === 403).json.error.code,
    "INVITE_ASSIGNED",
  );
  const preview = (
    await f.rpc(undefined, "invite.preview", { token: invite.token })
  ).json.data;
  assert.equal(preview.status, "active");
  assert.equal(preview.canRegister, false);
  assert.equal(
    JSON.stringify(preview).includes(newcomer.json.data.user.phone),
    false,
  );
  assert.deepEqual((await f.ok(newcomer.cookie, "circle.list")).circles, []);
  await f.ok(newcomer.cookie, "account.profile.update", { patch: PROFILE });
  assert.equal(
    (
      await f.app.store.atomic((tx) =>
        tx.find("members", { userId: newcomer.json.data.user.id }),
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await f.app.store.atomic((tx) =>
        tx.find("persons", { claimedBy: newcomer.json.data.user.id }),
      )
    ).length,
    0,
  );
  const other = await f.register("13812340003");
  await f.ok(other.cookie, "account.profile.update", { patch: PROFILE });
  assert.equal(
    (await f.rawRpc(other.cookie, "invite.apply", { token: invite.token })).json
      .error.code,
    "INVITE_ASSIGNED",
  );
  // Legacy outstanding applications must not bypass the new binding at approval.
  const legacyApplication = await f.app.api.invoke(
    { action: "invite.apply", payload: { token: invite.token } },
    other.json.data.user.id,
  );
  assert.equal(legacyApplication.ok, true);
  assert.equal(
    (
      await f.rawRpc(owner.cookie, "join.approve", {
        circleId: circle.id,
        applicationId: legacyApplication.data.application.id,
        deferRelation: true,
      })
    ).json.error.code,
    "INVITE_ASSIGNED",
  );
  const application = (
    await f.ok(newcomer.cookie, "invite.apply", { token: invite.token })
  ).application;
  await f.ok(owner.cookie, "join.approve", {
    circleId: circle.id,
    applicationId: application.id,
    deferRelation: true,
  });
  assert.equal(
    (await f.ok(newcomer.cookie, "circle.list")).circles[0].id,
    circle.id,
  );
  assert.deepEqual((await f.ok(other.cookie, "circle.list")).circles, []);
  assert.equal(
    (
      await f.request("/api/auth/register", {
        phone: "13812340004",
        password: PASSWORD,
        inviteToken: invite.token,
      })
    ).status,
    403,
  );
});

test("registration rechecks invitation revocation after password hashing and never leaves a partial account", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const { circle } = await f.family(owner.cookie);
  const invite = (
    await f.ok(owner.cookie, "invite.create", { circleId: circle.id })
  ).invite;
  const original = f.app.auth.withPasswordWork.bind(f.app.auth);
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  f.app.auth.withPasswordWork = async (work) => {
    const result = await original(work);
    entered();
    await barrier;
    return result;
  };
  const pending = f.request("/api/auth/register", {
    phone: "13812340001",
    password: PASSWORD,
    inviteToken: invite.token,
  });
  await started;
  await f.ok(owner.cookie, "invite.revoke", {
    circleId: circle.id,
    inviteId: invite.id,
  });
  release();
  assert.equal((await pending).json.error.code, "INVITE_INACTIVE");
  assert.equal(
    await f.app.store.exclusive(
      (db) =>
        db
          .prepare("SELECT COUNT(*) AS n FROM accounts WHERE phone = ?")
          .get("+8613812340001").n,
    ),
    0,
  );
  assert.equal(
    await f.app.store.exclusive(
      (db) =>
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM invite_accounts WHERE invite_id = ?",
          )
          .get(invite.id).n,
    ),
    0,
  );
});

test("remembered browsers have absolute ninety-day expiry and private revocable device identifiers", async (t) => {
  let clock = Date.now();
  const f = await fixture(t, {}, { now: () => clock });
  const first = await f.register();
  await f.family(first.cookie);
  assert.match(first.headers.get("set-cookie"), /Max-Age=604800/);
  const remembered = await f.request(
    "/api/auth/login",
    { phone: "13812340000", password: PASSWORD, remember: true },
    undefined,
    { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0" } },
  );
  assert.match(remembered.headers.get("set-cookie"), /Max-Age=7776000/);
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13812340000",
        password: PASSWORD,
        remember: "true",
      })
    ).status,
    400,
  );
  const listed = (
    await f.request("/api/auth/sessions", undefined, remembered.cookie)
  ).json.data.sessions;
  assert.equal(listed.length, 2);
  const current = listed.find((session) => session.isCurrent);
  assert.deepEqual(
    Object.keys(current).sort(),
    [
      "id",
      "isCurrent",
      "deviceName",
      "createdAt",
      "lastSeenAt",
      "expiresAt",
    ].sort(),
  );
  assert.match(current.id, /^[a-f0-9-]{36}$/);
  assert.equal(current.deviceName, "Windows · Chrome");
  assert.equal(current.expiresAt - current.createdAt, 90 * 86400000);
  assert.equal(
    JSON.stringify(listed).includes(remembered.cookie.split("=")[1]),
    false,
  );
  const outsider = await f.register("13812340001");
  assert.equal(
    (
      await f.request(
        "/api/auth/sessions/revoke",
        { sessionId: current.id },
        outsider.cookie,
      )
    ).status,
    404,
  );
  clock += 7 * 86400000;
  assert.equal(
    (await f.request("/api/auth/me", undefined, first.cookie)).status,
    401,
  );
  assert.equal(
    (await f.request("/api/auth/me", undefined, remembered.cookie)).status,
    200,
  );
  await f.restart();
  const resumed = (
    await f.request("/api/auth/sessions", undefined, remembered.cookie)
  ).json.data.sessions.find((session) => session.isCurrent);
  assert.equal(resumed.id, current.id);
  assert.equal(
    resumed.expiresAt,
    current.expiresAt,
    "reading/restarting must not slide the absolute deadline",
  );
  clock = current.expiresAt;
  assert.equal(
    (await f.request("/api/auth/me", undefined, remembered.cookie)).status,
    401,
  );
});

test("a browser can revoke its other devices or itself without touching another account", async (t) => {
  const f = await fixture(t);
  const first = await f.register();
  const second = await f.request("/api/auth/login", {
    phone: "13812340000",
    password: PASSWORD,
    remember: true,
  });
  const third = await f.request("/api/auth/login", {
    phone: "13812340000",
    password: PASSWORD,
  });
  const outsider = await f.register("13812340001");
  const listed = (
    await f.request("/api/auth/sessions", undefined, second.cookie)
  ).json.data.sessions;
  const firstDevice = listed.find((session) => !session.isCurrent);
  assert.equal(
    (
      await f.request(
        "/api/auth/sessions/revoke",
        { sessionId: firstDevice.id },
        second.cookie,
      )
    ).json.data.currentRevoked,
    false,
  );
  assert.equal(
    (await f.request("/api/auth/sessions/revoke-others", {}, second.cookie))
      .json.data.revokedCount,
    1,
  );
  assert.equal(
    (await f.request("/api/auth/me", undefined, first.cookie)).status,
    401,
  );
  assert.equal(
    (await f.request("/api/auth/me", undefined, third.cookie)).status,
    401,
  );
  assert.equal(
    (await f.request("/api/auth/me", undefined, outsider.cookie)).status,
    200,
  );
  const ownId = (
    await f.request("/api/auth/sessions", undefined, second.cookie)
  ).json.data.sessions[0].id;
  const ended = await f.request(
    "/api/auth/sessions/revoke",
    { sessionId: ownId },
    second.cookie,
  );
  assert.equal(ended.json.data.currentRevoked, true);
  assert.match(ended.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal(
    (await f.request("/api/auth/me", undefined, second.cookie)).status,
    401,
  );
});

test("sensitive actions require a ten-minute password confirmation even for a remembered browser", async (t) => {
  let clock = Date.now();
  const f = await fixture(t, {}, { now: () => clock });
  const owner = await f.register();
  const member = await f.register("13812340001");
  const { circle } = await f.family(owner.cookie);
  await f.join(owner.cookie, member.cookie, circle.id);
  const target = (
    await f.ok(member.cookie, "member.list", { circleId: circle.id })
  ).members.find((row) => row.isSelf);
  const session = await f.request("/api/auth/login", {
    phone: "13812340000",
    password: PASSWORD,
    remember: true,
  });
  const payload = { circleId: circle.id, memberId: target.id, role: "admin" };
  assert.equal(
    (await f.rawRpc(session.cookie, "member.setRole", payload)).json.ok,
    true,
    "a freshly entered login password already satisfies the recent-password window",
  );
  clock += 10 * 60 * 1000;
  assert.equal(
    (await f.rawRpc(session.cookie, " member.setRole ", payload)).json.error
      .code,
    "REAUTH_REQUIRED",
  );
  assert.equal(
    (
      await f.request(
        "/api/auth/reauthenticate",
        { password: "wrong-password" },
        session.cookie,
      )
    ).json.error.code,
    "BAD_CREDENTIALS",
  );
  assert.equal(
    (await f.request("/api/auth/me", undefined, session.cookie)).status,
    200,
  );
  const verified = await f.request(
    "/api/auth/reauthenticate",
    { password: PASSWORD },
    session.cookie,
  );
  assert.equal(verified.json.data.reauthenticatedUntil, clock + 10 * 60 * 1000);
  assert.equal(
    (await f.rawRpc(session.cookie, "member.setRole", payload)).json.ok,
    true,
  );
  assert.equal(
    (
      await f.rawRpc(session.cookie, "member.setRole", {
        ...payload,
        role: "member",
      })
    ).json.ok,
    true,
  );
  assert.equal(
    (await f.rawRpc(owner.cookie, "member.setRole", payload)).json.error.code,
    "REAUTH_REQUIRED",
    "confirmation is browser-specific",
  );
  clock += 10 * 60 * 1000;
  assert.equal(
    (await f.rawRpc(session.cookie, "member.setRole", payload)).json.error.code,
    "REAUTH_REQUIRED",
  );
});

test("revoking a session after request admission still prevents the queued domain mutation", async (t) => {
  const f = await fixture(t);
  const first = await f.register();
  await f.family(first.cookie);
  const other = await f.request("/api/auth/login", {
    phone: "13812340000",
    password: PASSWORD,
  });
  const firstId = (
    await f.request("/api/auth/sessions", undefined, first.cookie)
  ).json.data.sessions.find((row) => row.isCurrent).id;
  const original = f.app.auth.current.bind(f.app.auth);
  let release,
    entered,
    intercept = true;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  f.app.auth.current = async (req) => {
    const current = await original(req);
    if (intercept && req.url === "/api/rpc") {
      intercept = false;
      entered();
      await barrier;
    }
    return current;
  };
  const pending = f.rawRpc(first.cookie, "account.profile.update", {
    patch: { bio: "撤销后不得保存" },
  });
  await started;
  assert.equal(
    (
      await f.request(
        "/api/auth/sessions/revoke",
        { sessionId: firstId },
        other.cookie,
      )
    ).status,
    200,
  );
  release();
  assert.equal((await pending).json.error.code, "UNAUTHENTICATED");
  assert.notEqual(
    (await f.ok(other.cookie, "account.profile.get")).profile.bio,
    "撤销后不得保存",
  );
});

test("revoking a session while a photo file is being read withholds the image bytes", async (t) => {
  const f = await fixture(t);
  const first = await f.register();
  await f.family(first.cookie);
  const other = await f.request("/api/auth/login", {
    phone: "13812340000",
    password: PASSWORD,
  });
  const jpeg = (
    await fs.readFile(
      path.resolve(__dirname, "../../backend/tests/fixtures/tiny.jpg"),
    )
  ).toString("base64");
  assert.equal(
    (await f.request("/api/photos", { base64: jpeg }, first.cookie)).json.ok,
    true,
  );
  const photoUrl = (await f.ok(first.cookie, "photo.url")).url;
  const firstId = (
    await f.request("/api/auth/sessions", undefined, first.cookie)
  ).json.data.sessions.find((row) => row.isCurrent).id;
  const original = fs.readFile;
  let release,
    entered,
    intercept = true;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  fs.readFile = async (file, ...args) => {
    const bytes = await original(file, ...args);
    if (
      intercept &&
      String(file).startsWith(f.directory) &&
      String(file).endsWith(".jpg")
    ) {
      intercept = false;
      entered();
      await barrier;
    }
    return bytes;
  };
  try {
    const pending = f.request(photoUrl, undefined, first.cookie);
    await started;
    assert.equal(
      (
        await f.request(
          "/api/auth/sessions/revoke",
          { sessionId: firstId },
          other.cookie,
        )
      ).status,
      200,
    );
    release();
    const denied = await pending;
    assert.equal(denied.status, 403);
    assert.equal(denied.json.ok, false);
    assert.equal(
      denied.headers.get("content-type").includes("image/jpeg"),
      false,
    );
  } finally {
    release();
    fs.readFile = original;
  }
});

test("legacy seven-day sessions gain opaque device metadata without extending expiry", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "kin-session-migration-"),
  );
  const db = new DatabaseSync(path.join(directory, "kin.sqlite"));
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const created = Date.now() - 1000;
  const expires = created + 7 * 86400000;
  db.exec(
    "CREATE TABLE accounts(id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);",
  );
  db.prepare("INSERT INTO accounts VALUES(?,?,?,?)").run(
    "legacy",
    "+8613812340000",
    await passwordHash(PASSWORD),
    created,
  );
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
    tokenHash,
    "legacy",
    expires,
    created,
  );
  db.close();
  const app = createApp({
    env: { DATA_DIR: directory, FRONTEND_ORIGIN: ORIGIN },
  });
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  assert.equal(
    (
      await app.api.invoke(
        {
          action: "circle.create",
          payload: { type: "family", mode: "private", name: "旧家庭" },
        },
        "legacy",
      )
    ).ok,
    true,
  );
  const current = await app.auth.current({
    headers: { cookie: `kin_session=${token}` },
  });
  assert.equal(current.user.id, "legacy");
  const rows = (await app.auth.sessions(current)).sessions;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].expiresAt, expires);
  assert.equal(rows[0].createdAt, created);
  assert.equal(rows[0].deviceName, "旧版浏览器");
  assert.equal(rows[0].isCurrent, true);
  assert.notEqual(rows[0].id, tokenHash);
});

test("trusted local setup is atomic, non-overwriting, and complete profiles create only already-approved self nodes", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "kin-local-setup-"),
  );
  const env = { DATA_DIR: directory, FRONTEND_ORIGIN: ORIGIN };
  const result = await setupFamily({
    env,
    phone: "13812340000",
    password: PASSWORD,
    familyName: "自己的家",
  });
  await assert.rejects(
    setupFamily({
      env,
      phone: "13812340001",
      password: PASSWORD,
      familyName: "不可覆盖",
    }),
    /空数据库/,
  );
  const app = createApp({ env });
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const address = await app.listen(0);
  const request = async (route, body, cookie) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    return {
      json: await response.json(),
      cookie: response.headers.getSetCookie()[0]?.split(";")[0],
    };
  };
  const signed = await request("/api/auth/login", {
    phone: "13812340000",
    password: PASSWORD,
  });
  const rpc = async (action, payload = {}) =>
    (await request("/api/rpc", { action, payload }, signed.cookie)).json;
  assert.equal(
    (await rpc("circle.detail", { circleId: result.familyId })).data.role,
    "owner",
  );
  assert.equal(
    (await rpc("person.list", { circleId: result.familyId })).data.persons
      .length,
    0,
  );
  assert.equal(
    (await rpc("account.profile.update", { patch: { name: "自己" } })).ok,
    true,
  );
  assert.equal(
    (await rpc("person.list", { circleId: result.familyId })).data.persons
      .length,
    0,
  );
  const duplicate = await app.api.invoke(
    {
      action: "person.create",
      payload: { circleId: result.familyId, ...PROFILE },
    },
    result.accountId,
  );
  assert.equal(duplicate.ok, true);
  const filled = await Promise.all(
    [1, 2].map(() => rpc("account.profile.update", { patch: PROFILE })),
  );
  assert.ok(filled.every((value) => value.ok));
  const people = (await rpc("person.list", { circleId: result.familyId })).data
    .persons;
  assert.equal(people.length, 2);
  assert.equal(people.filter((person) => person.isSelf).length, 1);
  assert.equal(
    people.find((person) => person.id === duplicate.data.person.id).isSelf,
    false,
    "same-name unclaimed records are not automatically claimed",
  );
  const member = (await rpc("member.list", { circleId: result.familyId })).data
    .members[0];
  const personId = member.personId;
  await app.store.atomic(async (tx) => {
    const row = await tx.get("members", member.id);
    delete row.personId;
    await tx.put("members", row);
  });
  await rpc("account.profile.update", { patch: { bio: "恢复旧成员指针" } });
  assert.equal(
    (await rpc("member.list", { circleId: result.familyId })).data.members[0]
      .personId,
    personId,
  );
  assert.equal(
    (await rpc("person.list", { circleId: result.familyId })).data.persons
      .length,
    2,
  );
  assert.equal(
    (await rpc("relation.list", { circleId: result.familyId })).data.relations
      .length,
    0,
  );
});

test("guest family reads expose chosen family profiles while excluding identities, remarks and every write path", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const outsider = await f.register("13812340001");
  const { circle, person } = await f.family(owner.cookie);
  await f.ok(owner.cookie, "account.profile.update", {
    patch: {
      phone: "13812349999",
      wechatId: "family-contact",
      bio: "最近在学画画",
      industry: "教育",
      occupation: "老师",
    },
  });
  await f.ok(owner.cookie, "person.create", {
    circleId: circle.id,
    ...PROFILE,
    name: "妈妈",
    phone: "13812340055",
    gender: "female",
    initialRelation: { anchorPersonId: person.id, kind: "newParent" },
  });
  await f.ok(owner.cookie, "person.remark.update", {
    circleId: circle.id,
    personId: person.id,
    remark: "不得透露的私人备注",
  });
  const before = await f.app.store.atomic(async (tx) => ({
    members: (await tx.find("members", {})).length,
    persons: (await tx.find("persons", {})).length,
  }));
  const entered = await f.request("/api/guest/enter", {
    familyName: ` ${circle.name} `,
  });
  assert.equal(entered.status, 200, JSON.stringify(entered.json));
  assert.match(
    entered.headers.get("set-cookie"),
    /^kin_guest=.*HttpOnly; SameSite=Lax; Max-Age=14400/,
  );
  const data = entered.json.data;
  assert.deepEqual(data.family, {
    id: circle.id,
    name: circle.name,
    type: "family",
    personCount: 2,
  });
  const readPerson = data.persons.find((row) => row.id === person.id);
  assert.equal(readPerson.phone, "13812349999");
  assert.equal(readPerson.wechatId, "family-contact");
  assert.deepEqual(readPerson.birthday, PROFILE.birthday);
  assert.equal(readPerson.bio, "最近在学画画");
  assert.equal(readPerson.industry, "教育");
  assert.equal(readPerson.occupation, "老师");
  const allowed = new Set([
    "id",
    "circleId",
    "name",
    "nickname",
    "gender",
    "birthOrder",
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
    "hasPhoto",
    "photoUrl",
    "hasMapLocation",
    "profileComplete",
    "isSelf",
  ]);
  for (const row of data.persons) {
    assert.equal(row.isSelf, false);
    assert.ok(Object.keys(row).every((key) => allowed.has(key)));
  }
  assert.equal(data.relations.length, 1);
  assert.ok(
    data.relations.every((row) =>
      Object.keys(row).every((key) =>
        ["id", "from", "to", "type", "olderId"].includes(key),
      ),
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(data),
    /不得透露|ownerId|claimedBy|createdBy|matchPhone|profileOverrides|userId|token_hash|password_hash/,
  );
  assert.equal(
    (await f.request("/api/guest/me", undefined, entered.cookie)).json.data
      .family.id,
    circle.id,
  );
  for (const route of ["/api/auth/me", "/api/auth/sessions", "/api/photos"])
    assert.equal(
      (await f.request(route, undefined, entered.cookie)).status,
      401,
      route,
    );
  assert.equal(
    (
      await f.request(
        "/api/auth/me",
        undefined,
        entered.cookie.replace("kin_guest=", "kin_session="),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request(
        "/api/guest/me",
        undefined,
        owner.cookie.replace("kin_session=", "kin_guest="),
      )
    ).status,
    401,
  );
  for (const action of [
    "person.list",
    "person.update",
    "person.create",
    "person.delete",
    "relation.replace",
    "circle.create",
    "invite.create",
    "member.setRole",
    "account.profile.update",
    "person.remark.update",
    "audit.list",
  ])
    assert.equal(
      (
        await f.rawRpc(entered.cookie, action, {
          circleId: circle.id,
          personId: person.id,
          patch: { name: "坏更改" },
        })
      ).status,
      401,
      action,
    );
  assert.equal(
    (await f.request("/api/photos", { base64: "invalid" }, entered.cookie))
      .status,
    401,
  );
  assert.equal(
    (
      await f.request(
        "/api/auth/reauthenticate",
        { password: PASSWORD },
        entered.cookie,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request(
        "/api/auth/password",
        { currentPassword: PASSWORD, newPassword: "ChangedPassword2026!" },
        entered.cookie,
      )
    ).status,
    401,
  );
  assert.equal(
    (await f.request("/api/auth/sessions/revoke-others", {}, entered.cookie))
      .status,
    401,
  );
  assert.equal(
    (
      await f.request(
        "/api/guest/family",
        { action: "person.update" },
        entered.cookie,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.rawRpc(`${outsider.cookie}; ${entered.cookie}`, "person.update", {
        circleId: circle.id,
        personId: person.id,
        patch: { name: "坏更改" },
      })
    ).json.error.code,
    "FORBIDDEN",
  );
  assert.deepEqual(
    await f.app.store.atomic(async (tx) => ({
      members: (await tx.find("members", {})).length,
      persons: (await tx.find("persons", {})).length,
    })),
    before,
  );
});

test("guest lookup requires a unique exact shared family name and never selects archived classmates or private records", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const { circle } = await f.family(owner.cookie);
  await f.app.store.atomic(async (tx) => {
    await tx.put("circles", {
      ...circle,
      id: "old-classmate",
      type: "classmate",
    });
    await tx.put("circles", {
      ...circle,
      id: "private-record",
      name: "私人资料",
      mode: "private",
    });
    await tx.put("circles", {
      ...circle,
      id: "old-class-only",
      name: "旧同学",
      type: "classmate",
    });
  });
  for (const name of ["不存在", "测试", "私人资料", "旧同学"])
    assert.equal(
      (await f.request("/api/guest/enter", { familyName: name })).json.error
        .code,
      "FAMILY_NOT_FOUND",
    );
  const entered = await f.request("/api/guest/enter", {
    familyName: circle.name,
  });
  assert.equal(entered.status, 200);
  await f.app.store.atomic((tx) =>
    tx.put("circles", { ...circle, id: "duplicate-family" }),
  );
  assert.equal(
    (await f.request("/api/guest/enter", { familyName: circle.name })).json
      .error.code,
    "FAMILY_NAME_AMBIGUOUS",
  );
  await f.app.store.atomic((tx) =>
    tx.put("circles", { ...circle, mode: "private" }),
  );
  assert.equal(
    (await f.request("/api/guest/family", undefined, entered.cookie)).status,
    401,
  );
  assert.equal(
    (
      await f.request(
        "/api/guest/me",
        undefined,
        `${entered.cookie}; ${entered.cookie}`,
      )
    ).status,
    401,
  );
});

test("guest profiles and avatars follow current account fields, administrator corrections and ended bindings", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const member = await f.register("13812340001");
  const unbound = await f.register("13812340002");
  const { circle } = await f.family(owner.cookie);
  await f.join(owner.cookie, member.cookie, circle.id);
  const row = (
    await f.ok(member.cookie, "member.list", { circleId: circle.id })
  ).members.find((value) => value.isSelf);
  await f.ok(member.cookie, "account.profile.update", {
    patch: { name: "本人最新姓名", bio: "本人近况", phone: "13812343333" },
  });
  await f.ok(owner.cookie, "person.update", {
    circleId: circle.id,
    personId: row.personId,
    patch: { name: "管理员核对姓名", bio: "家庭内核对" },
  });
  const guest = await f.request("/api/guest/enter", {
    familyName: circle.name,
  });
  const read = async () =>
    (
      await f.request("/api/guest/family", undefined, guest.cookie)
    ).json.data.persons.find((value) => value.id === row.personId);
  assert.equal((await read()).name, "管理员核对姓名");
  assert.equal((await read()).bio, "家庭内核对");
  await f.ok(member.cookie, "account.profile.update", {
    patch: { name: "本人再次修改", bio: "" },
  });
  assert.equal((await read()).name, "本人再次修改");
  assert.equal((await read()).bio, undefined);
  const jpeg = (
    await fs.readFile(
      path.resolve(__dirname, "../../backend/tests/fixtures/tiny.jpg"),
    )
  ).toString("base64");
  for (const cookie of [member.cookie, unbound.cookie])
    assert.equal(
      (await f.request("/api/photos", { base64: jpeg }, cookie)).json.ok,
      true,
    );
  let photo = await read();
  assert.equal(photo.hasPhoto, true);
  assert.match(photo.photoUrl, /^\/api\/guest\/photos\?personId=/);
  assert.equal(
    (await f.request(photo.photoUrl, undefined, guest.cookie)).status,
    200,
  );
  const firstPhotoUrl = photo.photoUrl;
  assert.equal(
    (
      await f.request(
        "/api/photos",
        { base64: jpeg, circleId: circle.id, personId: row.personId },
        owner.cookie,
      )
    ).json.ok,
    true,
  );
  photo = await read();
  assert.notEqual(photo.photoUrl, firstPhotoUrl);
  assert.equal(
    (await f.request(photo.photoUrl, undefined, guest.cookie)).status,
    200,
  );
  assert.equal(
    (await f.request("/api/guest/photos", undefined, guest.cookie)).status,
    400,
  );
  assert.equal(
    (
      await f.request(
        `/api/guest/photos?personId=${unbound.json.data.user.id}`,
        undefined,
        guest.cookie,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request(
        `/api/guest/photos?personId=${row.personId}&fileId=forged`,
        undefined,
        guest.cookie,
      )
    ).status,
    400,
  );
  const otherFamily = await f.family(unbound.cookie);
  assert.equal(
    (
      await f.request(
        `/api/guest/photos?personId=${otherFamily.person.id}`,
        undefined,
        guest.cookie,
      )
    ).status,
    404,
  );
  await f.ok(owner.cookie, "member.remove", {
    circleId: circle.id,
    memberId: row.id,
  });
  await f.ok(member.cookie, "account.profile.update", {
    patch: { name: "离开后私人的最新姓名", phone: "13812345555" },
  });
  assert.notEqual((await read())?.name, "离开后私人的最新姓名");
  assert.notEqual((await read())?.phone, "13812345555");
  assert.equal(
    (await f.request(photo.photoUrl, undefined, guest.cookie)).status,
    404,
  );
});

test("guest sessions expire absolutely, survive restart and enforce capacity without evicting visitors", async (t) => {
  let now = Date.UTC(2026, 9, 1);
  const f = await fixture(t, { guestSessionLimit: 1 }, { now: () => now });
  const owner = await f.register();
  const { circle } = await f.family(owner.cookie);
  const first = await f.request("/api/guest/enter", {
    familyName: circle.name,
  });
  assert.equal(first.json.data.expiresAt, now + 4 * 60 * 60 * 1000);
  assert.equal(
    (await f.request("/api/guest/enter", { familyName: circle.name })).json
      .error.code,
    "GUEST_BUSY",
  );
  assert.equal(
    (await f.request("/api/guest/me", undefined, first.cookie)).status,
    200,
  );
  const replacement = await f.request(
    "/api/guest/enter",
    { familyName: circle.name },
    first.cookie,
  );
  assert.equal(replacement.status, 200);
  assert.notEqual(replacement.cookie, first.cookie);
  assert.equal(
    (await f.request("/api/guest/me", undefined, first.cookie)).status,
    401,
  );
  const stored = await f.app.store.exclusive((db) =>
    db.prepare("SELECT * FROM guest_sessions").all(),
  );
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].token_hash, replacement.cookie.split("=")[1]);
  assert.deepEqual(Object.keys(stored[0]).sort(), [
    "circle_id",
    "created_at",
    "expires_at",
    "token_hash",
  ]);
  now += 3 * 60 * 60 * 1000;
  await f.restart();
  assert.equal(
    (await f.request("/api/guest/me", undefined, replacement.cookie)).json.data
      .expiresAt,
    replacement.json.data.expiresAt,
  );
  now += 60 * 60 * 1000;
  assert.equal(
    (await f.request("/api/guest/family", undefined, replacement.cookie))
      .status,
    401,
  );
  const next = await f.request("/api/guest/enter", { familyName: circle.name });
  assert.equal(next.status, 200);
  assert.equal(
    (
      await f.app.store.exclusive((db) =>
        db.prepare("SELECT COUNT(*) n FROM guest_sessions").get(),
      )
    ).n,
    1,
  );
  const logout = await f.request("/api/guest/logout", {}, next.cookie);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal(
    (
      await f.app.store.exclusive((db) =>
        db.prepare("SELECT COUNT(*) n FROM guest_sessions").get(),
      )
    ).n,
    0,
  );
  assert.equal(
    (await f.request("/api/guest/me", undefined, next.cookie)).status,
    401,
  );
});

test("failed guest name lookups count toward persistent IP limits and production cookies stay secure", async (t) => {
  let now = Date.UTC(2026, 9, 1);
  const f = await fixture(t, { guestIpLimit: 2 }, { now: () => now });
  assert.equal(
    (await f.request("/api/guest/enter", { familyName: "不存在" })).status,
    404,
  );
  await f.restart();
  assert.equal(
    (await f.request("/api/guest/enter", { familyName: "仍不存在" })).status,
    404,
  );
  assert.equal(
    (await f.request("/api/guest/enter", { familyName: "无关" })).json.error
      .code,
    "GUEST_RATE_LIMITED",
  );
  now += f.config.authWindow;
  assert.equal(
    (await f.request("/api/guest/enter", { familyName: "不存在" })).status,
    404,
  );
  assert.equal(
    (
      await f.request("/api/guest/enter", { familyName: "不存在" }, undefined, {
        headers: { Origin: "https://foreign.invalid" },
      })
    ).status,
    403,
  );
  const production = readConfig({
    NODE_ENV: "production",
    DATA_DIR: f.directory,
    FRONTEND_ORIGIN: "https://family.example.com",
  });
  const { Guests } = require("../guest.cjs");
  assert.match(
    new Guests(f.app.store, production).cookie("token"),
    /^__Host-kin_guest=token; Path=\/; HttpOnly; SameSite=Lax; Max-Age=14400; Secure$/,
  );
});

test("guest and account transitions cannot resurrect guest access or revoke unrelated account sessions", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const { circle } = await f.family(owner.cookie);
  const enter = async () =>
    f.request("/api/guest/enter", { familyName: circle.name });
  let guest = await enter();
  const login = await f.request(
    "/api/auth/login",
    { phone: "13812340000", password: PASSWORD },
    guest.cookie,
  );
  assert.equal(login.status, 200);
  assert.ok(
    login.headers
      .getSetCookie()
      .some(
        (value) =>
          value.startsWith("kin_guest=;") && value.includes("Max-Age=0"),
      ),
  );
  assert.equal(
    (await f.request("/api/guest/me", undefined, guest.cookie)).status,
    401,
  );
  guest = await enter();
  await f.request("/api/guest/logout", {}, `${login.cookie}; ${guest.cookie}`);
  assert.equal(
    (await f.request("/api/auth/me", undefined, login.cookie)).status,
    200,
  );
  assert.equal(
    (await f.request("/api/guest/me", undefined, guest.cookie)).status,
    401,
  );
  guest = await enter();
  const logout = await f.request(
    "/api/auth/logout",
    {},
    `${login.cookie}; ${guest.cookie}`,
  );
  assert.equal(
    logout.headers.getSetCookie().filter((value) => value.includes("Max-Age=0"))
      .length,
    2,
  );
  assert.equal(
    (await f.request("/api/auth/me", undefined, login.cookie)).status,
    401,
  );
  assert.equal(
    (await f.request("/api/guest/me", undefined, guest.cookie)).status,
    401,
  );
  guest = await enter();
  const registration = await f.request(
    "/api/auth/register",
    { phone: "13812340002", password: PASSWORD, inviteToken: await f.invite() },
    guest.cookie,
  );
  assert.equal(registration.status, 200);
  assert.equal(
    (await f.request("/api/guest/me", undefined, guest.cookie)).status,
    401,
  );
  assert.equal(
    (await f.request("/api/auth/me", undefined, owner.cookie)).status,
    200,
  );
});

test("ending guest access while a photograph is read withholds its bytes", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const { circle } = await f.family(owner.cookie);
  const jpeg = (
    await fs.readFile(
      path.resolve(__dirname, "../../backend/tests/fixtures/tiny.jpg"),
    )
  ).toString("base64");
  assert.equal(
    (await f.request("/api/photos", { base64: jpeg }, owner.cookie)).json.ok,
    true,
  );
  const guest = await f.request("/api/guest/enter", {
    familyName: circle.name,
  });
  const url = guest.json.data.persons[0].photoUrl;
  const original = fs.readFile;
  let release,
    entered,
    intercept = true;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  fs.readFile = async (file, ...args) => {
    const bytes = await original(file, ...args);
    if (
      intercept &&
      String(file).startsWith(f.directory) &&
      String(file).endsWith(".jpg")
    ) {
      intercept = false;
      entered();
      await barrier;
    }
    return bytes;
  };
  try {
    const pending = f.request(url, undefined, guest.cookie);
    await started;
    assert.equal(
      (await f.request("/api/guest/logout", {}, guest.cookie)).status,
      200,
    );
    release();
    const denied = await pending;
    assert.equal(denied.status, 401);
    assert.equal(
      denied.headers.get("content-type").includes("image/jpeg"),
      false,
    );
  } finally {
    release();
    fs.readFile = original;
  }
});

test("old uninvited accounts cannot sign in or reuse sessions but recover with a fresh invitation and their password", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const { circle } = await f.family(owner.cookie);
  const id = "old_uninvited_account";
  const password = await passwordHash(PASSWORD);
  const issueOld = () =>
    f.app.store.exclusive((db) =>
      f.app.auth.issue(db, id, undefined, { headers: {} }, true),
    );
  await f.app.store.exclusive((db) =>
    db
      .prepare("INSERT INTO accounts VALUES(?,?,?,?)")
      .run(id, "+8613812340060", password, Date.now()),
  );
  const stale = await issueOld();
  const oldCookie = `kin_session=${stale.token}`;
  const denied = await f.request("/api/auth/login", {
    phone: "13812340060",
    password: PASSWORD,
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, "ACCOUNT_NOT_INVITED");
  assert.ok(
    !denied.headers
      .getSetCookie()
      .some((cookie) => /^kin_session=[^;]/.test(cookie)),
  );
  assert.equal(
    (await f.request("/api/auth/me", undefined, oldCookie)).json.error.code,
    "ACCOUNT_NOT_INVITED",
  );
  assert.equal(
    (
      await f.app.store.exclusive((db) =>
        db
          .prepare("SELECT COUNT(*) n FROM sessions WHERE account_id=?")
          .get(id),
      )
    ).n,
    0,
  );
  assert.equal((await f.rawRpc(oldCookie, "account.profile.get")).status, 401);
  const invite = (
    await f.ok(owner.cookie, "invite.create", { circleId: circle.id })
  ).invite;
  assert.equal(
    (
      await f.request("/api/auth/register", {
        phone: "13812340060",
        password: PASSWORD,
        inviteToken: invite.token,
      })
    ).json.error.code,
    "ACCOUNT_EXISTS",
  );
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13812340060",
        password: "wrong",
        inviteToken: invite.token,
      })
    ).json.error.code,
    "BAD_CREDENTIALS",
  );
  assert.equal(
    (
      await f.app.store.exclusive((db) =>
        db
          .prepare("SELECT COUNT(*) n FROM invite_accounts WHERE invite_id=?")
          .get(invite.id),
      )
    ).n,
    0,
  );
  const unvisited = await issueOld();
  const restored = await f.request(
    "/api/auth/login",
    { phone: "13812340060", password: PASSWORD, inviteToken: invite.token },
    oldCookie,
  );
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal(restored.json.data.user.access, "invited");
  assert.deepEqual(restored.json.data.user.invitation, {
    id: invite.id,
    circleId: circle.id,
    circleName: circle.name,
    status: "profile-required",
    expiresAt: invite.expiresAt,
  });
  assert.equal(
    (
      await f.request(
        "/api/auth/me",
        undefined,
        `kin_session=${unvisited.token}`,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await f.app.store.exclusive((db) =>
        db
          .prepare("SELECT COUNT(*) n FROM sessions WHERE account_id=?")
          .get(id),
      )
    ).n,
    1,
  );
  await f.ok(restored.cookie, "account.profile.update", { patch: PROFILE });
  const application = (
    await f.ok(restored.cookie, "invite.apply", { token: invite.token })
  ).application;
  assert.equal(
    (await f.request("/api/auth/me", undefined, restored.cookie)).json.data.user
      .invitation.status,
    "pending",
  );
  assert.equal(
    (await f.rawRpc(restored.cookie, "person.list", { circleId: circle.id }))
      .json.error.code,
    "FORBIDDEN",
  );
  await f.ok(owner.cookie, "join.approve", {
    circleId: circle.id,
    applicationId: application.id,
    deferRelation: true,
  });
  assert.equal(
    (await f.request("/api/auth/me", undefined, restored.cookie)).json.data.user
      .access,
    "member",
  );
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13812340060",
        password: PASSWORD,
        inviteToken: invite.token,
      })
    ).status,
    200,
    "an active member may reopen their already-used invitation",
  );
});

test("pending invite qualification expires or is revoked/rejected while current members keep their independent access", async (t) => {
  let clock = Date.now();
  const f = await fixture(t, {}, { now: () => clock });
  const owner = await f.register();
  const { circle } = await f.family(owner.cookie);
  for (const [offset, operation] of [
    [1, "revoke"],
    [2, "reject"],
    [3, "expire"],
  ]) {
    const invite = (
      await f.ok(owner.cookie, "invite.create", { circleId: circle.id })
    ).invite;
    const phone = `1381234007${offset}`;
    const joined = await f.request("/api/auth/register", {
      phone,
      password: PASSWORD,
      inviteToken: invite.token,
      remember: true,
    });
    assert.equal(joined.json.data.user.access, "invited");
    await f.ok(joined.cookie, "account.profile.update", { patch: PROFILE });
    const application = (
      await f.ok(joined.cookie, "invite.apply", { token: invite.token })
    ).application;
    assert.equal(
      (await f.request("/api/auth/login", { phone, password: PASSWORD })).json
        .data.user.invitation.status,
      "pending",
    );
    if (operation === "revoke")
      await f.ok(owner.cookie, "invite.revoke", {
        circleId: circle.id,
        inviteId: invite.id,
      });
    if (operation === "reject")
      await f.ok(owner.cookie, "join.reject", {
        circleId: circle.id,
        applicationId: application.id,
      });
    if (operation === "expire") clock = invite.expiresAt;
    if (operation !== "expire")
      assert.equal(
        (
          await f.app.store.exclusive((db) =>
            db
              .prepare("SELECT COUNT(*) n FROM sessions WHERE account_id=?")
              .get(joined.json.data.user.id),
          )
        ).n,
        0,
        "revocations must commit, not roll back with an auth error",
      );
    const me = await f.request("/api/auth/me", undefined, joined.cookie);
    assert.ok([401, 403].includes(me.status));
    assert.equal(
      (await f.request("/api/auth/login", { phone, password: PASSWORD })).json
        .error.code,
      "ACCOUNT_NOT_INVITED",
    );
    assert.equal(
      (
        await f.app.store.exclusive((db) =>
          db
            .prepare("SELECT COUNT(*) n FROM sessions WHERE account_id=?")
            .get(joined.json.data.user.id),
        )
      ).n,
      0,
    );
    assert.equal(
      (await f.request("/api/auth/me", undefined, owner.cookie)).json.data.user
        .access,
      "member",
    );
  }
});

test("legacy pending family applications qualify without a binding but classmate-only memberships do not", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const { circle } = await f.family(owner.cookie);
  const invite = (
    await f.ok(owner.cookie, "invite.create", { circleId: circle.id })
  ).invite;
  const applicant = await f.request("/api/auth/register", {
    phone: "13812340081",
    password: PASSWORD,
    inviteToken: invite.token,
  });
  await f.ok(applicant.cookie, "account.profile.update", { patch: PROFILE });
  await f.ok(applicant.cookie, "invite.apply", { token: invite.token });
  await f.app.store.exclusive((db) =>
    db.prepare("DELETE FROM invite_accounts WHERE invite_id=?").run(invite.id),
  );
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13812340081",
        password: PASSWORD,
      })
    ).json.data.user.invitation.status,
    "pending",
  );
  await f.app.store.exclusive((db) =>
    db
      .prepare("INSERT INTO invite_accounts VALUES(?,?,?)")
      .run(invite.id, owner.json.data.user.id, Date.now()),
  );
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13812340081",
        password: PASSWORD,
      })
    ).json.error.code,
    "ACCOUNT_NOT_INVITED",
  );
  const outsider = await f.register("13812340082");
  await f.app.store.exclusive((db) =>
    db
      .prepare("DELETE FROM invite_accounts WHERE account_id=?")
      .run(outsider.json.data.user.id),
  );
  const oldApi = new ApiService(f.app.store);
  assert.equal(
    (
      await oldApi.invoke(
        {
          action: "circle.create",
          payload: {
            name: "旧同学",
            type: "classmate",
            mode: "shared",
            school: "测试学校",
            cohort: "2000",
            className: "一班",
          },
        },
        outsider.json.data.user.id,
      )
    ).ok,
    true,
  );
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13812340082",
        password: PASSWORD,
      })
    ).json.error.code,
    "ACCOUNT_NOT_INVITED",
  );
  assert.equal(
    (await f.request("/api/auth/me", undefined, outsider.cookie)).json.error
      .code,
    "ACCOUNT_NOT_INVITED",
  );
  const guest = await f.request(
    "/api/guest/enter",
    { familyName: circle.name },
    outsider.cookie,
  );
  assert.equal(
    guest.status,
    200,
    "ineligible account cookies do not block independent guest access",
  );
  assert.equal(
    (await f.rawRpc(outsider.cookie, "invite.preview", { token: invite.token }))
      .json.ok,
    true,
  );
  assert.equal(
    (await f.request("/api/auth/logout", {}, outsider.cookie)).status,
    200,
  );
});

test("removal invalidates prior unused invitations and sessions; only a newer invitation restores the account", async (t) => {
  let clock = Date.now();
  const f = await fixture(t, {}, { now: () => clock });
  const owner = await f.register();
  const { circle } = await f.family(owner.cookie);
  const firstInvite = (
    await f.ok(owner.cookie, "invite.create", { circleId: circle.id })
  ).invite;
  const member = await f.request("/api/auth/register", {
    phone: "13812340083",
    password: PASSWORD,
    inviteToken: firstInvite.token,
  });
  await f.join(owner.cookie, member.cookie, circle.id);
  const row = (
    await f.ok(member.cookie, "member.list", { circleId: circle.id })
  ).members.find((value) => value.isSelf);
  const oldSecondDevice = await f.request("/api/auth/login", {
    phone: "13812340083",
    password: PASSWORD,
    remember: true,
  });
  clock += 1;
  await f.ok(owner.cookie, "member.remove", {
    circleId: circle.id,
    memberId: row.id,
  });
  assert.equal(
    (
      await f.app.store.exclusive((db) =>
        db
          .prepare("SELECT COUNT(*) n FROM sessions WHERE account_id=?")
          .get(member.json.data.user.id),
      )
    ).n,
    0,
  );
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13812340083",
        password: PASSWORD,
      })
    ).json.error.code,
    "ACCOUNT_NOT_INVITED",
  );
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13812340083",
        password: PASSWORD,
        inviteToken: firstInvite.token,
      })
    ).json.error.code,
    "INVITE_INACTIVE",
  );
  clock += 1;
  const fresh = (
    await f.ok(owner.cookie, "invite.create", { circleId: circle.id })
  ).invite;
  const restored = await f.request(
    "/api/auth/login",
    { phone: "13812340083", password: PASSWORD, inviteToken: fresh.token },
    member.cookie,
  );
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal(restored.json.data.user.access, "invited");
  assert.equal(
    (await f.request("/api/auth/me", undefined, oldSecondDevice.cookie)).status,
    401,
  );
  const application = (
    await f.ok(restored.cookie, "invite.apply", { token: fresh.token })
  ).application;
  await f.ok(owner.cookie, "join.approve", {
    circleId: circle.id,
    applicationId: application.id,
    deferRelation: true,
  });
  assert.equal(
    (await f.request("/api/auth/me", undefined, restored.cookie)).json.data.user
      .access,
    "member",
  );
  await f.ok(restored.cookie, "member.leave", { circleId: circle.id });
  assert.equal(
    (await f.request("/api/auth/me", undefined, restored.cookie)).status,
    401,
  );
});

test("invite revocation after HTTP admission blocks a queued global-profile edit and commits session revocation", async (t) => {
  const f = await fixture(t);
  const owner = await f.register();
  const { circle } = await f.family(owner.cookie);
  const invite = (
    await f.ok(owner.cookie, "invite.create", { circleId: circle.id })
  ).invite;
  const applicant = await f.request("/api/auth/register", {
    phone: "13812340084",
    password: PASSWORD,
    inviteToken: invite.token,
  });
  const original = f.app.auth.current.bind(f.app.auth);
  let entered,
    release,
    intercept = true;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  f.app.auth.current = async (req) => {
    const current = await original(req);
    if (
      intercept &&
      req.url === "/api/rpc" &&
      req.headers.cookie === applicant.cookie
    ) {
      intercept = false;
      entered();
      await barrier;
    }
    return current;
  };
  try {
    const pending = f.rawRpc(applicant.cookie, "account.profile.update", {
      patch: PROFILE,
    });
    await started;
    await f.ok(owner.cookie, "invite.revoke", {
      circleId: circle.id,
      inviteId: invite.id,
    });
    release();
    const result = await pending;
    assert.equal(result.json.ok, false);
    assert.ok(
      ["UNAUTHENTICATED", "ACCOUNT_NOT_INVITED"].includes(
        result.json.error.code,
      ),
    );
    assert.equal(
      (
        await f.app.store.atomic((tx) =>
          tx.find("userProfiles", { userId: applicant.json.data.user.id }),
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await f.app.store.exclusive((db) =>
          db
            .prepare("SELECT COUNT(*) n FROM sessions WHERE account_id=?")
            .get(applicant.json.data.user.id),
        )
      ).n,
      0,
    );
  } finally {
    release();
    f.app.auth.current = original;
  }
});

test("expiry during a profile-photo read withholds the bytes and removes every old account session", async (t) => {
  let clock = Date.now();
  const f = await fixture(t, {}, { now: () => clock });
  const owner = await f.register();
  const { circle } = await f.family(owner.cookie);
  const invite = (
    await f.ok(owner.cookie, "invite.create", { circleId: circle.id })
  ).invite;
  const applicant = await f.request("/api/auth/register", {
    phone: "13812340085",
    password: PASSWORD,
    inviteToken: invite.token,
    remember: true,
  });
  const jpeg = (
    await fs.readFile(
      path.resolve(__dirname, "../../backend/tests/fixtures/tiny.jpg"),
    )
  ).toString("base64");
  assert.equal(
    (await f.request("/api/photos", { base64: jpeg }, applicant.cookie)).json
      .ok,
    true,
  );
  const url = (await f.ok(applicant.cookie, "photo.url")).url;
  const original = fs.readFile;
  let entered,
    release,
    intercept = true;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  fs.readFile = async (file, ...args) => {
    const bytes = await original(file, ...args);
    if (
      intercept &&
      String(file).startsWith(f.directory) &&
      String(file).endsWith(".jpg")
    ) {
      intercept = false;
      entered();
      await barrier;
    }
    return bytes;
  };
  try {
    const pending = f.request(url, undefined, applicant.cookie);
    await started;
    clock = invite.expiresAt;
    release();
    const denied = await pending;
    assert.equal(denied.status, 403);
    assert.equal(
      denied.headers.get("content-type").includes("image/jpeg"),
      false,
    );
    assert.equal(
      (
        await f.app.store.exclusive((db) =>
          db
            .prepare("SELECT COUNT(*) n FROM sessions WHERE account_id=?")
            .get(applicant.json.data.user.id),
        )
      ).n,
      0,
    );
  } finally {
    release();
    fs.readFile = original;
  }
});

test("explicit demo seed is repeatable, separated from production, and never replaces accounts", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kin-seed-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const result = await seed({ DATA_DIR: directory });
  assert.deepEqual(await seed({ DATA_DIR: directory }), result);
  await assert.rejects(
    seed({ NODE_ENV: "production", DATA_DIR: directory }),
    /生产环境/,
  );
  const app = createApp({ env: { DATA_DIR: directory } });
  try {
    const family = await app.store.atomic((tx) =>
      tx.find("persons", { circleId: result.familyId }),
    );
    assert.equal(family.length, 7);
    assert.equal(result.classmateId, undefined);
    assert.deepEqual(
      (await app.store.atomic((tx) => tx.find("circles", {}))).map(
        (circle) => circle.type,
      ),
      ["family"],
    );
    const familyRelations = await app.store.atomic((tx) =>
      tx.find("relations", { circleId: result.familyId }),
    );
    const ts = require("typescript");
    const kinship = {};
    const source = await fs.readFile(
      path.resolve(__dirname, "../../packages/kinship/src/index.ts"),
      "utf8",
    );
    new Function(
      "exports",
      ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
    )(kinship);
    const sister = family.find((person) => person.name === "李悦");
    const relations = familyRelations.map((relation) =>
      relation.type === "parent"
        ? {
            type: "parent_child",
            parentId: relation.from,
            childId: relation.to,
          }
        : {
            type: relation.type,
            personAId: relation.from,
            personBId: relation.to,
          },
    );
    for (const parentName of ["李建国", "王芳"]) {
      const parent = family.find((person) => person.name === parentName);
      const relationship = kinship.resolveKinship({
        people: family.map(({ id, name, gender }) => ({ id, name, gender })),
        relations,
        perspectiveId: parent.id,
        targetId: sister.id,
      });
      assert.equal(relationship.status, "resolved");
      assert.equal(relationship.term, "女儿");
      assert.equal(relationship.path.steps.length, 1);
    }
    assert.equal(
      (await app.store.atomic((tx) => tx.find("phoneIdentities", {}))).length,
      0,
    );
    assert.equal(
      (
        await app.store.atomic((tx) =>
          tx.find("members", { circleId: result.familyId, role: "member" }),
        )
      ).length,
      1,
    );
  } finally {
    await app.close();
  }
  const occupied = await fixture(t);
  await occupied.register();
  await assert.rejects(seed({ DATA_DIR: occupied.directory }), /空数据库/);
});

test("default guest guessing limit is atomic under concurrent names and cannot be reset by cookies or restart", async (t) => {
  let now = Date.UTC(2026, 9, 4);
  const f = await fixture(t, {}, { now: () => now });
  const batch = await Promise.all(
    Array.from({ length: 60 }, (_, i) =>
      f.request(
        "/api/guest/enter",
        { familyName: `不存在的家庭${i}` },
        `kin_guest=${"x".repeat(43)}`,
        { headers: { "X-Forwarded-For": `198.51.100.${i + 1}` } },
      ),
    ),
  );
  assert.equal(batch.filter((r) => r.status === 404).length, 30);
  assert.equal(batch.filter((r) => r.status === 429).length, 30);
  assert.equal(
    (
      await f.app.store.exclusive((db) =>
        db.prepare("SELECT COUNT(*) n FROM guest_sessions").get(),
      )
    ).n,
    0,
  );
  now += 31_000;
  await f.restart();
  const blocked = await f.request("/api/guest/enter", {
    familyName: "换一个家庭名称",
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "869");
  assert.equal(blocked.json.error.retryAfterSeconds, 869);
  now += 869_000;
  assert.equal(
    (await f.request("/api/guest/enter", { familyName: "不存在" })).status,
    404,
  );
});

test("password guesses share one canonical phone bucket under concurrency and expiry is precise", async (t) => {
  let now = Date.UTC(2026, 9, 4);
  const f = await fixture(t, { authPhoneLimit: 3 }, { now: () => now });
  const forms = ["13812340000", "+8613812340000", "138 1234 0000"];
  const replies = await Promise.all(
    Array.from({ length: 18 }, (_, i) =>
      f.request(
        "/api/auth/login",
        { phone: forms[i % 3], password: "WrongPassword2026!" },
        undefined,
        { headers: { "X-Forwarded-For": `198.51.100.${i + 1}` } },
      ),
    ),
  );
  assert.equal(replies.filter((r) => r.status === 401).length, 3);
  assert.equal(replies.filter((r) => r.status === 429).length, 15);
  assert.equal(
    replies.some((r) => r.cookie),
    false,
  );
  now += 123_000;
  await f.restart();
  const blocked = await f.request("/api/auth/login", {
    phone: forms[0],
    password: PASSWORD,
  });
  assert.equal(blocked.json.error.retryAfterSeconds, 777);
  assert.equal(blocked.headers.get("retry-after"), "777");
  assert.equal(
    blocked.headers.get("access-control-expose-headers"),
    "Retry-After",
  );
  now += 777_000;
  assert.equal(
    (await f.request("/api/auth/login", { phone: forms[1], password: "wrong" }))
      .status,
    401,
  );
});

test("default phone and IP budgets are shared by registration and login before expensive password work", async (t) => {
  const defaults = readConfig({});
  const f = await fixture(t, {
    authPhoneLimit: defaults.authPhoneLimit,
    authIpLimit: defaults.authIpLimit,
  });
  for (let i = 0; i < 12; i++)
    assert.equal(
      (
        await f.request("/api/auth/register", {
          phone: "13812340000",
          password: PASSWORD,
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13812340000",
        password: PASSWORD,
      })
    ).status,
    429,
  );
  for (let i = 0; i < 38; i++)
    assert.equal(
      (
        await f.request("/api/auth/register", {
          phone: `1391234${String(i).padStart(4, "0")}`,
          password: PASSWORD,
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13999999999",
        password: PASSWORD,
      })
    ).status,
    429,
  );
  assert.equal(f.app.auth.hashesInFlight, 0);
});

test("hash concurrency rejects excess work briefly and always releases capacity", async (t) => {
  const f = await fixture(t);
  const releases = [];
  const pending = Array.from({ length: 4 }, () =>
    f.app.auth.withPasswordWork(
      () => new Promise((resolve) => releases.push(resolve)),
    ),
  );
  try {
    const blocked = await f.request("/api/auth/login", {
      phone: "13812340000",
      password: "wrong",
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "2");
    assert.equal(blocked.json.error.retryAfterSeconds, 2);
  } finally {
    releases.forEach((resolve) => resolve());
    await Promise.all(pending);
  }
  assert.equal(f.app.auth.hashesInFlight, 0);
  await assert.rejects(
    f.app.auth.withPasswordWork(() =>
      Promise.reject(new Error("test failure")),
    ),
  );
  assert.equal(f.app.auth.hashesInFlight, 0);
  assert.equal(
    (
      await f.request("/api/auth/login", {
        phone: "13812340000",
        password: "wrong",
      })
    ).status,
    401,
  );
});
