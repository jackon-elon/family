const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ok = data => ({ok: true, data});
const failure = message => ({ok: false, error: {code: 'FORBIDDEN', message}});
const ready = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve}; }
const circle = {id: 'family-1', name: '家人', type: 'family'};
const member = {id: 'member-1', name: '我', role: 'member', personId: 'me', isSelf: true};
const birthday = {personId: 'old-person', personName: '之前的成员', circleId: circle.id, circleName: circle.name, date: '2026-10-04', daysUntil: 1, birthdayCalendar: 'solar', birthdayText: '阳历10月4日'};

function pageFixture(name, invoke, extraApi = {}) {
  let definition;
  const destinations = [];
  const titles = [];
  const dependencies = {
    '../../services/api': {invoke, isDemoMode: () => true, showApiError() {}, resolvePhotoUrls: async (_, people) => people, ...extraApi},
    '../../utils/navigation': {dateText: () => '', go: value => destinations.push(value), q: encodeURIComponent, toast() {}, confirm: async () => true},
    '../../utils/relationship': {relationshipFor: () => ({label: '家人', path: '我 → 家人', status: 'resolved'})},
    '../../utils/geography': {groupCities: () => ({groups: [], overseas: 0, unmapped: 0, missingCity: 0, incomplete: 0, mappedPeople: 0})},
    './model': {birthdayRows: rows => rows},
    '../events/model': {birthdayRows: rows => rows}
  };
  const source = fs.readFileSync(path.join(__dirname, `../pages/${name}/index.ts`), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText, {
    exports, module: {exports}, Date,
    require(key) {if (!(key in dependencies)) throw new Error(`Unexpected dependency ${key}`); return dependencies[key];},
    Page(value) {definition = value;},
    wx: {reLaunch: value => destinations.push(value.url), setNavigationBarTitle: value => titles.push(value.title)}
  });
  const page = {...definition, circleId: circle.id, personId: 'person-1', data: structuredClone(definition.data), setData(patch, callback) {Object.assign(this.data, patch); callback?.();}};
  return {page, destinations, titles};
}

test('home does not restore a removed family or its birthday after a newer refresh', async () => {
  const slow = deferred(); let listCalls = 0; let birthdayCalls = 0;
  const f = pageFixture('circles', async ({action}) => {
    if (action === 'account.sync') return ok({hasVerifiedPhone: true});
    if (action === 'circle.list') return ++listCalls === 1 ? slow.promise : ok({circles: []});
    if (action === 'join.mine') return ok({applications: []});
    if (action === 'birthday.upcoming') return ok({events: ++birthdayCalls === 1 ? [birthday] : []});
    throw new Error(action);
  });
  const first = f.page.onShow(); await ready();
  await f.page.onShow();
  slow.resolve(ok({circles: [circle]})); await first;
  assert.equal(f.page.data.familyCircles.length, 0);
  assert.equal(f.page.data.birthdayPreview.length, 0);
  assert.equal(f.page.data.loading, false);
});

test('birthday page keeps the latest empty result when an older accessible event arrives late', async () => {
  const slow = deferred(); let birthdayCalls = 0;
  const f = pageFixture('events', async ({action}) => {
    if (action === 'account.sync') return ok({hasVerifiedPhone: true});
    if (action === 'birthday.upcoming') return ++birthdayCalls === 1 ? slow.promise : ok({events: []});
    throw new Error(action);
  });
  const first = f.page.loadData(); await ready();
  await f.page.loadData();
  slow.resolve(ok({events: [birthday]})); await first;
  assert.equal(f.page.data.rows.length, 0);
  assert.equal(f.page.data.error, '');
});

test('unloading birthday page prevents a delayed response from rendering again', async () => {
  const slow = deferred();
  const f = pageFixture('events', async ({action}) => action === 'account.sync' ? ok({hasVerifiedPhone: true}) : slow.promise);
  const first = f.page.loadData(); await ready();
  f.page.onUnload();
  slow.resolve(ok({events: [birthday]})); await first;
  assert.equal(f.page.data.rows.length, 0);
});

