const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}
  }).outputText, filename);
};

function makeBar(route) {
  let definition;
  global.Component = value => { definition = value; };
  global.getCurrentPages = () => [{route}];
  delete require.cache[require.resolve('../custom-tab-bar/index.ts')];
  require('../custom-tab-bar/index.ts');
  return { ...definition.methods, data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);} };
}

test('bottom navigation uses the current page when reopened or entered directly', () => {
  const bar = makeBar('pages/my/index');
  bar.syncSelection();
  assert.equal(bar.data.selected, 1);
  global.getCurrentPages = () => [{route: 'pages/circles/index'}];
  bar.syncSelection();
  assert.equal(bar.data.selected, 0);
});

test('bottom navigation prevents repeated switches and retains selection on failure', () => {
  const bar = makeBar('pages/circles/index');
  const requests = [];
  const notices = [];
  global.wx = {switchTab: request => requests.push(request), showToast: value => notices.push(value.title)};
  const event = index => ({currentTarget: {dataset: {index}}});
  bar.onSwitch(event(99));
  bar.onSwitch(event(0));
  assert.equal(requests.length, 0);
  bar.onSwitch(event(1)); bar.onSwitch(event(1));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/pages/my/index');
  requests[0].fail(); requests[0].complete();
  assert.equal(bar.data.selected, 0);
  assert.equal(bar.switching, false);
  assert.equal(notices.length, 1);
  bar.onSwitch(event(1)); requests[1].success(); requests[1].complete();
  assert.equal(bar.data.selected, 1);
});
