const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} };
  cache.set(file, mod);
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("require", "module", "exports", code)(
    (name) =>
      name.startsWith(".")
        ? load(path.resolve(path.dirname(file), name) + ".ts")
        : require(name),
    mod,
    mod.exports,
  );
  return mod.exports;
}
const { relationshipFor } = load(path.join(__dirname, "relationship.ts"));
const person = (id, gender, year) => ({
  id,
  name: id,
  gender,
  ...(year ? { birthday: { calendar: "solar", year, month: 1, day: 1 } } : {}),
});
const parent = (from, to) => ({ type: "parent", from, to });
const sibling = (from, to) => ({ type: "sibling", from, to });
const spouse = (from, to) => ({ type: "spouse", from, to });

test("fixed uncle and aunt terms are calculated from recorded relationships and birth dates", () => {
  const people = [
    person("me", "male", 1990),
    person("dad", "male", 1960),
    person("uncle", "male", 1958),
    person("mom", "female", 1962),
    person("aunt", "female", 1961),
  ];
  const edges = [
    parent("dad", "me"),
    parent("mom", "me"),
    sibling("dad", "uncle"),
    sibling("mom", "aunt"),
  ];
  assert.equal(relationshipFor(people, edges, "me", "uncle").label, "伯父");
  assert.equal(relationshipFor(people, edges, "me", "aunt").label, "姨妈");
});

test("all eight cousin spouse terms use cousin age, not spouse age", () => {
  for (const maternal of [false, true])
    for (const male of [false, true])
      for (const older of [false, true]) {
        const people = [
          person("me", "male", 1990),
          person("parent", maternal ? "female" : "male", 1960),
          person("uncle", "male", 1962),
          person("cousin", male ? "male" : "female", older ? 1989 : 1991),
          person("partner", male ? "female" : "male", older ? 1999 : 1980),
        ];
        const edges = [
          parent("parent", "me"),
          sibling("parent", "uncle"),
          parent("uncle", "cousin"),
          spouse("cousin", "partner"),
        ];
        const result = relationshipFor(people, edges, "me", "partner");
        assert.equal(
          result.label,
          (maternal ? "表" : "堂") +
            (male ? (older ? "嫂" : "弟媳") : older ? "姐夫" : "妹夫"),
        );
        assert.equal(result.status, "resolved");
        assert.equal(result.missing, undefined);
      }
});

test("missing age, unknown rules and disconnected relatives have distinct explanations", () => {
  const people = [
    person("me", "male", 1990),
    person("dad", "male", 1960),
    person("uncle", "male", 1962),
    person("cousin", "female"),
    person("partner", "male", 1980),
    person("inlaw", "female", 1960),
    person("isolated", "male"),
  ];
  const edges = [
    parent("dad", "me"),
    sibling("dad", "uncle"),
    parent("uncle", "cousin"),
    spouse("cousin", "partner"),
    parent("inlaw", "partner"),
  ];
  const missing = relationshipFor(people, edges, "me", "partner");
  assert.equal(missing.label, "堂姐妹的丈夫");
  assert.match(missing.missing, /还缺少.*长幼/);
  assert.match(missing.missing, /me与cousin/);
  const unsupported = relationshipFor(people, edges, "me", "inlaw");
  assert.match(unsupported.label, /爸爸的弟弟的女儿的丈夫的妈妈/);
  assert.match(unsupported.missing, /暂未匹配到称呼/);
  const disconnected = relationshipFor(people, edges, "me", "isolated");
  assert.equal(disconnected.label, "关系待补充");
  assert.equal(disconnected.status, "unrelated");
  assert.equal(relationshipFor(people, edges, "me", "me").status, "self");
});

test("conflicting paths ask to check records rather than inventing a fixed term", () => {
  const people = [person("me", "male", 1990), person("other", "male", 1980)];
  const result = relationshipFor(
    people,
    [parent("other", "me"), sibling("other", "me")],
    "me",
    "other",
  );
  assert.equal(result.label, "关系待核对");
  assert.match(result.missing, /多种关系路径/);
});
