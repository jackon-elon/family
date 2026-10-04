const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadPage(name, invoke = async () => { throw new Error('Unexpected API request'); }) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'pages', name, 'index.ts'), 'utf8');
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText;
  const destinations = [];
  const errors = [];
  const modals = [];
  const modules = {
    '../../services/api': {invoke, showApiError: result => errors.push(result.error)},
    '../../utils/navigation': {q: encodeURIComponent, go: url => destinations.push(url), toast() {}},
    '../../utils/birthday-form': {birthdayDayOptions: () => Array.from({length: 31}, (_, i) => `${i + 1} 日`)},
    '../../utils/birthday-calendar': {BirthdayCalendar: class {next() {return null;}}},
    '../../utils/geography': {},
    '../../utils/relationship': {}
  };
  let definition;
  vm.runInNewContext(output, {
    exports: {}, module: {exports: {}}, require: key => modules[key],
    Page: page => {definition = page;},
    wx: {
      redirectTo: ({url}) => destinations.push(url),
      showModal: options => modals.push(options)
    }, Date
  });
  const page = {...definition, data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
  return {page, destinations, errors, modals};
}

function prepareProfile(page) {
  page.circleId = 'family&one';
  page.createSelf = true;
  page.data.loading = false;
  Object.assign(page.data.form, {name: '陈小满', country: '中国', province: '上海', city: '上海'});
  page.data.calendarIndex = 1;
  page.data.monthIndex = 7;
  page.data.dayIndex = 14;
  page.uploadPhoto = async () => true;
}

test('joining with my profile opens the form that collects family relationships', () => {
  const {page, destinations} = loadPage('circle');
  page.circleId = 'family&one';
  page.onAddMyself();
  assert.deepEqual(destinations, ['/pages/person-edit/index?circleId=family%26one&purpose=self']);
});

test('legacy self profile entry saves once and continues to relationship selection without creating an isolated person', async () => {
  const requests = [];
  const {page, destinations} = loadPage('profile', async request => {
    requests.push(request);
    assert.equal(request.action, 'account.profile.update');
    return {ok: true, data: {}};
  });
  prepareProfile(page);
  await page.onSave();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].payload.patch.city, '上海');
  assert.equal(requests[0].payload.patch.birthday.calendar, 'lunar');
  assert.equal(requests[0].payload.patch.birthday.month, 8);
  assert.equal(requests[0].payload.patch.birthday.day, 15);
  assert.deepEqual(destinations, ['/pages/person-edit/index?circleId=family%26one&purpose=self']);
  assert.equal(page.data.saving, false);
});

test('failed shared profile save keeps self enrollment on the current page', async () => {
  const {page, destinations, errors} = loadPage('profile', async () => ({ok: false, error: {code: 'NETWORK', message: '请稍后重试'}}));
  prepareProfile(page);
  await page.onSave();
  assert.deepEqual(destinations, []);
  assert.equal(errors[0].code, 'NETWORK');
  assert.equal(page.data.saving, false);
});

test('failed photo upload does not silently proceed to create a person', async () => {
  const {page, destinations, modals} = loadPage('profile', async () => ({ok: true, data: {}}));
  prepareProfile(page);
  page.uploadPhoto = async () => false;
  await page.onSave();
  assert.deepEqual(destinations, []);
  assert.equal(modals[0].title, '资料已保存，照片未上传');
  assert.equal(page.data.saving, false);
});
