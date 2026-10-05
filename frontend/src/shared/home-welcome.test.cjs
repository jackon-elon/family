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

test("home and family pages share one greeting per document, while reload creates a fresh greeting", () => {
  const page = createWelcomeGate();
  assert.equal(page(""), false);
  assert.equal(page("family-a"), true);
  assert.equal(page("family-a"), false, "SPA return to home must not repeat");
  assert.equal(createWelcomeGate()("family-a"), true, "full reload must play again");
  assert.equal(page("family-b"), true);
});

test("entry greeting requires no browser storage or credentials", () => {
  const page = createWelcomeGate();
  assert.equal(page("family-a"), true);
  assert.equal(page("family-a"), false);
});
