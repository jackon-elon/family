const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText;
  module._compile(output, filename);
};
const storage = new Map();
const scrollCalls = [];
global.wx = {
  getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value),
  getSystemInfoSync: () => ({windowWidth: 375, windowHeight: 667}),
  setNavigationBarTitle: () => {}, pageScrollTo: value => scrollCalls.push(value), showToast: () => {}
};
const api = require('../services/api.ts');
let definition;
global.Page = value => {definition = value;};
require('../pages/circle/index.ts');
const people = () => [
  {id: 'me', circleId: 'family', name: '陈小满', gender: 'male', isSelf: true, isClaimed: true, country: '中国', province: '上海', city: '上海'},
  {id: 'dad', circleId: 'family', name: '陈志远', gender: 'male', isClaimed: false, country: '中国', province: '上海', city: '上海'},
  {id: 'other', circleId: 'family', name: '王阿姨', gender: 'female', isClaimed: false, country: '中国', province: '北京', city: '北京'}
];
const relations = [{id: 'r1', from: 'dad', to: 'me', type: 'parent'}];
function page() {
  const instance = {...definition, circleId: 'family', data: JSON.parse(JSON.stringify(definition.data)), setData(patch, callback) {Object.assign(this.data, patch); callback?.();}};
  Object.assign(instance.data, {circle: {id: 'family', name: '家人', type: 'family'}, people: people(), relations, selfId: 'me', loading: false});
  instance.rebuild();
  return instance;
}
function deferred() {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};}
function responseFor(action) {
  if (action === 'account.sync') return {ok: true, data: {hasVerifiedPhone: true}};
  if (action === 'circle.detail') return {ok: true, data: {circle: {id: 'family', name: '家人', type: 'family'}, role: 'member'}};
  if (action === 'person.list') return {ok: true, data: {persons: people()}};
  if (action === 'relation.list') return {ok: true, data: {relations}};
  if (action === 'member.list') return {ok: true, data: {members: [{id: 'm', name: '陈小满', isSelf: true}]}};
  if (action === 'person.claimMine') return {ok: true, data: {claimRequests: []}};
  throw new Error(`Unexpected API: ${action}`);
}

test('graph details toggle in place, switch people and place the floating card away from the tapped node', async () => {
  const p = page(); scrollCalls.length = 0;
  await p.onStarSelect({detail: {personId: 'dad', clientY: 550}});
  assert.equal(p.data.selectedStar.id, 'dad');
  assert.equal(p.data.starCardPlacement, 'top');
  await p.onStarSelect({detail: {personId: 'dad', clientY: 550}});
  assert.equal(p.data.selectedStar, null);
  assert.equal(p.data.selectedStarId, '');
  await p.onStarSelect({detail: {personId: 'dad', clientY: 120}});
  assert.equal(p.data.starCardPlacement, 'bottom');
  await p.onStarSelect({detail: {personId: 'other', clientY: 140}});
  assert.equal(p.data.selectedStar.id, 'other');
  p.onStarClear();
  assert.equal(p.data.selectedStar, null);
  assert.deepEqual(scrollCalls, []);
});

test('a late photo response cannot reopen a closed card or overwrite a later selection of the same person', async () => {
  const p = page(); p.data.people.find(person => person.id === 'dad').hasPhoto = true;
  const original = api.invoke; const first = deferred(); const second = deferred(); let requests = 0;
  api.invoke = request => {assert.equal(request.action, 'photo.url'); return (++requests === 1 ? first : second).promise;};
  try {
    const firstOpen = p.onStarSelect({detail: {personId: 'dad', clientY: 500}});
    p.onStarClear();
    assert.equal(p.data.selectedStar, null);
    const secondOpen = p.onStarSelect({detail: {personId: 'dad', clientY: 500}});
    first.resolve({ok: true, data: {url: 'old-photo'}}); await firstOpen;
    assert.equal(p.data.selectedStar.id, 'dad');
    assert.equal(p.data.people.find(person => person.id === 'dad').photoUrl, undefined);
    p.onStarClear();
    second.resolve({ok: true, data: {url: 'later-photo'}}); await secondOpen;
    assert.equal(p.data.selectedStar, null);
  } finally {api.invoke = original;}
});

