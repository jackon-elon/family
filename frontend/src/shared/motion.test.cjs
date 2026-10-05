const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const output = ts.transpileModule(fs.readFileSync(require.resolve('./motion.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const subject = { exports: {} };
const media = { matches: false };
new Function('module', 'exports', 'window', output)(subject, subject.exports, {
  matchMedia: () => media,
});
const { animateProgress, motionAllowed } = subject.exports;
function clock() {
  const frames = new Map();
  let id = 0;
  return {
    frames,
    request: fn => { frames.set(++id, fn); return id; },
    cancel: id => frames.delete(id),
    tick(time) {
      for (const [id, fn] of [...frames]) { frames.delete(id); fn(time); }
    },
  };
}
test('zoom has intermediate frames, is monotonic, and ends exactly on its requested target', () => {
  const c = clock(), values = [];
  animateProgress(t => values.push(1 + (.4 - 1) * t), 240, c.request, c.cancel);
  for (let time = 0; time <= 256; time += 16) c.tick(time);
  assert.equal(values[0], 1);
  assert.equal(values.at(-1), .4);
  assert.ok(values.length > 10);
  assert.ok(values.every((v, i) => v >= .4 && (!i || v <= values[i-1])));
  assert.equal(c.frames.size, 0);
});
test('rapid replacement or unmount cancels even an already delivered old frame', () => {
  const c = clock(), old = [], current = [];
  const stop = animateProgress(t => old.push(t), 240, c.request, c.cancel);
  c.tick(0); c.tick(80);
  const late = [...c.frames.values()][0];
  stop();
  animateProgress(t => current.push(t), 240, c.request, c.cancel);
  late(240); c.tick(80); c.tick(320);
  assert.equal(old.length, 2);
  assert.deepEqual(current, [0, 1]);
  assert.equal(c.frames.size, 0);
});
test('reduced motion preference is read again for each interaction', () => {
  assert.equal(motionAllowed(), true);
  media.matches = true;
  assert.equal(motionAllowed(), false);
});
