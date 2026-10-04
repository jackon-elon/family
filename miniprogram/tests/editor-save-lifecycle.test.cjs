const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

function makePage(name, api) {
  let definition;
  let nextRequest = 0;
  const calls = [], redirects = [], messages = [], opened = [];
  const modules = {
    '../../services/api': {
      invoke: async request => { calls.push(request); return api(request); },
      isDemoMode: () => false,
      showApiError: result => messages.push(result.error.message)
    },
    '../../utils/navigation': {confirm: async () => true, newRequestId: () => `request-${++nextRequest}`, q: encodeURIComponent, toast: message => messages.push(message)},
    '../../utils/birthday-form': {
      birthdayDayOptions: () => Array.from({length: 31}, (_, index) => `${index + 1} 日`),
      birthdayDayIndex: (index, days) => index < days.length ? index : -1
    },
    '../../utils/birthday-calendar': {BirthdayCalendar: class { next() { return null; } }}
  };
  const source = fs.readFileSync(path.join(__dirname, `../pages/${name}/index.ts`), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText;
  vm.runInNewContext(compiled, {
    exports: {}, require: module => modules[module], Page: page => { definition = page; },
    wx: {
      setStorageSync() {}, setNavigationBarTitle() {}, showModal() {}, navigateBack() {},
      navigateTo: options => opened.push(options),
      redirectTo: options => { redirects.push(options.url); options.fail?.({errMsg: 'redirectTo:fail'}); }
    }
  });
  const page = {...definition, data: structuredClone(definition.data), setData(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let target = this.data;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts.at(-1)] = value;
    }
  }};
  return {page, calls, redirects, messages, opened};
}

const success = {ok: true, data: {}};
const failed = {ok: false, error: {code: 'NETWORK', message: '连接失败，请重试'}};
function readyPerson(page) {
  page.circleId = 'family'; page.personId = ''; page.createMode = 'other';
  Object.assign(page.data, {
    loading: false, isAdmin: true, circle: {id: 'family', type: 'family'},
    calendarIndex: 1, monthIndex: 7, dayIndex: 14,
    relationTargetIds: ['dad'], relationTargetIndex: 1,
    relationTargetPersonNames: ['爸爸'], relationKindIndex: 7,
    editable: Object.fromEntries(['name', 'nickname', 'gender', 'birthOrder', 'country', 'province', 'city', 'birthday', 'status', 'school', 'industry', 'occupation', 'bio', 'phone', 'wechatId', 'photoFileId', 'matchPhone'].map(field => [field, true]))
  });
  Object.assign(page.data.form, {name: '李明', gender: 'male', country: '中国', province: '四川', city: '成都', birthYear: '1992', phone: '13800138000', occupation: '教师'});
}
function readyProfile(page) {
  page.data.loading = false;
  Object.assign(page.data.form, {name: '李明', country: '中国', province: '四川', city: '成都', birthYear: '1992'});
  page.data.calendarIndex = 1; page.data.monthIndex = 7; page.data.dayIndex = 14;
}
function input(page, field, value) { page.onInput({currentTarget: {dataset: {field}}, detail: {value}}); }
const change = value => ({detail: {value}});

test('failed navigation after creating a circle retries opening the result without creating again', async () => {
  const {page, calls, redirects} = makePage('create', () => ({ok: true, data: {circle: {id: 'created-circle'}}}));
  page.onLoad(); page.data.name = '家人';
  await page.onSubmit(); await page.onSubmit();
  assert.equal(calls.filter(call => call.action === 'circle.create').length, 1);
  assert.equal(redirects.length, 2);
  assert.ok(redirects.every(url => url.endsWith('circleId=created-circle')));
});

