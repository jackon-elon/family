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
const { graphBounds, graphFit, graphScroll, GRAPH_UNIT, GRAPH_CARD } =
  mod.exports;

test("phone overview includes every card and generation heading without mini program gutters", () => {
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
  for (const width of [275, 345, 738]) {
    const height = 290;
    const zoom = graphFit(bounds, width, height);
    assert.ok(bounds.width * zoom <= width);
    assert.ok(bounds.height * zoom <= height);
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
  assert.ok(Number.isFinite(graphFit(graphBounds([]), 320, 260)));
});

test("overview can contain a large generation instead of stopping at an arbitrary 85 percent", () => {
  const bounds = graphBounds(
    Array.from({ length: 160 }, (_, i) => ({ x: 210 + i * 175, y: 180 })),
  );
  const zoom = graphFit(bounds, 275, 290);
  assert.ok(bounds.width * zoom <= 275);
});
