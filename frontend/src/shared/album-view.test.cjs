const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const compiled = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, "album-view.ts"), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const subject = { exports: {} };
new Function("module", "exports", compiled)(subject, subject.exports);
const { initialAlbumView, albumViewReducer } = subject.exports;
const route = { circleId: "family-a", navigationKey: "visit-1", person: null };
const node = { id: "avatar-dad" };

test("an explicit guest birthday opens its full card from any tab without reviving it after close or refresh", () => {
  for (const tab of ["graph", "map", "list"]) {
    let state = albumViewReducer(initialAlbumView(route), { type: "tab", tab });
    state = albumViewReducer(state, {
      type: "select",
      id: "mom",
      anchor: node,
    });
    state = albumViewReducer(state, { type: "birthday", id: "dad" });
    assert.equal(state.tab, "list");
    assert.equal(state.selected, "dad");
    assert.equal(state.anchor, null);
    state = albumViewReducer(state, { type: "close" });
    state = albumViewReducer(state, { type: "navigate", ...route });
    assert.equal(state.selected, null);
    state = albumViewReducer(state, { type: "birthday", id: "dad" });
    assert.equal(state.selected, "dad");
    state = albumViewReducer(state, { type: "tab", tab: "graph" });
    state = albumViewReducer(state, { type: "navigate", ...route });
    assert.equal(state.selected, null);
  }
});

test("switching from graph or map to the family list never carries an open person card", () => {
  for (const from of ["graph", "map", "list"]) {
    for (const to of ["graph", "list", "map"]) {
      let state = albumViewReducer(initialAlbumView(route), {
        type: "tab",
        tab: from,
      });
      state = albumViewReducer(state, {
        type: "select",
        id: "dad",
        anchor: node,
      });
      assert.equal(state.selected, "dad");
      state = albumViewReducer(state, { type: "tab", tab: to });
      assert.equal(state.tab, to);
      assert.equal(state.selected, null);
      assert.equal(state.anchor, null);
    }
  }
});

test("a closed birthday deep link remains closed when the same route is refreshed", () => {
  const destination = { ...route, person: "dad" };
  let state = initialAlbumView(destination);
  assert.equal(state.selected, "dad");
  state = albumViewReducer(state, { type: "close" });
  state = albumViewReducer(state, { type: "navigate", ...destination });
  assert.equal(state.selected, null);
  assert.equal(state.anchor, null);
});

test("switching tabs consumes the current deep link without resurrecting its card", () => {
  const destination = { ...route, person: "dad" };
  let state = initialAlbumView(destination);
  state = albumViewReducer(state, { type: "tab", tab: "list" });
  state = albumViewReducer(state, { type: "navigate", ...destination });
  assert.equal(state.tab, "list");
  assert.equal(state.selected, null);
  state = albumViewReducer(state, { type: "tab", tab: "graph" });
  assert.equal(state.selected, null);
});

test("a new explicit visit to a birthday link can open the person again", () => {
  let state = initialAlbumView({ ...route, person: "dad" });
  state = albumViewReducer(state, { type: "close" });
  state = albumViewReducer(state, {
    type: "navigate",
    ...route,
    navigationKey: "visit-2",
    person: "dad",
  });
  assert.equal(state.selected, "dad");
  assert.equal(state.tab, "graph");
  assert.equal(state.anchor, null);
});

test("navigating to another family resets tab and selection without leaking the old anchor", () => {
  let state = albumViewReducer(initialAlbumView(route), {
    type: "tab",
    tab: "map",
  });
  state = albumViewReducer(state, { type: "select", id: "dad", anchor: node });
  state = albumViewReducer(state, {
    type: "navigate",
    circleId: "family-b",
    navigationKey: "visit-2",
    person: null,
  });
  assert.equal(state.circleId, "family-b");
  assert.equal(state.tab, "graph");
  assert.equal(state.selected, null);
  assert.equal(state.anchor, null);
});

test("clicking the same person, blank space or close clears the associated anchor", () => {
  for (const action of [
    { type: "select", id: "dad", anchor: node },
    { type: "select", id: "" },
    { type: "close" },
  ]) {
    const state = albumViewReducer(
      albumViewReducer(initialAlbumView(route), {
        type: "select",
        id: "dad",
        anchor: node,
      }),
      action,
    );
    assert.equal(state.selected, null);
    assert.equal(state.anchor, null);
  }
});
