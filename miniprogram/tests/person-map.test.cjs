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
const { buildWorldOverview, projectWorldCoordinate } = require('../components/person-map/world-overview-model.ts');
const { groupCities } = require('../utils/geography.ts');

test('map counts reconcile every list member across China and world views', () => {
  const people = [
    {id: 'a', city: '北京', country: '中国', profileComplete: true},
    {id: 'b', city: '上海', country: '中国', profileComplete: true},
    {id: 'c', city: '深圳', country: '中国', profileComplete: true},
    {id: 'd', city: '广州', country: '中国', profileComplete: true},
    {id: 'e', city: '杭州', country: '中国', profileComplete: true},
    {id: 'f', city: '武汉', country: '中国', profileComplete: true},
    {id: 'g', city: '旧金山', country: '美国', profileComplete: true}
  ];
  const china = groupCities(people, 'china');
  assert.equal(china.mappedPeople, 6);
  assert.equal(china.overseas, 1);
  assert.equal(china.mappedPeople + china.overseas + china.missingCity + china.incomplete + china.unmapped, people.length);
  const world = groupCities(people, 'world');
  assert.equal(world.mappedPeople, 7);
  assert.equal(buildPersonMapModel(people, 'world').cities.reduce((count, city) => count + city.count, 0), 7);
});

test('map explains incomplete, missing and unlocated cards rather than silently dropping them', () => {
  const people = [
    {id: 'a', city: '北京', country: '中国', profileComplete: true},
    {id: 'b', city: '奥斯陆郊区', country: '挪威', profileComplete: true},
    {id: 'c', profileComplete: false, city: '上海', country: '中国'},
    {id: 'd'}
  ];
  const world = groupCities(people, 'world');
  assert.deepEqual([world.mappedPeople, world.unmapped, world.incomplete, world.missingCity], [1, 1, 1, 1]);
  assert.equal(buildPersonMapModel(people, 'world').cities.reduce((count, city) => count + city.count, 0), 1);
});

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

test('world overview projects distant continents and groups nearby cities without losing people', () => {
  const people = [
    {id: 'bj', city: '北京', country: '中国'},
    {id: 'sh1', city: '上海', country: '中国'},
    {id: 'sh2', city: '上海', country: '中国'},
    {id: 'ln', city: '伦敦', country: '英国'},
    {id: 'pa', city: '巴黎', country: '法国'},
    {id: 'sf', city: '旧金山', country: '美国'}
  ];
  const cities = buildPersonMapModel(people, 'world').cities;
  const overview = buildWorldOverview(cities, '中国/上海');
  assert.equal(overview.length, 3, 'China, western Europe and California should be visible separately');
  assert.equal(overview.reduce((total, group) => total + group.count, 0), people.length);
  const china = overview.find(group => group.cities.some(city => city.key === '中国/上海'));
  const europe = overview.find(group => group.cities.some(city => city.key === '英国/伦敦'));
  const california = overview.find(group => group.cities.some(city => city.key === '美国/旧金山'));
  assert.equal(china.cityCount, 2);
  assert.equal(china.count, 3);
  assert.equal(china.selected, true);
  assert.equal(europe.cityCount, 2);
  assert.ok(california.x < europe.x && europe.x < china.x);
  assert.ok(overview.every(group => group.x >= 3.5 && group.x <= 96.5 && group.y >= 6 && group.y <= 94));
  assert.deepEqual(projectWorldCoordinate(0, 0), {x: 50, y: Math.min(94, (85 / 145) * 100)});
  const png = fs.readFileSync(require('node:path').join(__dirname, '../components/person-map/world-land.png'));
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 520]);
});

test('world overview cluster reveals its cities and city choice focuses the native map', () => {
  let component;
  global.Component = definition => {component = definition;};
  delete require.cache[require.resolve('../components/person-map/index.ts')];
  require('../components/person-map/index.ts');
  const events = [];
  const instance = {
    properties: {people: [
      {id: 'bj', city: '北京', country: '中国'},
      {id: 'sh', city: '上海', country: '中国'},
      {id: 'sf', city: '旧金山', country: '美国'}
    ], scope: 'world', selectedKey: ''},
    data: {},
    setData(patch) {this.data = {...this.data, ...patch};},
    triggerEvent(name, detail) {events.push({name, detail});}
  };
  component.methods.rebuild.call(instance);
  const china = instance.data.overviewClusters.find(group => group.cityCount === 2);
  component.methods.onOverviewTap.call(instance, {currentTarget: {dataset: {id: china.id}}});
  assert.deepEqual(instance.data.overviewChoiceCities.map(city => city.city).sort(), ['上海', '北京']);
  assert.equal(events.length, 0, 'a cluster asks which city rather than choosing one arbitrarily');
  component.methods.onOverviewCityTap.call(instance, {currentTarget: {dataset: {key: '中国/上海'}}});
  assert.equal(instance.data.overviewChoiceCities.length, 0);
  assert.deepEqual(events[0].detail.personIds, ['sh']);
  instance.properties.selectedKey = '中国/上海';
  component.methods.refreshSelection.call(instance);
  assert.equal(instance.data.centerLongitude, 121.5);
  assert.equal(instance.data.overviewClusters.find(group => group.id === china.id).selected, true);
  instance.properties.selectedKey = '';
  component.methods.refreshSelection.call(instance);
  const defaultView = buildPersonMapModel(instance.properties.people, 'world', '');
  assert.equal(instance.data.centerLongitude, defaultView.centerLongitude, 'clearing the city should restore the default map view');
  assert.equal(instance.data.scale, defaultView.scale);
  const sf = instance.data.overviewClusters.find(group => group.cityCount === 1);
  component.methods.onOverviewTap.call(instance, {currentTarget: {dataset: {id: sf.id}}});
  assert.equal(events[1].detail.city, '旧金山');
});
