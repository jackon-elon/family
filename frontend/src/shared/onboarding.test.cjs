const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const cache = new Map();
function load(file) {
  const resolved = path.resolve(__dirname, file);
  if (cache.has(resolved)) return cache.get(resolved).exports;
  const module = { exports: {} };
  cache.set(resolved, module);
  const compiled = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  new Function("require", "module", "exports", compiled)(
    (name) => {
      if (
        ["./App", "./hooks", "./api", "./components/ProfileForm"].includes(name)
      )
        return {};
      if (!name.startsWith(".")) return require(name);
      const base = path.resolve(path.dirname(resolved), name);
      for (const extension of ["", ".ts", ".tsx"])
        if (fs.existsSync(base + extension)) return load(base + extension);
      throw Error(`Missing test dependency: ${name}`);
    },
    module,
    module.exports,
  );
  return module.exports;
}
const { invitationCanApply, matchedReviewPerson, reviewMatchError } =
  load("onboarding.ts");
const { ReviewApplication, RelationEditor, relationEdge } =
  load("../Manage.tsx");
const profile = {
  name: "李青",
  country: "中国",
  city: "杭州",
  birthday: { calendar: "solar", month: 5, day: 6 },
};
const person = {
  ...profile,
  id: "existing",
  circleId: "family",
  updatedAt: 100,
  isClaimed: false,
};
const preview = {
  loginPhone: "+8613800000001",
  profileVersion: "v1",
  match: {
    status: "unique",
    person: { id: person.id, updatedAt: person.updatedAt, profile },
  },
};
const application = {
  id: "application",
  circleId: "family",
  name: "李青",
  status: "pending",
  profile,
  loginPhone: preview.loginPhone,
  phoneMatch: {
    status: "unique",
    personId: person.id,
    personUpdatedAt: person.updatedAt,
  },
};

test("a matched invitation needs explicit confirmation and a complete profile before applying", () => {
  assert.equal(invitationCanApply(preview, profile), false);
  const confirmed = {
    ...preview,
    match: { ...preview.match, confirmed: true },
  };
  assert.equal(invitationCanApply(confirmed, profile), true);
  assert.equal(
    invitationCanApply(confirmed, { ...profile, birthday: undefined }),
    false,
  );
  assert.equal(
    invitationCanApply(
      { ...confirmed, match: { status: "unique", confirmed: true } },
      profile,
    ),
    false,
  );
});

test("contact phone changes never override a missing or blocked server account match", () => {
  for (const status of ["conflict", "bound", "verification-required"]) {
    assert.equal(
      invitationCanApply(
        { ...preview, match: { status, confirmed: true } },
        { ...profile, phone: preview.loginPhone },
      ),
      false,
    );
  }
  assert.equal(invitationCanApply(null, profile), false);
  assert.equal(
    invitationCanApply({ ...preview, match: { status: "none" } }, profile),
    true,
  );
});

test("review uses the unique existing record and refuses stale or already claimed records", () => {
  const unrelated = { ...person, id: "other" };
  assert.equal(matchedReviewPerson(application, [unrelated, person]), person);
  assert.equal(reviewMatchError(application, [person]), "");
  for (const change of [
    { updatedAt: 101 },
    { isClaimed: true },
    { id: "other" },
  ]) {
    assert.equal(
      matchedReviewPerson(application, [{ ...person, ...change }]),
      undefined,
    );
    assert.match(
      reviewMatchError(application, [{ ...person, ...change }]),
      /刷新/,
    );
  }
  assert.equal(
    reviewMatchError(
      {
        ...application,
        phoneMatch: { status: "conflict", message: "手机号重复" },
      },
      [person],
    ),
    "手机号重复",
  );
  assert.match(
    reviewMatchError(
      {
        ...application,
        phoneMatch: { ...application.phoneMatch, confirmed: false },
      },
      [person],
    ),
    /重新打开邀请/,
  );
});

test("the administrator review defaults to the same person without an add-new-person choice", () => {
  const html = renderToStaticMarkup(
    React.createElement(ReviewApplication, {
      application,
      data: {
        circle: { id: "family" },
        people: [person],
        relations: [],
        members: [],
        remarks: {},
      },
      onClose() {},
      onSaved() {},
    }),
  );
  assert.match(html, /本人加入/);
  assert.match(html, /登录手机号/);
  assert.match(html, /13800000001/);
  assert.doesNotMatch(html, /添加为新成员/);
  assert.doesNotMatch(html, /选择人物/);
  assert.doesNotMatch(html, /已验证/);
});

test("an unmatched applicant keeps the new-person path and legacy manual record choice", () => {
  const html = renderToStaticMarkup(
    React.createElement(ReviewApplication, {
      application: { ...application, phoneMatch: { status: "none" } },
      data: {
        circle: { id: "family" },
        people: [person],
        relations: [],
        members: [],
        remarks: {},
      },
      onClose() {},
      onSaved() {},
    }),
  );
  assert.match(html, /添加为新成员/);
  assert.match(html, /使用已有的这位家人资料/);
});

test("relationship shortcut preselects the intended person and requires an explicit relationship", () => {
  const html = renderToStaticMarkup(
    React.createElement(RelationEditor, {
      data: {
        circle: { id: "family" },
        people: [person, { ...person, id: "parent", name: "妈妈" }],
      },
      initialPersonId: person.id,
      onClose() {},
      async onSaved() {},
    }),
  );
  assert.match(html, /正在为这位家人补关系/);
  assert.match(html, /<strong>李青<\/strong>/);
  assert.equal((html.match(/class="person-picker-trigger"/g) || []).length, 1);
  assert.doesNotMatch(html, /type="search"|<select|按姓名查找家人/);
  assert.doesNotMatch(html, /value="existing"/);
  assert.ok(html.includes("补充亲属关系"));
  assert.ok(html.includes("1. 选一位已有家人"));
  assert.ok(html.includes("选好家人后，再选择两人的关系"));
  assert.match(html, /disabled="">保存关系/);
});

test("editing a relationship fixes its subject and states direction using the subject's gender", () => {
  for (const [gender, parent, child] of [
    ["male", "爸爸", "儿子"],
    ["female", "妈妈", "女儿"],
    ["unknown", "父亲或母亲", "儿子或女儿"],
  ]) {
    const html = renderToStaticMarkup(
      React.createElement(RelationEditor, {
        data: {
          circle: { id: "family" },
          people: [
            { ...person, gender },
            { ...person, id: "other", name: "小林" },
          ],
        },
        relation: { id: "edge", from: person.id, to: "other", type: "parent" },
        onClose() {},
        async onSaved() {},
      }),
    );
    assert.equal((html.match(/class="person-picker-trigger"/g) || []).length, 1);
    assert.match(html, /李青是小林的谁？/);
    assert.ok(html.includes(`李青 是 小林 的 ${parent}`));
    assert.ok(html.includes(child));
    assert.match(
      html,
      /type="radio"[^>]*checked="" value="parent"/,
    );
  }
});

test("child and parent choices preserve the correct stored direction and reject empty or self links", () => {
  assert.deepEqual(relationEdge("child", "parent", "child"), {
    from: "parent",
    to: "child",
    type: "parent",
  });
  assert.deepEqual(relationEdge("parent", "child", "parent"), {
    from: "parent",
    to: "child",
    type: "parent",
  });
  assert.deepEqual(relationEdge("a", "b", "spouse"), {
    from: "a",
    to: "b",
    type: "spouse",
  });
  for (const args of [
    ["", "b", "parent"],
    ["a", "b", ""],
    ["a", "a", "child"],
  ])
    assert.throws(() => relationEdge(...args));
});
