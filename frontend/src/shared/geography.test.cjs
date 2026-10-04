const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const cache = new Map();
function loadTs(file) {
  const resolved = path.resolve(__dirname, file);
  if (cache.has(resolved)) return cache.get(resolved);
  const module = { exports: {} };
  cache.set(resolved, module.exports);
  const compiled = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  new Function("require", "module", "exports", compiled)(
    (name) => (name.startsWith(".") ? loadTs(`${name}.ts`) : require(name)),
    module,
    module.exports,
  );
  return module.exports;
}
const { citySummary, cityOptionInProvince, coordinates } =
  loadTs("geography.ts");
const { cityChoices, catalogProvince } = loadTs("geography.ts");
const person = (id, city, rest = {}) => ({
  id,
  name: id,
  country: "中国",
  province: "上海",
  city,
  ...rest,
});

test("every member remains counted across domestic, overseas and unlocated cities", () => {
  const people = [
    person("a", "上海"),
    person("b", "上海"),
    person("c", "伦敦", {
      country: "英国",
      province: "",
      latitude: 51.5,
      longitude: -0.1,
    }),
    person("d", "未收录的小城", { province: "" }),
    person("e", ""),
  ];
  const result = citySummary(people);
  assert.equal(result.total, 5);
  assert.equal(result.domestic, 2);
  assert.equal(result.overseas, 1);
  assert.equal(result.unlocated, 2);
  assert.equal(
    result.groups.reduce((sum, group) => sum + group.people.length, 0),
    5,
  );
  assert.equal(
    result.groups.find((group) => group.city === "上海").people.length,
    2,
  );
  assert.equal(
    result.groups.find((group) => group.city === "未收录的小城").point,
    null,
  );
});

test("same-named cities in different provinces remain separate", () => {
  const result = citySummary([
    person("a", "同名城", { province: "甲省", latitude: 32, longitude: 112 }),
    person("b", "同名城", { province: "乙省", latitude: 42, longitude: 122 }),
  ]);
  assert.equal(result.groups.length, 2);
  assert.notEqual(result.groups[0].key, result.groups[1].key);
  assert.equal(result.total, 2);
});

test("city coordinates are not invented for unknown or mismatched countries", () => {
  assert.equal(cityOptionInProvince("上海", "美国"), undefined);
  assert.equal(
    coordinates({
      country: "中国",
      city: "未收录",
      latitude: 999,
      longitude: 20,
    }),
    null,
  );
  assert.equal(
    coordinates({
      country: "中国",
      city: "",
      latitude: 31.2,
      longitude: 121.5,
    }),
    null,
  );
  assert.equal(
    citySummary([
      person("a", "未知", {
        country: "",
        province: "",
        latitude: 20,
        longitude: 20,
      }),
    ]).unlocated,
    1,
  );
});

test("a known city falls back to a city center and keeps WGS84 coordinates unchanged", () => {
  const city = coordinates({ country: "中国", province: "上海", city: "上海" });
  assert.deepEqual(city, { latitude: 31.2, longitude: 121.5 });
  assert.deepEqual(
    coordinates({
      country: "中国",
      city: "上海",
      latitude: 31.234,
      longitude: 121.456,
    }),
    { latitude: 31.234, longitude: 121.456 },
  );
});

test("duplicate IDs are not double-counted and city-level grouping totals stay coherent", () => {
  const a = person("a", "未知同城", { latitude: 30, longitude: 120 });
  const result = citySummary([a, a, person("b", "未知同城")]);
  assert.equal(result.total, 2);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].people.length, 2);
  assert.equal(
    result.domestic + result.overseas + result.unlocated,
    result.total,
  );
});

test("known Chinese full and short province/city names share one city and valid coordinates", () => {
  const full = {
    id: "full",
    name: "甲",
    country: "中国",
    province: "浙江省",
    city: "杭州市",
  };
  const short = {
    id: "short",
    name: "乙",
    country: "中国",
    province: "浙江",
    city: "杭州",
  };
  const summary = citySummary([full, short]);
  assert.equal(summary.groups.length, 1);
  assert.equal(summary.groups[0].people.length, 2);
  assert.equal(summary.groups[0].city, "杭州");
  assert.equal(summary.domestic, 2);
  assert.deepEqual(
    cityOptionInProvince("杭州市", "中国", "浙江省"),
    cityOptionInProvince("杭州", "中国", "浙江"),
  );
  assert.equal(catalogProvince("中国", "浙江省"), "浙江");
  assert.equal(catalogProvince("中国", "上海市"), "上海");
  assert.equal(catalogProvince("中国", "广西壮族自治区"), "广西");
  assert.equal(catalogProvince("中国", "香港特别行政区"), "香港");
  assert.ok(cityChoices("中国", "浙江省").some((city) => city.city === "杭州"));
});

test("administrative aliases never cross countries, wrong provinces, or unknown places", () => {
  assert.equal(cityOptionInProvince("杭州市", "美国", "浙江省"), undefined);
  assert.equal(cityOptionInProvince("杭州市", "中国", "江苏省"), undefined);
  assert.equal(cityOptionInProvince("未知市", "中国", "浙江省"), undefined);
  assert.equal(catalogProvince("美国", "上海市"), "上海市");
  assert.equal(catalogProvince("中国", "不存在省"), "不存在省");
  const unknown = citySummary([
    person("a", "未知市", { province: "浙江省" }),
    person("b", "未知", { province: "浙江省" }),
    person("c", "上海市", { country: "美国", province: "上海市" }),
    person("d", "上海", { country: "中国", province: "上海" }),
  ]);
  assert.equal(unknown.groups.length, 4);
  assert.equal(unknown.unlocated, 3);
});
