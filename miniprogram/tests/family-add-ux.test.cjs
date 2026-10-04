const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText;
  module._compile(output, filename);
};
const birthdayForm = require('../utils/birthday-form.ts');
const complete = {name: '李明', gender: 'male', country: '中国', province: '四川', city: '成都', birthday: {calendar: 'lunar', month: 8, day: 15, year: 1992}};
function plain(value) {return JSON.parse(JSON.stringify(value));}
function makePage(options = {}) {
  const calls = [], messages = [];
  const people = options.people ?? [{id: 'anchor', name: '李华', city: '成都'}];
  const circle = {id: 'family', type: 'family'};
  let definition;
  const invoke = async request => {
    calls.push(request);
    switch (request.action) {
      case 'circle.detail': return {ok: true, data: {circle, role: options.role || 'owner'}};
      case 'person.list': return {ok: true, data: {persons: people}};
      case 'person.claimMine': return {ok: true, data: {claimRequests: []}};
      case 'account.profile.get': return options.profileError ? {ok: false, error: {code: 'NETWORK', message: '资料加载失败'}} : {ok: true, data: {profile: options.profile || null}};
      case 'person.get': return {ok: true, data: {person: options.person}};
      case 'person.matchPhone': return {ok: true, data: {matchPhone: options.matchPhone || ''}};
      case 'person.create': return {ok: true, data: {person: {id: 'created', isSelf: options.mode === 'self'}}};
      case 'person.update': return {ok: true, data: {person: {id: options.person?.id || 'created'}}};
      default: throw new Error(`Unexpected action ${request.action}`);
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '../pages/person-edit/index.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText;
  const modules = {
    '../../services/api': {invoke, isDemoMode: () => true, resolvePhotoUrls: async (_id, persons) => persons, showApiError: result => messages.push(result.error.message)},
    '../../utils/navigation': {confirm: async () => true, newRequestId: () => 'request-1', q: encodeURIComponent, toast: message => messages.push(message)},
    '../../utils/birthday-form': birthdayForm
  };
  vm.runInNewContext(compiled, {exports: {}, require: name => modules[name], Page: page => {definition = page;}, wx: {setNavigationBarTitle() {}, redirectTo() {}, showModal() {}}});
  const page = {...definition, circleId: 'family', createMode: options.mode || 'other', personId: options.person?.id || '', data: structuredClone(definition.data), setData(patch) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.split('.'); let target = this.data;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts.at(-1)] = value;
    }
  }};
  return {page, calls, messages};
}
function fillBasic(page) {Object.assign(page.data.form, complete, {birthday: undefined, birthYear: '1992'}); page.data.monthIndex = 7; page.data.dayIndex = 14;}
function selectTitle(page, title) {
  const index = page.data.relationKindOptions.findIndex(option => option.endsWith(`的${title}`));
  assert.ok(index > 0, `Missing relation title ${title}`);
  page.onRelationKind({detail: {value: String(index)}});
}

test('common family titles save the correct relationship direction, gender and seniority', async () => {
  const titles = [
    ['爸爸', 'newParent', 'male'], ['妈妈', 'newParent', 'female'],
    ['哥哥', 'sibling', 'male', 'new'], ['姐姐', 'sibling', 'female', 'new'],
    ['弟弟', 'sibling', 'male', 'anchor'], ['妹妹', 'sibling', 'female', 'anchor'],
    ['儿子', 'newChild', 'male'], ['女儿', 'newChild', 'female'],
    ['丈夫', 'spouse', 'male'], ['妻子', 'spouse', 'female']
  ];
  for (const [title, kind, gender, older] of titles) {
    const {page, calls} = makePage(); await page.loadData(); fillBasic(page); selectTitle(page, title);
    await page.onSave();
    const payload = calls.find(request => request.action === 'person.create').payload;
    assert.equal(payload.gender, gender, title);
    assert.deepEqual(plain(payload.initialRelation), {anchorPersonId: 'anchor', kind, ...(older ? {older} : {})}, title);
  }
});

test('gender changes invalidate a contradictory title and unknown relationships remain available', async () => {
  const {page, calls, messages} = makePage(); await page.loadData(); fillBasic(page);
  selectTitle(page, '爸爸'); page.onGender({detail: {value: '2'}});
  assert.equal(page.data.relationKindIndex, 0);
  await page.onSave(); assert.equal(calls.some(request => request.action === 'person.create'), false);
  assert.ok(messages.includes('性别已更改，请重新选择关系'));
  selectTitle(page, '兄弟姐妹（按生日判断长幼）');
  assert.equal(page.data.relationNeedsOlder, true);
  await page.onSave();
  assert.deepEqual(plain(calls.find(request => request.action === 'person.create').payload.initialRelation), {anchorPersonId: 'anchor', kind: 'sibling', older: 'unknown'});
});

test('any recorded family member can anchor a new relation regardless of login', async () => {
  const {page, calls} = makePage({people: [{id: 'self', name: '我', isSelf: true}, {id: 'dad', name: '爸爸', isClaimed: false}]});
  await page.loadData(); fillBasic(page); page.onRelationTarget({detail: {value: '2'}}); selectTitle(page, '哥哥'); await page.onSave();
  assert.equal(calls.find(request => request.action === 'person.create').payload.initialRelation.anchorPersonId, 'dad');
});

