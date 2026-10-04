const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const retry = { exports: {} };
new Function(
  "exports",
  ts.transpileModule(fs.readFileSync(require.resolve("./retry.ts"), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
)(retry.exports);
const compiled = ts.transpileModule(
  fs
    .readFileSync(require.resolve("../api.ts"), "utf8")
    .replace("import.meta.env.VITE_API_BASE_URL", '""'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
function apiHarness() {
  const requests = [],
    events = [],
    eventDetails = [],
    subject = { exports: {} };
  const fetch = (url, options) =>
    new Promise((resolve) => requests.push({ url, options, resolve }));
  new Function("module", "exports", "fetch", "window", "require", compiled)(
    subject,
    subject.exports,
    fetch,
    {
      dispatchEvent: (event) => {
        events.push(event.type);
        eventDetails.push(event.detail);
      },
    },
    (name) => {
      assert.equal(name, "./shared/retry");
      return retry.exports;
    },
  );
  return { ...subject.exports, requests, events, eventDetails };
}
const response = (data) => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, data }),
});
const expired = () => ({
  ok: false,
  status: 401,
  json: async () => ({ ok: false, error: { code: "GUEST_SESSION_EXPIRED" } }),
});
const family = (id) => ({
  family: { id, name: id, type: "family", personCount: 0 },
  persons: [],
  relations: [],
  expiresAt: 9999999999999,
});

test("rate-limit responses preserve exact cooldown without logging out, including proxy HTML responses", async () => {
  for (const html of [false, true]) {
    const { auth, requests, events } = apiHarness();
    const pending = auth.login("13812340000", "WrongPassword2026!");
    requests[0].resolve({
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "7" }),
      json: async () => {
        if (html) throw new SyntaxError("HTML from proxy");
        return {
          ok: false,
          error: {
            code: "RATE_LIMITED",
            message: "稍后再试",
            retryAfterSeconds: 3,
          },
        };
      },
    });
    await assert.rejects(
      pending,
      (error) =>
        error.code === "RATE_LIMITED" &&
        error.retryAfterSeconds === (html ? 7 : 3),
    );
    assert.deepEqual(events, []);
  }
});

test("a delayed guest expiry from the old family does not clear the newly entered family", async () => {
  const { guest, requests, events } = apiHarness();
  const old = guest.family();
  const next = guest.enter("乙家");
  requests[1].resolve(response(family("family-b")));
  assert.equal((await next).family.id, "family-b");
  requests[0].resolve(expired());
  await assert.rejects(old, { code: "GUEST_SESSION_EXPIRED" });
  assert.deepEqual(events, []);
  const current = guest.family();
  requests[2].resolve(expired());
  await assert.rejects(current, { code: "GUEST_SESSION_EXPIRED" });
  assert.deepEqual(events, ["guest-session-expired"]);
});

test("a delayed successful old guest snapshot cannot replace the current family", async () => {
  const { guest, requests } = apiHarness();
  const old = guest.family();
  const next = guest.enter("乙家");
  requests[1].resolve(response(family("family-b")));
  await next;
  requests[0].resolve(response(family("family-a")));
  await assert.rejects(old, { code: "STALE_GUEST_REQUEST" });
});

test("account login and guest exit invalidate outstanding guest reads", async () => {
  for (const action of ["login", "exit"]) {
    const { guest, auth, requests, events } = apiHarness();
    const old = guest.family();
    const transition =
      action === "login"
        ? auth.login("13800000001", "example-password")
        : guest.logout();
    requests[1].resolve(response({ user: { id: "account" } }));
    await transition;
    requests[0].resolve(expired());
    await assert.rejects(old, { code: "GUEST_SESSION_EXPIRED" });
    assert.deepEqual(events, []);
  }
});