test('failed navigation after adding a family member retries opening without repeated person or photo writes', async () => {
  const {page, calls, redirects} = makePage('person-edit', request => request.action === 'person.create'
    ? {ok: true, data: {person: {id: 'created-person', isSelf: false}}} : success);
  readyPerson(page);
  let uploads = 0; page.uploadSelectedPhoto = async () => { uploads++; return true; };
  await page.onSave(); await page.onSave();
  assert.equal(calls.filter(call => call.action === 'person.create').length, 1);
  assert.equal(calls.filter(call => call.action === 'person.update').length, 1);
  assert.equal(uploads, 1);
  assert.equal(redirects.length, 2);
  assert.ok(redirects.every(url => url.endsWith('personId=created-person')));
});

test('family submission keeps city, birthday and relation stable while saving and retains the draft on failure', async () => {
  const pending = deferred();
  const {page, calls, opened} = makePage('person-edit', () => pending.promise);
  readyPerson(page);
  page.onChooseCityPoint();
  const draft = JSON.stringify(page.data.form);
  const saving = page.onSave();
  assert.equal(page.data.saving, true);
  input(page, 'name', '被丢失的新姓名'); input(page, 'phone', '13900139000');
  page.onCalendar(change('0')); page.onBirthMonth(change('0')); page.onBirthDay(change('0')); page.onLeapMonth(change(true));
  page.onGender(change('2')); page.onStatus(change('2')); page.onRelationTarget(change('0')); page.onRelationKind(change('2')); page.onRelationOlder(change('1'));
  page.onChooseCityPoint();
  opened[0].events.cityLocationSelected({country: '中国', province: '浙江', city: '杭州', latitude: 30, longitude: 120});
  assert.equal(opened.length, 1);
  assert.equal(JSON.stringify(page.data.form), draft);
  assert.equal(page.data.calendarIndex, 1); assert.equal(page.data.monthIndex, 7); assert.equal(page.data.dayIndex, 14);
  assert.equal(page.data.relationTargetIndex, 1); assert.equal(page.data.relationKindIndex, 7);
  pending.resolve(failed); await saving;
  assert.equal(page.data.saving, false); assert.equal(JSON.stringify(page.data.form), draft);
  assert.equal(calls[0].payload.birthday.calendar, 'lunar');
  input(page, 'name', '修改后重试'); assert.equal(page.data.form.name, '修改后重试');
});

test('profile submission locks edits only during the request and keeps the chosen photo for retry', async () => {
  const pending = deferred();
  const {page, opened} = makePage('profile', () => pending.promise);
  readyProfile(page); page.photoPath = 'wxfile://prepared-photo'; page.data.photoSelected = true;
  page.onChooseCityPoint();
  const draft = JSON.stringify(page.data.form);
  const saving = page.onSave();
  input(page, 'name', '被丢失的新姓名'); page.onGender(change('2')); page.onStatus(change('2'));
  page.onCalendar(change('0')); page.onBirthMonth(change('0')); page.onBirthDay(change('0')); page.onLeapMonth(change(true));
  page.onChooseCityPoint();
  opened[0].events.cityLocationSelected({country: '中国', province: '浙江', city: '杭州', latitude: 30, longitude: 120});
  assert.equal(opened.length, 1); assert.equal(JSON.stringify(page.data.form), draft);
  assert.equal(page.data.calendarIndex, 1); assert.equal(page.data.monthIndex, 7); assert.equal(page.data.dayIndex, 14);
  pending.resolve(failed); await saving;
  assert.equal(page.data.saving, false); assert.equal(page.photoPath, 'wxfile://prepared-photo'); assert.equal(page.data.photoSelected, true);
  input(page, 'name', '修改后重试'); assert.equal(page.data.form.name, '修改后重试');
});

test('circle submission preserves its draft during a pending request and allows changes after failure', async () => {
  const pending = deferred();
  const {page} = makePage('create', () => pending.promise);
  page.onLoad(); page.data.name = '家人';
  const saving = page.onSubmit();
  input(page, 'name', '同学'); page.chooseType({currentTarget: {dataset: {type: 'classmate'}}});
  assert.equal(page.data.name, '家人'); assert.equal(page.data.type, 'family');
  pending.resolve(failed); await saving;
  input(page, 'name', '新名字'); assert.equal(page.data.name, '新名字');
});
