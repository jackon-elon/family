const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText;
  module._compile(output, filename);
};

function picker() {
  const callbacks = {};
  const emitted = [];
  const routes = [];
  const toasts = [];
  let definition;
  const channel = {
    on: (name, callback) => {callbacks[name] = callback;},
    emit: (name, payload) => {emitted.push({name, payload});}
  };
  global.Page = options => {definition = options;};
  global.wx = {
    navigateBack: () => {routes.push('back');},
    reLaunch: options => {routes.push(options.url);},
    showToast: options => {toasts.push(options.title);}
  };
  delete require.cache[require.resolve('../pages/location-picker/index.ts')];
  require('../pages/location-picker/index.ts');
  const page = {
    ...definition, data: {...definition.data},
    getOpenerEventChannel: () => channel,
    setData(patch) {this.data = {...this.data, ...patch};}
  };
  page.onLoad();
  const choose = name => {
    const index = page.data.shownOptions.findIndex(option => option.label === name);
    assert.notEqual(index, -1, `option ${name} should exist`);
    page.onSelect({currentTarget: {dataset: {index}}});
  };
  return {page, callbacks, emitted, routes, toasts, choose};
}

test('city picker selects country, province and city without map dragging or GPS', () => {
  const {page, emitted, routes, choose} = picker();
  assert.equal(page.data.stage, 'country');
  assert.equal(page.data.shownOptions[0].label, '中国');
  choose('中国');
  assert.equal(page.data.stage, 'province');
  choose('广东');
  assert.equal(page.data.stage, 'city');
  choose('深圳');
  page.onConfirm();
  assert.deepEqual(emitted, [{name: 'cityLocationSelected', payload: {
    city: '深圳', country: '中国', province: '广东', latitude: 22.5, longitude: 114.1
  }}]);
  assert.deepEqual(routes, ['back']);
});

test('picker filters options and can locate an overseas city', () => {
  const {page, emitted, choose} = picker();
  page.onSearch({detail: {value: '美国'}});
  assert.deepEqual(page.data.shownOptions.map(option => option.label), ['美国']);
  choose('美国');
  choose('California');
  choose('旧金山');
  page.onConfirm();
  assert.deepEqual(emitted[0].payload, {city: '旧金山', country: '美国', province: 'California', latitude: 37.8, longitude: -122.4});
});

test('unlisted city can be saved as a city without inventing a coordinate', () => {
  const {page, emitted, routes} = picker();
  page.onCustom();
  for (const [field, value] of [['country', '挪威'], ['province', '奥斯陆郡'], ['city', '某镇']]) {
    page.onCustomInput({currentTarget: {dataset: {field}}, detail: {value}});
  }
  page.onConfirm();
  assert.deepEqual(emitted[0].payload, {city: '某镇', country: '挪威', province: '奥斯陆郡', latitude: null, longitude: null});
  assert.deepEqual(routes, ['back']);
});

test('unchanged legacy custom city keeps its existing coarse point', () => {
  const {page, callbacks, emitted} = picker();
  callbacks.initialCityLocation({city: '奥斯陆郊区', country: '挪威', province: '奥斯陆郡', latitude: 59.913868, longitude: 10.752245});
  assert.equal(page.data.stage, 'custom');
  page.onConfirm();
  assert.deepEqual([emitted[0].payload.latitude, emitted[0].payload.longitude], [59.9, 10.8]);
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
  assert.match(toasts[0], /资料编辑页/);
  page.onBackHome();
  assert.equal(route, '/pages/circles/index');
});
