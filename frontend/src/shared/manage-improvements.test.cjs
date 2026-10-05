const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { MemoryRouter } = require("react-router-dom");
let role = "owner";
const people = [
  { id: "dad", name: "张三", gender: "male" },
  {
    id: "kid",
    name: "李四",
    gender: "female",
    hasPhoto: true,
    photoUrl: "/photo",
  },
];
const data = () => ({
  circle: { id: "family", name: "测试家庭", role },
  people,
  relations: [{ id: "r", from: "dad", to: "kid", type: "parent" }],
  members: [],
  remarks: {},
});
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} };
  cache.set(file, mod);
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  new Function("require", "module", "exports", compiled)(
    (name) => {
      if (name.endsWith(".css") || name === "./components/ProfileForm")
        return {};
      if (name.endsWith("/hooks"))
        return {
          useCircle: () => ({
            data: data(),
            loading: false,
            load: async () => {},
          }),
        };
      if (name.endsWith("/app-context"))
        return {
          useApp: () => ({
            refresh: async () => {},
            notify() {},
            confirmSensitive: async () => true,
          }),
        };
      if (name.endsWith("/api"))
        return {
          rpc() {
            throw Error("Rendering must not mutate data");
          },
        };
      if (!name.startsWith(".")) return require(name);
      const base = path.resolve(path.dirname(file), name);
      for (const suffix of ["", ".ts", ".tsx"])
        if (fs.existsSync(base + suffix)) return load(base + suffix);
      throw Error(name);
    },
    mod,
    mod.exports,
  );
  return mod.exports;
}
const {
  default: Manage,
  PhotoEditor,
  RelationEditor,
} = load(path.join(__dirname, "../Manage.tsx"));
const { needsPhoto, relationSentence } = load(
  path.join(__dirname, "manage-people.ts"),
);
const render = (element) =>
  renderToStaticMarkup(React.createElement(MemoryRouter, {}, element));

test("photo completion uses stored photo status and does not flag temporarily unavailable URLs", () => {
  assert.equal(needsPhoto({}), true);
  assert.equal(needsPhoto({ hasPhoto: true }), false);
  assert.equal(needsPhoto({ photoUrl: "/photo" }), false);
});
test("only administrators see the missing-photo reminder and upload entry", () => {
  for (const admin of ["owner", "admin"]) {
    role = admin;
    const html = render(React.createElement(Manage));
    assert.match(html, /1 位家人还没照片/);
    assert.match(html, /给张三补照片/);
    assert.doesNotMatch(html, /给李四补照片/);
  }
  role = "member";
  const html = render(React.createElement(Manage));
  assert.match(html, /此页面仅供管理员使用/);
  assert.doesNotMatch(html, /只看没照片|补照片|选择照片/);
});
test("photo-only editor asks for no other profile fields and starts with save disabled", () => {
  const html = render(
    React.createElement(PhotoEditor, {
      person: people[0],
      circleId: "family",
      onClose() {},
      async onSaved() {},
    }),
  );
  assert.match(html, /选择照片/);
  assert.match(html, /disabled="">保存照片/);
  assert.doesNotMatch(html, /手机号|出生|所在城市|保存资料/);
});
test("relationship correction shows the old and proposed sentences before saving", () => {
  assert.equal(
    relationSentence(data().relations[0], people),
    "张三 是 李四 的 父亲",
  );
  const html = render(
    React.createElement(RelationEditor, {
      data: data(),
      relation: data().relations[0],
      onClose() {},
      async onSaved() {},
    }),
  );
  assert.match(html, /原来：张三 是 李四 的 父亲/);
  assert.match(html, /保存后：张三 是 李四 的 爸爸/);
  assert.doesNotMatch(html, /正在为这位家人补关系/);
});
