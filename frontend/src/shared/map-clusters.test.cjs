const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const compiled = ts.transpileModule(
  fs.readFileSync(require.resolve("./map-clusters.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const mod = { exports: {} };
new Function("require", "module", "exports", compiled)(
  require,
  mod,
  mod.exports,
);
const { clusterCityMarkers } = mod.exports;
const group = (key, x, y, count = 1) => ({
  key,
  country: "中国",
  province: "",
  city: key,
  point: x === null ? null : { latitude: y, longitude: x },
  people: Array.from({ length: count }, (_, i) => ({ id: `${key}-${i}` })),
});
const project = ({ latitude, longitude }) => ({ x: longitude, y: latitude });

test("nearby city badges aggregate without losing members or cities", () => {
  const result = clusterCityMarkers(
    [
      group("杭州", 100, 100, 3),
      group("上海", 130, 90, 2),
      group("北京", 180, 10),
      group("未知", null, 0),
    ],
    project,
  );
  assert.equal(result.length, 2);
  assert.equal(
    result.reduce((sum, marker) => sum + marker.count, 0),
    6,
  );
  const nearby = result.find((marker) => marker.groups.length === 2);
  assert.equal(nearby.count, 5);
  assert.deepEqual(
    new Set(nearby.groups.map((city) => city.key)),
    new Set(["杭州", "上海"]),
  );
});

test("zooming separates cities while equal coordinates remain fully selectable", () => {
  const groups = [
    group("甲", 20, 20),
    group("乙", 40, 20),
    group("同坐标", 20, 20),
  ];
  assert.equal(clusterCityMarkers(groups, project).length, 1);
  const zoomed = clusterCityMarkers(groups, (point) => ({
    x: point.longitude * 20,
    y: point.latitude * 20,
  }));
  assert.equal(zoomed.length, 2);
  assert.equal(
    zoomed.reduce((sum, marker) => sum + marker.groups.length, 0),
    3,
  );
});

test("cluster results are independent of member response order and badges do not overlap", () => {
  const groups = Array.from({ length: 80 }, (_, index) =>
    group(String(index), (index % 10) * 50, Math.floor(index / 10) * 40),
  );
  const result = clusterCityMarkers(groups, project);
  assert.deepEqual(result, clusterCityMarkers([...groups].reverse(), project));
  assert.equal(
    result.reduce((sum, marker) => sum + marker.groups.length, 0),
    80,
  );
  for (let i = 0; i < result.length; i++)
    for (let j = i + 1; j < result.length; j++) {
      assert.ok(
        Math.abs(result[i].x - result[j].x) >= 120 ||
          Math.abs(result[i].y - result[j].y) >= 44,
      );
    }
});
