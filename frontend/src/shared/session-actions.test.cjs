const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const compiled = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, "session-actions.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const subject = { exports: {} };
new Function("module", "exports", compiled)(subject, subject.exports);
const { performSensitiveAction, inviteTokenFromPath, createPermissionRefresh } =
  subject.exports;

test("ordinary successful actions do not ask for a password", async () => {
  let operations = 0,
    confirmations = 0;
  assert.equal(
    await performSensitiveAction(
      async () => {
        operations++;
      },
      async () => {
        confirmations++;
        return true;
      },
    ),
    true,
  );
  assert.equal(operations, 1);
  assert.equal(confirmations, 0);
});

test("reauthentication resumes exactly the original operation once", async () => {
  const target = { memberId: "relative-b", role: "admin" };
  const requests = [];
  let confirmations = 0;
  const completed = await performSensitiveAction(
    async () => {
      requests.push(target);
      if (requests.length === 1) throw { code: "REAUTH_REQUIRED" };
    },
    async () => {
      confirmations++;
      return true;
    },
  );
  assert.equal(completed, true);
  assert.equal(confirmations, 1);
  assert.deepEqual(requests, [target, target]);
});

test("cancelling password confirmation does not execute the pending change", async () => {
  let operations = 0;
  const completed = await performSensitiveAction(
    async () => {
      operations++;
      throw { code: "REAUTH_REQUIRED" };
    },
    async () => false,
  );
  assert.equal(completed, false);
  assert.equal(operations, 1);
});

test("network or permission errors are not retried as sensitive operations", async () => {
  for (const code of ["NETWORK", "FORBIDDEN", "UNAUTHENTICATED"]) {
    let confirmations = 0,
      operations = 0;
    const original = Object.assign(new Error(code), { code });
    await assert.rejects(
      performSensitiveAction(
        async () => {
          operations++;
          throw original;
        },
        async () => {
          confirmations++;
          return true;
        },
      ),
      (error) => error === original,
    );
    assert.equal(operations, 1);
    assert.equal(confirmations, 0);
  }
});

test("a retry that still needs confirmation fails instead of looping", async () => {
  let operations = 0,
    confirmations = 0;
  await assert.rejects(
    performSensitiveAction(
      async () => {
        operations++;
        throw { code: "REAUTH_REQUIRED" };
      },
      async () => {
        confirmations++;
        return true;
      },
    ),
    (error) => error.code === "REAUTH_REQUIRED",
  );
  assert.equal(operations, 2);
  assert.equal(confirmations, 1);
});

test("registration uses only a complete invitation route and safely rejects malformed paths", () => {
  assert.equal(inviteTokenFromPath("/invite/family-token"), "family-token");
  assert.equal(inviteTokenFromPath("/invite/family-token/"), "family-token");
  for (const pathname of ["/", "/me", "/invite/", "/invite/a/b", "/invite/%"])
    assert.equal(inviteTokenFromPath(pathname), null);
});

test("concurrent role denials share one permission refresh and a later denial can refresh again", async () => {
  let calls = 0,
    finish;
  const refresh = createPermissionRefresh(
    () => "account-a",
    () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  const first = refresh(),
    second = refresh(),
    third = refresh();
  assert.equal(first, second);
  assert.equal(first, third);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish();
  await first;
  const later = refresh();
  await Promise.resolve();
  assert.equal(calls, 2);
  finish();
  await later;
});

test("a failed role refresh does not leave permission checks permanently locked", async () => {
  let calls = 0;
  const refresh = createPermissionRefresh(
    () => "account-a",
    async () => {
      calls++;
      if (calls === 1) throw Error("Network temporarily unavailable");
    },
  );
  await refresh();
  await refresh();
  assert.equal(calls, 2);
});

test("changing accounts cannot let an old permission refresh block or clear the new account refresh", async () => {
  let account = "account-a";
  const pending = [];
  const refresh = createPermissionRefresh(
    () => account,
    () => new Promise((resolve) => pending.push(resolve)),
  );
  const old = refresh();
  await Promise.resolve();
  account = "account-b";
  const current = refresh();
  await Promise.resolve();
  assert.equal(pending.length, 2);
  pending[0]();
  await old;
  assert.equal(refresh(), current);
  pending[1]();
  await current;
  account = undefined;
  await refresh();
  assert.equal(pending.length, 2);
});
