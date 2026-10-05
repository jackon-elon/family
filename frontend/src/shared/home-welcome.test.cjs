const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const subject = { exports: {} };
new Function("module", "exports", ts.transpileModule(
  fs.readFileSync(require.resolve("./home-welcome.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText)(subject, subject.exports);
const { createWelcomeTimer, WELCOME_DURATION_MS } = subject.exports;

function fixture() {
  let now = 0, id = 0, completions = 0;
  const tasks = new Map();
  const clock = {
    now: () => now,
    schedule(callback, delay) { tasks.set(++id, { at: now + delay, callback }); return id; },
    cancel(id) { tasks.delete(id); },
  };
  const timer = createWelcomeTimer(() => completions++, clock);
  return {
    timer,
    get completions() { return completions; },
    get pending() { return tasks.size; },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const due = [...tasks].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        tasks.delete(due[0]); now = due[1].at; due[1].callback();
      }
      now = end;
    },
  };
}

test("entry starts immediately without identity or family data, and ends after three seconds", () => {
  const f = fixture();
  assert.equal(WELCOME_DURATION_MS, 3000);
  f.timer.setVisible(true);
  f.advance(2999);
  assert.equal(f.completions, 0);
  f.advance(1);
  assert.equal(f.completions, 1);
  assert.equal(f.pending, 0);
});

test("repeated foreground notifications do not restart the entry", () => {
  const f = fixture();
  f.timer.setVisible(true);
  f.advance(1500);
  f.timer.setVisible(true);
  f.advance(1500);
  assert.equal(f.completions, 1);
});

test("background loading does not consume the animation and a mid-play pause preserves remaining time", () => {
  const f = fixture();
  f.timer.setVisible(false);
  f.advance(10000);
  assert.equal(f.completions, 0);
  assert.equal(f.pending, 0);
  f.timer.setVisible(true);
  f.advance(1000);
  f.timer.setVisible(false);
  f.advance(10000);
  assert.equal(f.completions, 0);
  f.timer.setVisible(true);
  f.advance(1999);
  assert.equal(f.completions, 0);
  f.advance(1);
  assert.equal(f.completions, 1);
  f.timer.setVisible(false);
  f.timer.setVisible(true);
  f.advance(5000);
  assert.equal(f.completions, 1, "completed entry must never replay on tab return");
});

test("cleanup cancels callbacks and cannot restart after unmount or Escape", () => {
  const f = fixture();
  f.timer.setVisible(true);
  f.advance(500);
  f.timer.dispose();
  f.timer.setVisible(true);
  f.advance(10000);
  assert.equal(f.pending, 0);
  assert.equal(f.completions, 0);
});