test('personal remarks name list, map and graph cards while originals remain searchable and kinship remains intact', async () => {
  const p = page(); p.setData({remarks: {dad: '  老爸  '}}); p.rebuild();
  const row = p.data.rows.find(person => person.id === 'dad');
  assert.equal(row.displayName, '老爸'); assert.equal(row.originalName, '陈志远');
  assert.equal(row.name, '陈志远'); assert.equal(row.hasRemark, true);
  assert.equal(p.data.graphRows.find(person => person.id === 'dad').name, '老爸');
  assert.equal(p.data.mapRows.find(person => person.id === 'dad').name, '老爸');
  assert.equal(row.relationLabel, '爸爸');
  assert.equal(p.data.people.find(person => person.id === 'dad').name, '陈志远');
  for (const query of ['老爸', '陈志远']) {
    p.onSearch({detail: {value: query}});
    assert.deepEqual(p.data.rows.map(person => person.id), ['dad']);
    assert.equal(p.data.graphRows.find(person => person.id === 'dad').isDimmed, false);
  }
  await p.onStarSelect({detail: {personId: 'dad'}});
  assert.equal(p.data.selectedStar.displayName, '老爸');
  p.setData({remarks: {}}); p.rebuild();
  assert.equal(p.data.selectedStar.displayName, '陈志远');
});

test('a slow or failed remark request does not block the chart and cannot reuse a previous viewer name', async () => {
  const p = page(); p.setData({remarks: {dad: '其他账号的私密备注'}});
  const original = api.invoke; const pending = deferred();
  api.invoke = async request => request.action === 'person.remark.list' ? pending.promise : responseFor(request.action);
  try {
    await p.loadData();
    assert.equal(p.data.loading, false);
    assert.equal(p.data.graphRows.length, 3);
    assert.equal(p.data.graphRows.find(person => person.id === 'dad').name, '陈志远');
    pending.resolve({ok: false, error: {code: 'NETWORK', message: 'offline'}});
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(p.data.remarks, {});
    assert.match(p.data.remarkError, /先显示原名/);
    assert.equal(p.data.loadError, '');
  } finally {api.invoke = original;}
});

test('a stale remark response from an earlier load cannot overwrite the current viewer labels', async () => {
  const p = page(); const original = api.invoke; const old = deferred(); let reads = 0;
  api.invoke = async request => request.action === 'person.remark.list'
    ? ++reads === 1 ? old.promise : {ok: true, data: {remarks: {dad: '当前备注'}}}
    : responseFor(request.action);
  try {
    await p.loadData(); await p.loadData();
    old.resolve({ok: true, data: {remarks: {dad: '旧账号备注'}}});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(p.data.graphRows.find(person => person.id === 'dad').name, '当前备注');
  } finally {api.invoke = original;}
});

test('graph background clears selection, dragging does not, and person taps carry screen position', () => {
  let componentDefinition; global.Component = value => {componentDefinition = value;};
  require('../components/star-network/index.ts');
  const events = []; const component = {...componentDefinition.methods, triggerEvent: (name, detail) => events.push({name, detail})};
  component.onPerson({currentTarget: {dataset: {id: 'dad'}}, detail: {y: 1200}, changedTouches: [{clientY: 550}]});
  assert.deepEqual(events.shift(), {name: 'person', detail: {personId: 'dad', clientY: 550}});
  component.onBackground(); assert.equal(events.shift().name, 'clear');
  component.lastDragAt = Date.now(); component.onBackground(); assert.deepEqual(events, []);
});


test('city view starts in China, accounts for overseas relatives and shows everyone after switching to world', () => {
  const p = page();
  p.data.people.push({id: 'overseas', name: '海外家人', country: '美国', city: '旧金山', latitude: 37.7749, longitude: -122.4194});
  p.rebuild();
  p.onTab({currentTarget: {dataset: {tab: 'map'}}});
  assert.equal(p.data.mapScope, 'china');
  assert.equal(p.data.filteredCount, 4);
  assert.equal(p.data.mappedPeople, 3);
  assert.equal(p.data.overseas, 1);
  assert.equal(p.data.unmappedRows[0].id, 'overseas');
  p.onScope({currentTarget: {dataset: {scope: 'world'}}});
  assert.equal(p.data.mappedPeople, 4);
  assert.equal(p.data.unmappedRows.length, 0);
  assert.equal(p.data.rows.length, 4);
});
