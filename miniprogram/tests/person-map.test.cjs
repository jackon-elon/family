const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText;
  module._compile(output, filename);
};

const { buildPersonMapModel } = require('../components/person-map/model.ts');

test('real map markers group visible city cards and switch China/world scope', () => {
  const people = [
    { id: 'a', city: '上海', country: '中国' },
    { id: 'b', city: '上海', country: '中国' },
    { id: 'c', city: '伦敦', country: '英国' },
    { id: 'd', city: '巴黎', country: '法国' },
    { id: 'hidden', latitude: 39.9, longitude: 116.4 }
  ];
  const china = buildPersonMapModel(people, 'china', '中国/上海');
  assert.equal(china.markers.length, 1);
  assert.deepEqual(china.cities[0].personIds, ['a', 'b']);
  assert.equal(china.markers[0].label.content, '上海 · 2人');
  assert.match(china.markers[0].iconPath, /marker-selected\.png$/);

  const world = buildPersonMapModel(people, 'world');
  assert.equal(world.markers.length, 3);
  assert.equal(world.includePoints.length, 0);
  assert.equal(world.centerLongitude, world.cities[0].longitude);
  assert.deepEqual(world.cities.flatMap(city => city.personIds).sort(), ['a', 'b', 'c', 'd']);
  assert.ok(world.markers.every(marker => Number.isInteger(marker.id) && marker.iconPath.startsWith('/components/')));
});

test('nearby world cities fit together while distant cities focus the self city', () => {
  const nearby = buildPersonMapModel([
    { id: 'london', city: '伦敦', country: '英国' },
    { id: 'paris', city: '巴黎', country: '法国' }
  ], 'world');
  assert.equal(nearby.includePoints.length, 2);

  const distant = buildPersonMapModel([
    { id: 'me', city: '旧金山', country: '美国', isSelf: true },
    { id: 'london', city: '伦敦', country: '英国' }
  ], 'world');
  assert.equal(distant.includePoints.length, 0);
  assert.equal(distant.centerLongitude, -122.4);

  const selected = buildPersonMapModel([
    { id: 'me', city: '旧金山', country: '美国', isSelf: true },
    { id: 'london', city: '伦敦', country: '英国' }
  ], 'world', '英国/伦敦');
  assert.equal(selected.centerLongitude, -0.1);
  assert.equal(selected.scale, 5);
});

test('custom city markers show only rounded city-level coordinates', () => {
  const people = [
    { id: 'city', city: '奥斯陆', country: '挪威', latitude: 59.913868, longitude: 10.752245 },
    { id: 'known', city: '北京', country: '中国', latitude: 39.756, longitude: 116.256 },
    { id: 'invalid', city: '某地', country: '中国', latitude: 200, longitude: 20 },
    { id: 'missing', city: '另一地', country: '中国' }
  ];
  const world = buildPersonMapModel(people, 'world');
  assert.equal(world.cities.length, 2);
  const oslo = world.cities.find(city => city.key === '挪威/奥斯陆');
  const beijing = world.cities.find(city => city.key === '中国/北京');
  assert.deepEqual([oslo.latitude, oslo.longitude], [59.9, 10.8]);
  assert.deepEqual([beijing.latitude, beijing.longitude], [39.8, 116.3]);
});

test('marker tap emits its grouped city and member ids', () => {
  let component;
  global.Component = definition => { component = definition; };
  require('../components/person-map/index.ts');
  const events = [];
  const instance = {
    properties: { people: [{ id: 'one', city: '北京', country: '中国' }], scope: 'china', selectedKey: '' },
    data: {},
    setData(patch) { this.data = { ...this.data, ...patch }; },
    triggerEvent(name, detail) { events.push({ name, detail }); }
  };
  component.methods.rebuild.call(instance);
  component.methods.onMarkerTap.call(instance, { detail: { markerId: 1 } });
  assert.deepEqual(events, [{ name: 'citytap', detail: { key: '中国/北京', city: '北京', country: '中国', personIds: ['one'] } }]);
});
