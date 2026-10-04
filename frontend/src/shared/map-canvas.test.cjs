const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function evaluate(filename, dependencies = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const subject = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name) => dependencies[name] || {},
    subject,
    subject.exports,
  );
  return subject.exports;
}
const { createMapCanvas } = evaluate(path.join(__dirname, "map-canvas.ts"));

function canvasHarness(patched) {
  const pending = new Map();
  let frameId = 0,
    draws = 0;
  const Util = {
    requestAnimFrame(callback, context) {
      const id = ++frameId;
      pending.set(id, () => callback.call(context));
      return id;
    },
    cancelAnimFrame(id) {
      pending.delete(id);
    },
  };
  class Renderer {
    constructor(options) {
      this.options = options;
    }
    static extend(methods) {
      class Child extends this {}
      Object.assign(Child.prototype, methods);
      return Child;
    }
  }
  // Run the installed Leaflet implementation, with just DOM and frame scheduling
  // supplied by this test. This reproduces its synchronous-redraw/removal race.
  const source = path.join(
    path.dirname(require.resolve("leaflet/package.json")),
    "src/layer/vector/Canvas.js",
  );
  const { Canvas } = evaluate(source, {
    "./Renderer": { Renderer },
    "../../core/Util": Util,
    "../../dom/DomUtil": { remove() {} },
    "../../dom/DomEvent": { off() {} },
  });
  const renderer = patched
    ? createMapCanvas({ Canvas, Util }, { pane: "localLand" })
    : new Canvas();
  Object.assign(renderer, {
    _map: {},
    _layers: {},
    _container: { width: 700, height: 400 },
    _ctx: {
      save() {},
      setTransform() {},
      clearRect() {
        draws++;
      },
      restore() {},
    },
  });
  return {
    renderer,
    pending,
    draws: () => draws,
    schedule: () => renderer._requestRedraw({ options: {} }),
    remove() {
      renderer._destroyContainer();
      delete renderer._map;
    },
    flush() {
      for (const [id, callback] of [...pending]) {
        pending.delete(id);
        callback();
      }
    },
  };
}

test("installed Leaflet Canvas reproduces an orphan frame after synchronous redraw and removal", () => {
  const map = canvasHarness(false);
  map.schedule();
  map.renderer._updatePaths();
  assert.equal(
    map.pending.size,
    1,
    "synchronous redraw forgot the scheduled frame",
  );
  map.remove();
  assert.throws(() => map.flush(), TypeError);
});

test("the map-owned renderer cancels the pending frame before a synchronous redraw and remains safe on removal", () => {
  const map = canvasHarness(true);
  map.schedule();
  map.renderer._updatePaths();
  assert.equal(map.draws(), 1);
  assert.equal(map.pending.size, 0);
  map.schedule();
  const lateCallback = [...map.pending.values()][0];
  map.remove();
  assert.equal(map.pending.size, 0);
  assert.doesNotThrow(() => map.flush());
  assert.doesNotThrow(
    lateCallback,
    "a callback already delivered by the browser cannot touch a removed context",
  );
  assert.equal(map.draws(), 1);
});

test("normal scheduled redraws still paint and can schedule another frame", () => {
  const map = canvasHarness(true);
  map.schedule();
  map.flush();
  assert.equal(map.draws(), 1);
  map.schedule();
  assert.equal(map.pending.size, 1);
  map.flush();
  assert.equal(map.draws(), 2);
  map.remove();
});
