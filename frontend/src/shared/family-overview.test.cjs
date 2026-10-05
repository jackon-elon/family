const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
function load(file) {
  const mod = { exports: {} };
  const code = ts.transpileModule(
    fs.readFileSync(require.resolve(file), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  new Function("require", "module", "exports", code)(require, mod, mod.exports);
  return mod.exports;
}
const {
  buildFamilyOverview,
  shouldShowFamilies,
  FAMILY_CARD_WIDTH,
  FAMILY_CARD_HEIGHT,
} = load("./family-overview.ts");
const { buildStarLayout } = load("./family-layout.ts");
const { graphBounds, GRAPH_UNIT } = load("./graph-view.ts");
const person = (id) => ({ id, name: id });
const parent = (from, to) => ({ from, to, type: "parent" });
const spouse = (from, to) => ({ from, to, type: "spouse" });
const sibling = (from, to) => ({ from, to, type: "sibling" });
function build(ids, edges, selfId) {
  return buildFamilyOverview(
    buildStarLayout(ids.map(person), edges, selfId, selfId).nodes,
    edges,
  );
}
function checkCoverage(result, ids, edges) {
  const members = result.nodes.flatMap((unit) =>
    unit.members.map((node) => node.id),
  );
  assert.equal(new Set(members).size, members.length, "no duplicate people");
  assert.deepEqual([...members].sort(), [...ids].sort(), "no missing people");
  for (const edge of edges) {
    const from = result.personUnit.get(edge.from),
      to = result.personUnit.get(edge.to);
    if (from && to && from !== to)
      assert.ok(
        result.edges.some(
          (saved) =>
            saved.type === edge.type &&
            ((saved.from === from && saved.to === to) ||
              (edge.type !== "parent" &&
                saved.from === to &&
                saved.to === from)),
        ),
        "cross-family edge retained",
      );
  }
}

test("parents and unmarried siblings fold together without changing original data", () => {
  const ids = ["father", "mother", "me", "sister"],
    edges = [
      spouse("father", "mother"),
      ...["me", "sister"].flatMap((child) => [
        parent("father", child),
        parent("mother", child),
      ]),
    ];
  const before = JSON.stringify(edges);
  const result = build(ids, edges, "me");
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].isSelf, true);
  checkCoverage(result, ids, edges);
  assert.equal(JSON.stringify(edges), before);
});

test("known shared parents can fold without inventing a marriage", () => {
  const ids = ["a", "b", "child"];
  const edges = [parent("a", "child"), parent("b", "child")];
  const result = build(ids, edges, "child");
  assert.equal(result.nodes.length, 1);
  assert.match(result.nodes[0].title, /与子女/);
  assert.ok(result.edges.every((edge) => edge.type !== "spouse"));
  const more = [...edges, parent("a", "otherChild"), parent("c", "otherChild")];
  const complex = build([...ids, "c", "otherChild"], more, "child");
  assert.equal(complex.nodes.length, 5);
  checkCoverage(complex, [...ids, "c", "otherChild"], more);
});

test("married siblings have separate families connected to both sets of parents", () => {
  const ids = [
    "father",
    "mother",
    "me",
    "wife",
    "son",
    "sister",
    "husband",
    "inlaw",
  ];
  const edges = [
    spouse("father", "mother"),
    spouse("me", "wife"),
    spouse("sister", "husband"),
    parent("me", "son"),
    parent("wife", "son"),
    parent("inlaw", "wife"),
    ...["me", "sister"].flatMap((id) => [
      parent("father", id),
      parent("mother", id),
    ]),
  ];
  const result = build(ids, edges, "me");
  assert.equal(result.nodes.length, 4);
  assert.notEqual(result.personUnit.get("me"), result.personUnit.get("father"));
  assert.notEqual(result.personUnit.get("me"), result.personUnit.get("sister"));
  assert.equal(result.personUnit.get("me"), result.personUnit.get("son"));
  const parentUnit = result.nodes.find(
    (unit) => unit.id === result.personUnit.get("father"),
  );
  const children = ["me", "sister"].map((id) =>
    result.nodes.find((unit) => unit.id === result.personUnit.get(id)),
  );
  assert.ok(
    parentUnit.x >= Math.min(...children.map((unit) => unit.x)) &&
      parentUnit.x <= Math.max(...children.map((unit) => unit.x)),
    "parents stay above their own branch",
  );
  checkCoverage(result, ids, edges);
});

test("a spouse is not silently assigned as the other parent; half siblings remain linked", () => {
  const ids = ["parent", "partner", "otherParent", "child", "sharedChild"];
  const edges = [
    spouse("parent", "partner"),
    parent("parent", "child"),
    parent("otherParent", "child"),
    parent("parent", "sharedChild"),
    parent("partner", "sharedChild"),
  ];
  const result = build(ids, edges, "parent");
  assert.notEqual(
    result.personUnit.get("child"),
    result.personUnit.get("partner"),
  );
  assert.equal(
    result.personUnit.get("sharedChild"),
    result.personUnit.get("partner"),
  );
  checkCoverage(result, ids, edges);
});

