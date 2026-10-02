const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText;
  module._compile(output, filename);
};

test('native city picker returns only a coarse manually selected point', () => {
  const callbacks = {};
  const emitted = [];
  let navigatedBack = 0;
  let definition;
  const channel = {
    on: (name, callback) => {callbacks[name] = callback;},
    emit: (name, payload) => {emitted.push({name, payload});}
  };
  global.Page = options => {definition = options;};
  global.wx = {
    createMapContext: id => {
      assert.equal(id, 'cityMap');
      return {getCenterLocation: ({success}) => success({latitude: 59.913868, longitude: 10.752245})};
    },
    navigateBack: () => {navigatedBack++;},
    showToast: () => {}
  };
  require('../pages/location-picker/index.ts');
  const page = {
    ...definition,
    data: {...definition.data},
    getOpenerEventChannel: () => channel,
    setData(patch) {this.data = {...this.data, ...patch};}
  };
  page.onLoad();
  assert.deepEqual(page.data.regions.map(region => region.label), ['中国', '亚洲', '欧洲', '非洲', '美洲', '大洋洲']);
  callbacks.initialCityLocation({city: '奥斯陆', country: '挪威', latitude: 59.9, longitude: 10.8});
  assert.deepEqual([page.data.latitude, page.data.longitude], [59.9, 10.8]);
  page.onReady();
  page.onConfirm();
  assert.deepEqual(emitted, [{name: 'cityLocationSelected', payload: {
    city: '奥斯陆', country: '挪威', province: '', latitude: 59.9, longitude: 10.8
  }}]);
  assert.equal(navigatedBack, 1);
});

test('directly opening city picker without an opener shows a safe return path', () => {
  let definition;
  let route = '';
  const toasts = [];
  global.Page = options => {definition = options;};
  global.wx = {
    reLaunch: options => {route = options.url;},
    showToast: options => {toasts.push(options.title);}
  };
  delete require.cache[require.resolve('../pages/location-picker/index.ts')];
  require('../pages/location-picker/index.ts');
  const page = {
    ...definition, data: {...definition.data},
    getOpenerEventChannel: () => undefined,
    setData(patch) {this.data = {...this.data, ...patch};}
  };
  assert.doesNotThrow(() => page.onLoad());
  assert.equal(page.data.hasOpener, false);
  assert.doesNotThrow(() => page.onConfirm());
  assert.match(toasts[0], /人物资料编辑页/);
  page.onBackHome();
  assert.equal(route, '/pages/circles/index');
});
