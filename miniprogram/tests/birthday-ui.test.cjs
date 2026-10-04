const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText;
  module._compile(output, filename);
};

const {birthdayRows} = require('../pages/events/model.ts');

function pageDefinition(name, invoke, destinations) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'pages', name, 'index.ts'), 'utf8');
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText;
  let definition;
  const exports = {};
  const modules = {
    '../../services/api': {invoke, isDemoMode: () => true},
    '../../utils/navigation': {go: url => destinations.push(url), q: encodeURIComponent, dateText: () => '', confirm: async () => true},
    '../events/model': {birthdayRows}
  };
  vm.runInNewContext(output, {
    exports,
    module: {exports},
    require: key => key === './model' ? {birthdayRows} : modules[key],
    Page: page => {definition = page;},
    wx: {setStorageSync() {}, stopPullDownRefresh() {}, reLaunch: ({url}) => destinations.push(url)},
    Date
  }, {filename: name});
  return {...definition, data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
}

function event(daysUntil, overrides = {}) {
  return {
    personId: `person-${daysUntil}`,
    personName: '林芳',
    circleId: 'family-1',
    circleName: '我家',
    date: '2026-10-04',
    daysUntil,
    birthdayCalendar: 'lunar',
    birthdayText: '八月廿四',
    ...overrides
  };
}

test('birthday rows preserve lunar source and order by next occurrence', () => {
  const rows = birthdayRows([event(4), event(0, {date: '2026-10-02'}), event(1, {date: '2026-10-03'})]);
  assert.deepEqual(rows.map(row => row.countdownLabel), ['今天', '明天', '4 天后']);
  assert.equal(rows[0].sourceLabel, '农历 八月廿四');
  assert.equal(rows[0].dateLabel, '10月2日');
  assert.equal(birthdayRows([event(2, {birthdayText: '农历八月廿四'})])[0].sourceLabel, '农历八月廿四');
  assert.equal(birthdayRows([event(-1), event(2, {date: 'bad-date'})]).length, 0);
});

test('home birthday failure does not hide family and class circles', async () => {
  const destinations = [];
  const page = pageDefinition('circles', async request => {
    if (request.action === 'account.sync') return {ok: true, data: {hasVerifiedPhone: true, linked: [], alreadyLinked: [], skipped: 0}};
    if (request.action === 'circle.list') return {ok: true, data: {circles: [{id: 'f', type: 'family', name: '我家'}, {id: 'c', type: 'classmate', name: '同学'}]}};
    if (request.action === 'join.mine') return {ok: true, data: {applications: []}};
    if (request.action === 'birthday.upcoming') return {ok: false, error: {message: '暂不可用'}};
    throw new Error(request.action);
  }, destinations);
  await page.onShow();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.familyCircles.length, 1);
  assert.equal(page.data.classCircles.length, 1);
  assert.match(page.data.birthdayError, /生日暂时无法加载/);
  page.onOpenEvents();
  assert.equal(destinations[0], '/pages/events/index');
});

test('home sends an unverified visitor to phone login before loading private records', async () => {
  const destinations = [];
  const page = pageDefinition('circles', async request => {
    assert.equal(request.action, 'account.sync');
    return {ok: true, data: {hasVerifiedPhone: false}};
  }, destinations);
  await page.onShow();
  assert.deepEqual(destinations, ['/pages/login/index']);
  assert.equal(page.data.familyCircles.length, 0);
});

test('birthday schedule loads next-year events and opens the exact person', async () => {
  const destinations = [];
  let daysUntil = 3;
  const page = pageDefinition('events', async request => {
    if (request.action === 'account.sync') return {ok: true, data: {hasVerifiedPhone: true}};
    assert.equal(request.action, 'birthday.upcoming');
    assert.equal(request.payload.days, 366);
    return {ok: true, data: {events: [event(daysUntil, {personId: 'p/name', circleId: 'c&one'})]}};
  }, destinations);
  await page.onShow();
  assert.equal(page.data.error, '');
  assert.equal(page.data.rows[0].sourceLabel, '农历 八月廿四');
  daysUntil = 2;
  await page.onShow();
  assert.equal(page.data.rows[0].countdownLabel, '2 天后', 'returning from a profile refreshes the schedule');
  page.onPerson({currentTarget: {dataset: {personId: 'p/name', circleId: 'c&one'}}});
  assert.equal(destinations[0], '/pages/person/index?circleId=c%26one&personId=p%2Fname');
});