test("single parent folds with child but sibling-only or unlinked people are never guessed into a household", () => {
  const ids = ["parent", "child", "a", "b", "unknown"];
  const edges = [parent("parent", "child"), sibling("a", "b")];
  const result = build(ids, edges, "parent");
  assert.equal(result.personUnit.get("parent"), result.personUnit.get("child"));
  assert.notEqual(result.personUnit.get("a"), result.personUnit.get("b"));
  assert.equal(
    result.nodes.find((unit) =>
      unit.members.some((node) => node.id === "unknown"),
    ).members.length,
    1,
  );
  checkCoverage(result, ids, edges);
});

test("multiple partners, omitted parents, and contradictory generations are kept separate", () => {
  const ids = ["a", "b", "c", "child"];
  const edges = [spouse("a", "b"), spouse("a", "c"), parent("a", "child")];
  const result = build(ids, edges, "a");
  assert.equal(result.nodes.length, 4);
  const partial = buildFamilyOverview(
    buildStarLayout(
      [person("a"), person("b"), person("child")],
      edges,
      "a",
      "a",
    ).nodes,
    edges,
  );
  assert.equal(
    partial.nodes.length,
    3,
    "omitted partner prevents a false exclusive pair",
  );
  const omittedParentEdges = [parent("a", "child"), parent("missing", "child")];
  assert.equal(build(["a", "child"], omittedParentEdges, "a").nodes.length, 2);
  const conflict = build(["a", "b"], [parent("a", "b"), spouse("a", "b")], "a");
  assert.equal(conflict.hasGroups, false);
});

test("guest or unlinked self does not prevent known independent families from folding", () => {
  const ids = ["0unknown", "a", "b", "child"];
  const edges = [spouse("a", "b"), parent("a", "child"), parent("b", "child")];
  const guest = build(ids, edges);
  assert.equal(guest.nodes.length, 2);
  assert.ok(guest.nodes.every((unit) => !unit.isSelf));
  const member = build(ids, edges, "0unknown");
  assert.equal(member.nodes.length, 2);
  assert.equal(member.nodes.filter((unit) => unit.isSelf).length, 1);
});

test("100 relatives across four generations keep unique membership, bounded cards and all external relationships", () => {
  const ids = Array.from({ length: 100 }, (_, i) => `p${i}`),
    edges = [];
  for (let i = 0; i < 40; i += 2) edges.push(spouse(ids[i], ids[i + 1]));
  for (let child = 2; child < 100; child++) {
    const a =
      child < 12
        ? 0
        : child < 40
          ? 2 + 2 * ((child - 12) % 5)
          : 12 + 2 * ((child - 40) % 14);
    edges.push(parent(ids[a], ids[child]), parent(ids[a + 1], ids[child]));
  }
  assert.equal(
    new Set(
      buildStarLayout(ids.map(person), edges, "p30", "p30").nodes.map(
        (node) => node.generation,
      ),
    ).size,
    4,
  );
  const result = build(ids, edges, "p30");
  checkCoverage(result, ids, edges);
  const bounds = graphBounds(
    result.nodes,
    FAMILY_CARD_WIDTH,
    FAMILY_CARD_HEIGHT,
  );
  for (const unit of result.nodes) {
    const x = unit.x * GRAPH_UNIT - bounds.left,
      y = unit.y * GRAPH_UNIT - bounds.top;
    assert.ok(
      x - FAMILY_CARD_WIDTH / 2 >= 0 &&
        x + FAMILY_CARD_WIDTH / 2 <= bounds.width,
    );
    assert.ok(
      y - FAMILY_CARD_HEIGHT / 2 >= 0 &&
        y + FAMILY_CARD_HEIGHT / 2 <= bounds.height,
    );
    for (const other of result.nodes)
      if (other.id !== unit.id)
        assert.ok(
          Math.abs(unit.x - other.x) * GRAPH_UNIT >= FAMILY_CARD_WIDTH ||
            Math.abs(unit.y - other.y) * GRAPH_UNIT >= FAMILY_CARD_HEIGHT,
          "cards never overlap",
        );
  }
  const reversed = build([...ids].reverse(), [...edges].reverse(), "p30");
  assert.deepEqual(
    [...result.personUnit].sort(),
    [...reversed.personUnit].sort(),
  );
});

test("semantic zoom responds to readability and viewport, with hysteresis instead of a headcount cutoff", () => {
  const small = { width: 400, height: 350 },
    large = { width: 5000, height: 1200 };
  const phone = { width: 360, height: 420 },
    desktop = { width: 1500, height: 800 };
  assert.equal(shouldShowFamilies(false, 1, large, phone, true), false);
  assert.equal(shouldShowFamilies(false, 0.55, small, phone, true), false);
  assert.equal(shouldShowFamilies(false, 0.55, large, phone, true), true);
  assert.equal(
    shouldShowFamilies(
      false,
      0.65,
      { width: 1000, height: 500 },
      desktop,
      true,
    ),
    false,
  );
  assert.equal(
    shouldShowFamilies(false, 0.65, { width: 1000, height: 500 }, phone, true),
    true,
  );
  assert.equal(shouldShowFamilies(true, 0.7, large, phone, true), true);
  assert.equal(shouldShowFamilies(true, 0.85, large, phone, true), false);
  assert.equal(shouldShowFamilies(false, 0.4, small, phone, true), true);
  assert.equal(shouldShowFamilies(false, 0.01, large, phone, false), false);
});
