const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const path = require("node:path");
const mod = { exports: {} };
new Function(
  "exports",
  ts.transpileModule(
    fs.readFileSync(path.join(__dirname, "retry.ts"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText,
)(mod.exports);
const { retryDelay, retryRemaining, retryLabel } = mod.exports;
test("server cooldown uses remaining seconds, expires exactly, and never extends on re-render", () => {
  const end = 1000 + retryDelay(777) * 1000;
  assert.equal(retryRemaining(end, 1000), 777);
  assert.equal(retryRemaining(end, 777001), 1);
  assert.equal(retryRemaining(end, 778000), 0);
  assert.equal(retryRemaining(end, 800000), 0);
  assert.equal(retryLabel(777), "12:57 后可重试");
  assert.equal(retryLabel(2), "0:02 后可重试");
});
test("malformed proxy cooldowns fall back safely and busy responses stay short", () => {
  for (const value of [undefined, null, "", 0, -1, NaN, Infinity, "tomorrow"])
    assert.equal(retryDelay(value), 900);
  assert.equal(retryDelay("2"), 2);
  assert.equal(retryDelay(2.3), 3);
  assert.equal(retryDelay(10 ** 8), 86400);
});
