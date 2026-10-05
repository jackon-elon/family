const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const subject = { exports: {} };
new Function(
  "module",
  "exports",
  ts.transpileModule(
    fs.readFileSync(require.resolve("./person-speech.ts"), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText,
)(subject, subject.exports);
const { personSpeechText, createPersonSpeaker } = subject.exports;

test("speech reads a member's known relationship and remark, but guests never inherit either", () => {
  const input = {
    name: "张丽",
    city: "杭州",
    remark: "大姑",
    relationship: { label: "姑妈", status: "resolved" },
    phone: "13800000001",
    wechatId: "secret",
    birthday: {},
  };
  assert.equal(
    personSpeechText(input),
    "这是张丽。你备注的是大姑。是你的姑妈。目前在杭州。",
  );
  assert.equal(
    personSpeechText({ ...input, readOnly: true, isSelf: true }),
    "这是张丽。目前在杭州。",
  );
  assert.equal(
    personSpeechText({ ...input, isSelf: true }),
    "这是你自己，张丽。目前在杭州。",
  );
  assert.equal(
    personSpeechText({
      name: "张丽",
      relationship: { label: "姑妈", status: "pending" },
    }),
    "这是张丽。具体称呼请查看关系说明。",
  );
  assert.equal(
    personSpeechText({
      name: "张丽",
      relationship: { label: "关系待补充", status: "unrelated" },
    }),
    "这是张丽。你们的关系还待补充。",
  );
  assert.equal(personSpeechText({ name: "张丽", city: " " }), "这是张丽。");
});

function fixture(t, overrides = {}) {
  const spoken = [],
    states = [];
  let cancellations = 0;
  const local = { lang: "zh-CN", localService: true };
  const engine = {
    getVoices: () => [
      { lang: "en-US", localService: true },
      { lang: "zh-CN", localService: false },
      local,
    ],
    speak: (item) => spoken.push(item),
    cancel: () => cancellations++,
    ...overrides,
  };
  const player = createPersonSpeaker(
    engine,
    (text) => ({ text }),
    (state) => states.push(state),
  );
  t.after(() => player.dispose());
  return { player, spoken, states, local, cancellations: () => cancellations };
}

test("speech starts only on request, prefers a local Chinese voice and restores idle on completion", (t) => {
  const f = fixture(t);
  assert.equal(f.spoken.length, 0);
  f.player.play("这是张丽。");
  assert.equal(f.spoken[0].voice, f.local);
  assert.equal(f.spoken[0].lang, "zh-CN");
  assert.equal(f.spoken[0].rate, 0.85);
  assert.equal(f.states.at(-1).playing, true);
  f.spoken[0].onstart();
  f.spoken[0].onend();
  assert.deepEqual(f.states.at(-1), { playing: false, message: "" });
});

test("switching or closing cancels speech and ignores late browser callbacks", (t) => {
  const f = fixture(t);
  f.player.play("第一位");
  const oldEnd = f.spoken[0].onend,
    oldError = f.spoken[0].onerror;
  f.player.play("第二位");
  assert.equal(f.cancellations(), 1);
  oldEnd();
  oldError({ error: "interrupted" });
  assert.equal(f.states.at(-1).playing, true);
  f.player.stop();
  assert.equal(f.states.at(-1).playing, false);
  f.player.play("第三位");
  const lastEnd = f.spoken[2].onend,
    count = f.states.length;
  f.player.dispose();
  lastEnd();
  f.player.play("不应再读");
  assert.equal(f.states.length, count);
  assert.equal(f.spoken.length, 3);
  assert.equal(f.cancellations(), 3);
});

test("late voice loading still requests Chinese and errors offer a retry", (t) => {
  const f = fixture(t, { getVoices: () => [] });
  f.player.play("这是张丽。");
  assert.equal(f.spoken[0].voice, null);
  assert.equal(f.spoken[0].lang, "zh-CN");
  f.spoken[0].onerror({ error: "voice-unavailable" });
  assert.equal(f.states.at(-1).playing, false);
  assert.match(f.states.at(-1).message, /中文语音/);
  f.player.play("重试");
  f.spoken[1].onerror({ error: "interrupted" });
  assert.equal(f.states.at(-1).message, "");
});

test("browser exceptions and silent failures never leave an endless Stop button", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const throwing = fixture(t, {
    speak: () => {
      throw new Error("unavailable");
    },
  });
  throwing.player.play("测试");
  assert.equal(throwing.states.at(-1).playing, false);
  assert.match(throwing.states.at(-1).message, /无法朗读/);
  const silent = fixture(t);
  silent.player.play("测试");
  t.mock.timers.tick(10000);
  assert.equal(silent.states.at(-1).playing, false);
  assert.match(silent.states.at(-1).message, /没有开始/);
  silent.player.play("没有结束回调");
  silent.spoken[1].onstart();
  t.mock.timers.tick(60000);
  assert.equal(silent.states.at(-1).playing, false);
});
