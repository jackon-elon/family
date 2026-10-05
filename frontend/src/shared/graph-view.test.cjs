const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const compiled = ts.transpileModule(
  fs.readFileSync(require.resolve("./graph-view.ts"), "utf8"),
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
const {
  graphBounds,
  graphScroll,
  GRAPH_UNIT,
  GRAPH_CARD,
  MIN_GRAPH_ZOOM,
  minimumGraphZoom,
  clampGraphZoom,
} = mod.exports;

test("scrollable graph bounds include every card and generation heading without mini program gutters", () => {
  const nodes = [
    { x: 350, y: 180 },
    { x: 175, y: 430 },
    { x: 350, y: 430 },
    { x: 525, y: 430 },
    { x: 175, y: 680 },
    { x: 350, y: 680 },
    { x: 525, y: 680 },
  ];
  const bounds = graphBounds(nodes);
  for (const zoom of [MIN_GRAPH_ZOOM, 1, 1.6]) {
    for (const n of nodes) {
      const x = (n.x * GRAPH_UNIT - bounds.left) * zoom;
      const y = (n.y * GRAPH_UNIT - bounds.top) * zoom;
      assert.ok(x - (GRAPH_CARD * zoom) / 2 >= 0);
      assert.ok(x + (GRAPH_CARD * zoom) / 2 <= bounds.width * zoom);
      assert.ok(y - (GRAPH_CARD / 2 + 34) * zoom >= 0);
      assert.ok(y + (GRAPH_CARD * zoom) / 2 <= bounds.height * zoom);
    }
  }
});

test("centering myself keeps my whole card visible on a phone at readable zoom", () => {
  const bounds = graphBounds([
    { x: 175, y: 180 },
    { x: 525, y: 680 },
  ]);
  const center = {
    x: 525 * GRAPH_UNIT - bounds.left,
    y: 680 * GRAPH_UNIT - bounds.top,
  };
  const scroll = graphScroll(center, 1, bounds, 275, 290);
  assert.ok(center.x - scroll.left - GRAPH_CARD / 2 >= 0);
  assert.ok(center.x - scroll.left + GRAPH_CARD / 2 <= 275);
  assert.ok(center.y - scroll.top - GRAPH_CARD / 2 >= 0);
  assert.ok(center.y - scroll.top + GRAPH_CARD / 2 <= 290);
});

test("zooming an overview smaller than the viewport never introduces negative scroll", () => {
  const bounds = graphBounds([{ x: 350, y: 180 }]);
  const scroll = graphScroll(
    { x: bounds.width / 2, y: bounds.height / 2 },
    0.4,
    bounds,
    390,
    600,
  );
  assert.deepEqual(scroll, { left: 0, top: 0 });
  assert.ok(Number.isFinite(graphBounds([]).width));
});

test("a large family can zoom out below 85 percent without negative scroll", () => {
  const bounds = graphBounds(
    Array.from({ length: 160 }, (_, i) => ({ x: 210 + i * 175, y: 180 })),
  );
  assert.ok(MIN_GRAPH_ZOOM < 0.85);
  assert.ok(
    bounds.width * MIN_GRAPH_ZOOM > 275,
    "wide families scroll instead of shrinking to dots",
  );
  const center = {
    x: (210 + 159 * 175) * GRAPH_UNIT - bounds.left,
    y: 180 * GRAPH_UNIT - bounds.top,
  };
  const scroll = graphScroll(center, MIN_GRAPH_ZOOM, bounds, 275, 290);
  assert.ok(
    center.x * MIN_GRAPH_ZOOM -
      scroll.left -
      (GRAPH_CARD * MIN_GRAPH_ZOOM) / 2 >=
      0,
  );
  assert.ok(
    center.x * MIN_GRAPH_ZOOM -
      scroll.left +
      (GRAPH_CARD * MIN_GRAPH_ZOOM) / 2 <=
      275,
  );
});

test("repeated zoom-out stops at readable cards in grouped and ungrouped graphs", () => {
  for (const grouped of [true, false]) {
    let zoom = 1;
    for (let i = 0; i < 50; i++) zoom = clampGraphZoom(zoom - 0.15, grouped);
    assert.equal(zoom, minimumGraphZoom(grouped));
    assert.ok(16 * zoom * (grouped ? 2 : 1) >= 12);
    assert.equal(clampGraphZoom(0.01, grouped), zoom);
    assert.equal(clampGraphZoom(2, grouped), 1.6);
  }
  assert.equal(minimumGraphZoom(true), 0.4);
});
