const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const subject = { exports: {} };
new Function("module", "exports", ts.transpileModule(
  fs.readFileSync(require.resolve("./home-welcome.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText)(subject, subject.exports);
const { createWelcomeGate } = subject.exports;

test("greeting plays once across navigation/reload but is available in a fresh tab", () => {
  const values = new Map();
  const storage = () => ({ getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) });
  const first = createWelcomeGate(storage);
  assert.equal(first(""), false);
  assert.equal(first("family-a"), true);
  assert.equal(first("family-a"), false);
  assert.equal(createWelcomeGate(storage)("family-a"), false);
  assert.equal(first("family-b"), true);
  assert.deepEqual([...values.values()], ["1", "1"]);
  assert.equal(createWelcomeGate(() => ({ getItem: () => null, setItem() {} }))("family-a"), true);
});

test("blocked reads or writes never break home and still avoid repeated greetings in memory", () => {
  for (const storage of [
    () => { throw Error("storage disabled"); },
    () => ({ getItem: () => null, setItem() { throw Error("quota"); } }),
  ]) {
    const welcome = createWelcomeGate(storage);
    assert.equal(welcome("family-a"), true);
    assert.equal(welcome("family-a"), false);
  }
});