function browseResponse(action, person = {id: 'person-1', name: '家人', isClaimed: true}) {
  const values = {
    'account.sync': {hasVerifiedPhone: true}, 'circle.detail': {circle, role: 'member'},
    'person.get': {person}, 'person.list': {persons: [person]}, 'relation.list': {relations: []},
    'member.list': {members: [member]}, 'person.claimMine': {claimRequests: []}, 'person.remark.list': {remarks: {}},
    'person.remark.get': {remark: ''}
  };
  if (!(action in values)) throw new Error(action);
  return ok(values[action]);
}

test('family page ignores an old failed read after a successful retry', async () => {
  const slow = deferred(); let detailCalls = 0;
  const f = pageFixture('circle', async ({action}) => action === 'circle.detail' && ++detailCalls === 1 ? slow.promise : browseResponse(action));
  const first = f.page.loadData(); await ready();
  await f.page.loadData();
  slow.resolve(failure('旧请求无权查看')); await first;
  assert.equal(f.page.data.circle.id, circle.id);
  assert.equal(f.page.data.loadError, '');
  assert.equal(f.page.data.people.length, 1);
});

test('family page ignores an old unauthenticated session result after a verified refresh', async () => {
  const slow = deferred(); let sessionCalls = 0;
  const f = pageFixture('circle', async ({action}) => action === 'account.sync' && ++sessionCalls === 1 ? slow.promise : browseResponse(action));
  const first = f.page.loadData(); await ready();
  await f.page.loadData();
  slow.resolve(ok({hasVerifiedPhone: false})); await first;
  assert.equal(f.page.data.circle.id, circle.id);
  assert.deepEqual(f.destinations, []);
});

test('person detail does not replace the current profile with a delayed older photo load', async () => {
  const slow = deferred(); let personReads = 0; let photos = 0;
  const f = pageFixture('person', async ({action}) => {
    if (action === 'person.get') return ok({person: {id: 'person-1', name: ++personReads === 1 ? '旧姓名' : '新姓名', isClaimed: true}});
    return browseResponse(action);
  }, {resolvePhotoUrls: async (_, people) => ++photos === 1 ? slow.promise : people});
  const first = f.page.loadData(); await ready();
  await f.page.loadData();
  slow.resolve([{id: 'person-1', name: '旧姓名', isClaimed: true, photoUrl: 'old-photo'}]); await first;
  assert.equal(f.page.data.person.name, '新姓名');
  assert.equal(f.page.data.displayName, '新姓名');
  assert.equal(f.titles.at(-1), '新姓名');
});

test('person detail discards a private remark from the previous view after refresh makes this the self profile', async () => {
  const slow = deferred(); let personReads = 0;
  const f = pageFixture('person', async ({action}) => {
    if (action === 'person.get') return ok({person: {id: 'person-1', name: '本人', isClaimed: true, isSelf: ++personReads > 1}});
    if (action === 'person.remark.get') return slow.promise;
    return browseResponse(action);
  });
  const first = f.page.loadData(); await ready();
  assert.equal(f.page.data.remarkLoading, true);
  await f.page.loadData();
  slow.resolve(ok({remark: '之前账号的私密备注'})); await first;
  assert.equal(f.page.data.person.isSelf, true);
  assert.equal(f.page.data.remark, '');
  assert.equal(f.page.data.displayName, '本人');
  assert.equal(f.page.data.remarkLoading, false);
});

test('person refresh clears former editing and contact state when access has been removed', async () => {
  let denied = false;
  const f = pageFixture('person', async ({action}) => action === 'person.get' && denied
    ? failure('你已经被移出') : browseResponse(action, {id: 'person-1', name: '本人', isSelf: true, phone: '13900000000'}));
  await f.page.loadData();
  assert.equal(f.page.data.canEdit, true);
  denied = true;
  await f.page.loadData();
  assert.equal(f.page.data.person, null);
  assert.equal(f.page.data.canEdit, false);
  assert.equal(f.page.data.canClaim, false);
  assert.equal(f.page.data.loadError, '你已经被移出');
});
