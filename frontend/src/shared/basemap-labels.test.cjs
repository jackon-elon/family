const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const compiled = ts.transpileModule(
  fs.readFileSync(require.resolve("./basemap-labels.ts"), "utf8"),
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
const { visibleBasemapLabels, basemapLabelBox, cityFocusZoom } = mod.exports;
const cityLabels = require("../assets/basemap/city-labels.json");
const project = (label) => ({ x: label.longitude, y: label.latitude });
const size = { x: 600, y: 400 };
test("overview country labels remain separated and retain the preferred larger region", () => {
  const labels = [
    { name: "中国", longitude: 200, latitude: 100 },
    { name: "附近地名", longitude: 210, latitude: 100 },
    { name: "法国", longitude: 400, latitude: 100 },
  ];
  assert.deepEqual(
    visibleBasemapLabels(labels, 3, project, size).map((label) => label.name),
    ["中国", "法国"],
  );
});
test("labels follow overview zoom limits and exclude offscreen positions", () => {
  const labels = [
    {
      name: "太平洋",
      longitude: 100,
      latitude: 100,
      minZoom: 1,
      maxZoom: 3,
      kind: "ocean",
    },
    { name: "浙江", longitude: 300, latitude: 100, minZoom: 4, kind: "region" },
    { name: "视野外", longitude: 800, latitude: 200, minZoom: 1 },
  ];
  assert.deepEqual(
    visibleBasemapLabels(labels, 1, project, size).map((label) => label.name),
    ["太平洋"],
  );
  assert.deepEqual(
    visibleBasemapLabels(labels, 5, project, size).map((label) => label.name),
    ["浙江"],
  );
});

test("large region names take precedence when detailed labels appear nearby", () => {
  const labels = [
    { name: "详细地名", longitude: 200, latitude: 100, minZoom: 5 },
    { name: "主要国家", longitude: 210, latitude: 100, minZoom: 2 },
  ];
  assert.deepEqual(
    visibleBasemapLabels(labels, 5, project, size).map((label) => label.name),
    ["主要国家"],
  );
});

function cityViewport(center, zoom, size) {
  const scale = 256 * 2 ** zoom;
  const mercator = ({ longitude, latitude }) => {
    const radians = (latitude * Math.PI) / 180;
    return {
      x: ((longitude + 180) / 360) * scale,
      y:
        ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) /
          2) *
        scale,
    };
  };
  const origin = mercator(center);
  return (label) => {
    const point = mercator(label);
    return {
      x: point.x - origin.x + size.x / 2,
      y: point.y - origin.y + size.y / 2,
    };
  };
}

test("larger label priorities win collisions regardless of input order", () => {
  const labels = [
    {
      name: "普通城市",
      longitude: 200,
      latitude: 100,
      kind: "city",
      priority: 20,
    },
    {
      name: "主要城市",
      longitude: 202,
      latitude: 100,
      kind: "city",
      priority: 100,
    },
  ];
  assert.deepEqual(
    visibleBasemapLabels(labels, 8, project, size).map((label) => label.name),
    ["主要城市"],
  );
});

test("city focus shows actual neighboring cities on desktop and phone without family members", () => {
  for (const viewport of [
    { x: 730, y: 460 },
    { x: 360, y: 360 },
  ]) {
    const zoom = cityFocusZoom(viewport.x);
    const projectCity = cityViewport(
      { longitude: 120.2, latitude: 30.3 },
      zoom,
      viewport,
    );
    const names = visibleBasemapLabels(
      cityLabels,
      zoom,
      projectCity,
      viewport,
    ).map((label) => label.name);
    for (const name of ["杭州", "绍兴", "宁波"]) {
      assert.ok(
        names.includes(name),
        `${viewport.x}px city view must show ${name}`,
      );
    }
  }
});

test("family city badges hide only intersecting base labels while nearby cities stay visible", () => {
  const viewport = { x: 730, y: 460 };
  const zoom = cityFocusZoom(viewport.x);
  const projectCity = cityViewport(
    { longitude: 120.2, latitude: 30.3 },
    zoom,
    viewport,
  );
  const badge = {
    x: viewport.x / 2,
    y: viewport.y / 2 - 20,
    width: 122,
    height: 50,
  };
  const visible = visibleBasemapLabels(
    cityLabels,
    zoom,
    projectCity,
    viewport,
    [badge],
  );
  assert.ok(!visible.some((label) => label.name === "杭州"));
  assert.ok(visible.some((label) => label.name === "绍兴"));
  assert.ok(visible.some((label) => label.name === "宁波"));
  for (const label of visible) {
    const box = basemapLabelBox(label, projectCity(label));
    assert.ok(
      Math.abs(box.x - badge.x) >= (box.width + badge.width) / 2 ||
        Math.abs(box.y - badge.y) >= (box.height + badge.height) / 2,
      `${label.name} must not overlap the family badge`,
    );
  }
});

test("maximum city zoom keeps Chinese and overseas base labels readable", () => {
  const viewport = { x: 730, y: 460 };
  for (const name of ["杭州", "伦敦", "悉尼"]) {
    const city = cityLabels.find(
      (label) => label.name === name && label.kind === "city",
    );
    assert.ok(city, `${name} exists in the local geographic catalog`);
    const projectCity = cityViewport(city, 9, viewport);
    const visible = visibleBasemapLabels(cityLabels, 9, projectCity, viewport);
    assert.ok(visible.some((label) => label.name === name));
    assert.ok(visible.every((label) => label.kind === "city"));
  }
});

test("China overview and province zoom have geographic names before city labels begin", () => {
  const viewport = { x: 730, y: 460 };
  for (const zoom of [2.25, 2.5, 3, 3.5, 4.5]) {
    const projectCity = cityViewport(
      { longitude: 104, latitude: 38 },
      zoom,
      viewport,
    );
    const visible = visibleBasemapLabels(
      cityLabels,
      zoom,
      projectCity,
      viewport,
    );
    assert.ok(
      visible.some((label) => label.kind === "region"),
      `province names must remain visible at ${zoom}`,
    );
    assert.ok(
      visible.every((label) => label.kind !== "city"),
      "dense city labels wait until closer zoom",
    );
  }
});
