const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const subject = { exports: {} };
new Function(
  "module",
  "exports",
  ts.transpileModule(
    fs.readFileSync(require.resolve("./person-search.ts"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText,
)(subject, subject.exports);
const { matchesPerson } = subject.exports;

test("family search finds the displayed remark, original name, city, status and actual biography", () => {
  const person = {
    name: "大姑",
    originalName: "张青",
    country: "中国",
    province: "浙江",
    city: "杭州",
    status: "退休",
    bio: "最近在学画画",
    school: "复旦大学",
    industry: "教育",
    occupation: "老师",
    wechatId: "ZhangQing",
    phone: "+8613800000001",
  };
  for (const query of [
    "大姑",
    "张青",
    " 杭州 ",
    "退休",
    "画画",
    "复旦",
    "教育",
    "老师",
    "zhangqing",
    "138 0000 0001",
    "+86 (138) 0000-0001",
    " ",
  ])
    assert.equal(matchesPerson(person, query), true, query);
  assert.equal(matchesPerson(person, "不存在"), false);
});

test("relationship search uses only the supplied viewer label and never old nicknames or hidden metadata", () => {
  const person = {
    name: "张青",
    nickname: "废弃昵称",
    remarks: { other: "别人的私人备注" },
  };
  assert.equal(matchesPerson(person, "姑妈", "姑妈"), true);
  assert.equal(matchesPerson(person, "姑妈"), false);
  assert.equal(matchesPerson(person, "私人备注"), false);
  assert.equal(matchesPerson(person, "废弃昵称"), false);
  assert.equal(matchesPerson({}, ""), true);
  assert.equal(matchesPerson({}, "张青"), false);
});
