const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const compiled = ts.transpileModule(
  fs.readFileSync(require.resolve("./family-layout.ts"), "utf8"),
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
const { buildStarLayout } = mod.exports;
const people = [
  { id: "child", name: "孩子" },
  { id: "father", name: "爸爸" },
  { id: "uncle", name: "伯父" },
  { id: "cousin", name: "堂哥" },
  { id: "mother", name: "妈妈" },
];
const relations = [
  { from: "father", to: "child", type: "parent" },
  { from: "father", to: "uncle", type: "sibling" },
  { from: "uncle", to: "cousin", type: "parent" },
];
const byId = (layout) =>
  Object.fromEntries(layout.nodes.map((node) => [node.id, node]));

test("guest graph preserves disconnected family branches without inventing a self perspective", () => {
  const layout = buildStarLayout(
    [
      { id: "single", name: "安小青" },
      { id: "parent", name: "张青" },
      { id: "child", name: "张小青" },
    ],
    [{ from: "parent", to: "child", type: "parent" }],
  );
  assert.equal(layout.nodes.length, 3);
  assert.ok(layout.nodes.every((node) => !node.isSelf && !node.isFocus));
  assert.ok(layout.bands.every((band) => !band.label.includes("我")));
  assert.ok(layout.bands.some((band) => band.label.includes("家人分组")));
  const nodes = byId(layout);
  assert.ok(nodes.parent.y < nodes.child.y);
  assert.equal(nodes.parent.label, "家人");
  assert.equal(nodes.child.label, "家人");
  assert.equal(nodes.single.label, "关系待补充");
});

test("a connected guest family numbers generations from oldest without a random reference person", () => {
  const members = [
    { id: "youngest", name: "安小青" },
    { id: "parent", name: "李青" },
    { id: "grandparent", name: "张青" },
  ];
  const connections = [
    { from: "grandparent", to: "parent", type: "parent" },
    { from: "parent", to: "youngest", type: "parent" },
  ];
  const guest = buildStarLayout(members, connections);
  assert.deepEqual(
    guest.bands.map((band) => band.label),
    ["第 1 代", "第 2 代", "第 3 代"],
  );
  const nodes = byId(guest);
  assert.ok(
    nodes.grandparent.y < nodes.parent.y && nodes.parent.y < nodes.youngest.y,
  );
  const member = buildStarLayout(members, connections, "youngest", "youngest");
  assert.deepEqual(
    member.bands.map((band) => band.label),
    ["祖辈", "父辈", "我的同辈"],
  );
});

test("switching to another account changes self and generation labels, keeping family rows aligned", () => {
  const child = byId(buildStarLayout(people, relations, "child", "child"));
  assert.equal(child.father.generation, -1);
  assert.equal(child.uncle.y, child.father.y);
  assert.equal(child.cousin.y, child.child.y);
  const fatherLayout = buildStarLayout(people, relations, "father", "father");
  const father = byId(fatherLayout);
  assert.equal(father.father.generation, 0);
  assert.equal(father.child.generation, 1);
  assert.equal(father.cousin.y, father.child.y);
  assert.deepEqual(
    fatherLayout.nodes.filter((node) => node.isSelf).map((node) => node.id),
    ["father"],
  );
  assert.equal(
    fatherLayout.bands.find((band) => band.isSelf).label,
    "我的同辈",
  );
});

test("a precreated parent moves out of pending relationships when an administrator connects it", () => {
  const pending = buildStarLayout(people, relations, "child", "child");
  assert.equal(byId(pending).mother.generation, null);
  assert.equal(byId(pending).mother.label, "关系待补充");
  const connected = buildStarLayout(
    people,
    [...relations, { from: "mother", to: "child", type: "parent" }],
    "child",
    "child",
    { mother: "妈妈" },
  );
  const nodes = byId(connected);
  assert.equal(nodes.mother.generation, -1);
  assert.equal(nodes.mother.y, nodes.father.y);
  assert.equal(nodes.mother.label, "妈妈");
  assert.equal(connected.nodes.length, people.length);
  assert.equal(
    connected.bands.some((band) => band.isUnlinked),
    false,
  );
});

test("private remarks and search highlighting keep topology and original name ordering", () => {
  const base = byId(buildStarLayout(people, relations, "child", "child"));
  const decorated = byId(
    buildStarLayout(
      people.map((person) => ({
        ...person,
        originalName: person.name,
        name: person.id === "father" ? "亲爱的老爸" : person.name,
        isDimmed: person.id !== "father",
      })),
      relations,
      "child",
      "child",
    ),
  );
  assert.equal(decorated.father.name, "亲爱的老爸");
  assert.equal(decorated.child.isDimmed, true);
  for (const person of people) {
    assert.equal(decorated[person.id].x, base[person.id].x);
    assert.equal(decorated[person.id].y, base[person.id].y);
  }
});

test("an unlinked new member still sees existing families in their known generations", () => {
  const allPeople = [
    ...people,
    { id: "new-member", name: "新家人" },
    { id: "grandma", name: "奶奶" },
  ];
  const allRelations = [
    ...relations,
    { from: "grandma", to: "father", type: "parent" },
  ];
  const layout = buildStarLayout(
    allPeople,
    allRelations,
    "new-member",
    "new-member",
  );
  const nodes = byId(layout);
  assert.equal(nodes["new-member"].isSelf, true);
  assert.equal(nodes.father.y, nodes.uncle.y);
  assert.equal(nodes.child.y, nodes.cousin.y);
  assert.ok(nodes.grandma.y < nodes.father.y);
  assert.ok(nodes.father.y < nodes.child.y);
  assert.equal(nodes.father.generation, null);
  assert.equal(nodes.father.connected, false);
  assert.equal(nodes.father.label, "关系待补充");
  assert.equal(nodes.mother.label, "关系待补充");
  assert.equal(layout.nodes.length, allPeople.length);
  assert.equal(
    new Set(layout.bands.map((band) => band.id)).size,
    layout.bands.length,
  );
  assert.equal(
    layout.bands.filter((band) => band.label.includes("与我关系待补充")).length,
    3,
  );
  assert.ok(
    nodes.mother.y > nodes.child.y,
    "a truly isolated person stays in the pending area",
  );
  const linked = byId(
    buildStarLayout(
      allPeople,
      [...allRelations, { from: "father", to: "new-member", type: "parent" }],
      "new-member",
      "new-member",
    ),
  );
  assert.equal(linked.father.generation, -1);
  assert.equal(linked.child.y, linked["new-member"].y);
});

test("independent families keep separate relative generations without inventing shared ancestry", () => {
  const allPeople = [
    { id: "me", name: "我" },
    { id: "p1", name: "甲长辈" },
    { id: "c1", name: "甲晚辈" },
    { id: "p2", name: "乙长辈" },
    { id: "c2", name: "乙晚辈" },
  ];
  const layout = buildStarLayout(
    allPeople,
    [
      { from: "p1", to: "c1", type: "parent" },
      { from: "p2", to: "c2", type: "parent" },
    ],
    "me",
    "me",
  );
  const nodes = byId(layout);
  assert.ok(nodes.p1.y < nodes.c1.y);
  assert.ok(nodes.p2.y < nodes.c2.y);
  assert.notEqual(nodes.p1.y, nodes.p2.y);
  for (const id of ["p1", "c1", "p2", "c2"]) {
    assert.equal(nodes[id].generation, null);
    assert.equal(nodes[id].connected, false);
  }
  assert.equal(layout.edges.length, 2);
});