test("a management RPC role denial requests current roles without logging out or hiding its error", async () => {
  const { rpc, requests, events } = apiHarness();
  const operation = rpc("invite.create", { circleId: "family-a" });
  requests[0].resolve({
    ok: true,
    status: 200,
    json: async () => ({
      ok: false,
      error: { code: "FORBIDDEN", message: "仅管理员可以邀请家人" },
    }),
  });
  await assert.rejects(operation, {
    code: "FORBIDDEN",
    message: "仅管理员可以邀请家人",
  });
  assert.deepEqual(events, ["permissions-stale"]);
});

test("existing accounts can pass the original invitation when logging in and receive invited access", async () => {
  const { auth, requests } = apiHarness();
  const token = "a-valid-original-invitation-token";
  const attempt = auth.login("13800000001", "original-password", true, token);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    phone: "13800000001",
    password: "original-password",
    remember: true,
    inviteToken: token,
  });
  const user = {
    id: "old-account",
    access: "invited",
    invitation: {
      id: "invite-id",
      circleId: "family-a",
      circleName: "张家",
      status: "profile-required",
      expiresAt: 9999999999999,
    },
  };
  requests[0].resolve(response({ user }));
  assert.deepEqual((await attempt).user, user);
  const normal = auth.login("13800000001", "original-password");
  assert.equal("inviteToken" in JSON.parse(requests[1].options.body), false);
  requests[1].resolve(response({ user: { ...user, access: "member" } }));
  assert.equal((await normal).user.access, "member");
});

test("an ineligible account fails login with its message and invalidates any former account state", async () => {
  const { auth, requests, events, eventDetails } = apiHarness();
  const attempt = auth.login("13800000001", "original-password");
  requests[0].resolve({
    ok: false,
    status: 403,
    json: async () => ({
      ok: false,
      error: {
        code: "ACCOUNT_NOT_INVITED",
        message: "请通过管理员邀请加入后再登录。",
      },
    }),
  });
  await assert.rejects(attempt, {
    code: "ACCOUNT_NOT_INVITED",
    message: "请通过管理员邀请加入后再登录。",
  });
  assert.deepEqual(events, ["session-expired"]);
  assert.equal(eventDetails[0].code, "ACCOUNT_NOT_INVITED");
});

test("lost eligibility also ends a session when a guarded RPC returns its error in HTTP 200", async () => {
  const { rpc, requests, events } = apiHarness();
  const operation = rpc("account.profile.get");
  requests[0].resolve({
    ok: true,
    status: 200,
    json: async () => ({
      ok: false,
      error: {
        code: "ACCOUNT_NOT_INVITED",
        message: "邀请已失效，请联系管理员重新邀请。",
      },
    }),
  });
  await assert.rejects(operation, { code: "ACCOUNT_NOT_INVITED" });
  assert.deepEqual(events, ["session-expired"]);
});

test("bad credentials and ordinary role denials retain the login or current account for correction", async () => {
  for (const code of ["BAD_CREDENTIALS", "FORBIDDEN"]) {
    const { auth, requests, events } = apiHarness();
    const attempt = auth.login("13800000001", "incorrect-password");
    requests[0].resolve({
      ok: false,
      status: code === "BAD_CREDENTIALS" ? 401 : 403,
      json: async () => ({ ok: false, error: { code } }),
    });
    await assert.rejects(attempt, { code });
    assert.deepEqual(events, code === "FORBIDDEN" ? ["permissions-stale"] : []);
  }
});

test("a delayed denial from a former account cannot dismiss a new invited login", async () => {
  const { auth, rpc, requests, events } = apiHarness();
  const old = rpc("account.profile.get");
  const next = auth.login(
    "13800000002",
    "original-password",
    false,
    "original-invitation",
  );
  requests[1].resolve(
    response({ user: { id: "new-account", access: "invited" } }),
  );
  await next;
  requests[0].resolve({
    ok: false,
    status: 403,
    json: async () => ({ ok: false, error: { code: "ACCOUNT_NOT_INVITED" } }),
  });
  await assert.rejects(old, { code: "ACCOUNT_NOT_INVITED" });
  assert.deepEqual(events, []);
});