test('self creation preloads one profile and preserves optional values while details are collapsed', async () => {
  const profile = {...complete, nickname: '小明', phone: '13800138000', wechatId: 'liming', industry: '教育', occupation: '教师', school: '一中', bio: '周末回家', photoUrl: 'wxfile://saved-photo'};
  const {page, calls} = makePage({mode: 'self', role: 'member', profile});
  await page.loadData();
  assert.equal(page.data.selfProfileReady, true); assert.equal(page.data.optionalExpanded, false);
  assert.equal(page.data.form.city, '成都'); assert.equal(page.data.calendarIndex, 1); assert.equal(page.data.monthIndex, 7); assert.equal(page.data.dayIndex, 14);
  selectTitle(page, '儿子'); await page.onSave();
  const patch = calls.find(request => request.action === 'person.update').payload.patch;
  for (const key of ['nickname', 'phone', 'wechatId', 'industry', 'occupation', 'school', 'bio']) assert.equal(patch[key], profile[key], key);
  assert.deepEqual(plain(patch.birthday), complete.birthday);
  assert.equal(calls.find(request => request.action === 'person.create').payload.claimSelf, true);
});

test('failed self profile load prevents empty values overwriting the account profile', async () => {
  const {page, calls} = makePage({mode: 'self', profileError: true}); await page.loadData(); await page.onSave();
  assert.equal(page.data.loadError, '资料加载失败');
  assert.equal(calls.some(request => request.action === 'person.create' || request.action === 'person.update'), false);
});

test('administrators can fill photos and contact details when adding a person and enter one mobile number', async () => {
  const {page, calls} = makePage(); await page.loadData(); fillBasic(page); selectTitle(page, '女儿');
  assert.equal(page.data.editable.photoFileId, true); assert.equal(page.data.editable.phone, true);
  page.onInput({currentTarget: {dataset: {field: 'phone'}}, detail: {value: '13800138000'}});
  await page.onSave();
  assert.equal(calls.find(request => request.action === 'person.create').payload.matchPhone, '13800138000');
  assert.equal(calls.find(request => request.action === 'person.update').payload.patch.phone, '13800138000');
});

test('the first family person needs no relation and editing keeps hidden optional values', async () => {
  const first = makePage({people: []}); await first.page.loadData(); fillBasic(first.page); await first.page.onSave();
  assert.equal(first.calls.find(request => request.action === 'person.create').payload.initialRelation, undefined);
  const person = {...complete, id: 'existing', isClaimed: true, nickname: '旧昵称', occupation: '教师', phone: '13900139000', birthOrder: 2};
  const edit = makePage({person}); await edit.page.loadData();
  assert.equal(edit.page.data.optionalExpanded, false); edit.page.data.form.name = '新姓名'; await edit.page.onSave();
  const patch = edit.calls.find(request => request.action === 'person.update').payload.patch;
  assert.equal(patch.name, '新姓名'); assert.equal(patch.nickname, '旧昵称'); assert.equal(patch.occupation, '教师'); assert.equal(patch.phone, '13900139000'); assert.equal(patch.birthOrder, 2);
});


test('unknown family relations require an explicit choice and turning it off restores the relation check', async () => {
  const {page, calls} = makePage(); await page.loadData(); fillBasic(page);
  await page.onSave();
  assert.equal(calls.some(call => call.action === 'person.create'), false);
  page.onDeferRelation({detail: {value: true}});
  page.onDeferRelation({detail: {value: false}});
  await page.onSave();
  assert.equal(calls.some(call => call.action === 'person.create'), false);
  page.onDeferRelation({detail: {value: true}});
  await page.onSave();
  const payload = calls.find(call => call.action === 'person.create').payload;
  assert.equal(payload.deferRelation, true);
  assert.equal(payload.initialRelation, undefined);
  assert.deepEqual(plain(payload.birthday), {...complete.birthday, calendar: 'solar'});
});

test('deferring a preselected relation sends only the defer flag and does not skip required profile fields', async () => {
  const {page, calls} = makePage(); await page.loadData(); fillBasic(page); selectTitle(page, '妈妈');
  page.onDeferRelation({detail: {value: true}});
  page.data.form.city = '';
  await page.onSave();
  assert.equal(calls.some(call => call.action === 'person.create'), false);
  page.data.form.city = '成都'; await page.onSave();
  const payload = calls.find(call => call.action === 'person.create').payload;
  assert.equal(payload.deferRelation, true); assert.equal(payload.initialRelation, undefined);
});


test('recovering an uncertain creation keeps the idempotent relation and tells the user what was saved', async () => {
  const {page, calls, messages} = makePage(); await page.loadData(); fillBasic(page); selectTitle(page, '妈妈');
  page.pendingCreatePayload = {circleId: 'family', name: '李明', gender: 'male', country: '中国', province: '四川', city: '成都', birthday: complete.birthday, deferRelation: true};
  page.createRequestId = 'uncertain-request';
  await page.onSave();
  const payload = calls.find(call => call.action === 'person.create').payload;
  assert.equal(payload.deferRelation, true); assert.equal(payload.initialRelation, undefined); assert.equal(payload.requestId, 'uncertain-request');
  assert.ok(messages.includes('资料已保存，关系沿用上次选择'));
});
