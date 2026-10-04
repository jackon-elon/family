const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText, filename);
global.wx = {getStorageSync: () => null, setStorageSync: () => {}, showToast: () => {}, setNavigationBarTitle: () => {}, navigateTo: () => {}, pageScrollTo: () => {}};
const api = require('../services/api.ts');
const originalInvoke = api.invoke;
function pageAt(name) {
  let definition;
  global.Page = value => {definition = value;};
  delete require.cache[require.resolve(`../pages/${name}/index.ts`)];
  require(`../pages/${name}/index.ts`);
  return {...definition, circleId: 'c', personId: 'other', data: structuredClone(definition.data), setData(patch, callback) {Object.assign(this.data, patch); callback?.();}};
}
function handler({role = 'member', self = false, remark = '', failRead = false, failSave = false} = {}) {
  const calls = [];
  const person = {id: 'other', name: '家人', isSelf: self, isClaimed: true, myDelegatedFields: ['name', 'photoFileId']};
  api.invoke = async request => {
    calls.push(request);
    const data = {
      'account.sync': {hasVerifiedPhone: true},
      'circle.detail': {circle: {id: 'c', type: 'family'}, role},
      'person.get': {person}, 'person.list': {persons: [person]},
      'relation.list': {relations: []}, 'person.claimMine': {claimRequests: []},
      'person.remark.get': {remark}, 'person.remark.update': {remark: request.payload?.remark}
    }[request.action];
    if (request.action === 'person.remark.get' && failRead || request.action === 'person.remark.update' && failSave) return {ok: false, error: {code: 'NETWORK', message: '请重试'}};
    if (!data) throw new Error(`unexpected ${request.action}`);
    return {ok: true, data};
  };
  return calls;
}
test.afterEach(() => {api.invoke = originalInvoke;});

test('administrator browsing another person has no edit, photo or relationship mutation route', async () => {
  handler({role: 'admin'});
  const routes = [];
  wx.navigateTo = options => routes.push(options.url);
  const page = pageAt('person');
  await page.loadData();
  assert.equal(page.data.canEdit, false);
  page.onEdit(); page.onPhoto();
  assert.deepEqual(routes, []);
  assert.equal(page.onDelete, undefined);
  assert.equal(page.onSubmitRelationSuggestion, undefined);
  const markup = fs.readFileSync(require.resolve('../pages/person/index.wxml'), 'utf8');
  assert.doesNotMatch(markup, /onSuggest|onDelete|person-edit|onManage/);
});

test('ordinary member can save a private remark without updating shared profile', async () => {
  const calls = handler({remark: '二姨'});
  const page = pageAt('person');
  await page.loadData();
  assert.equal(page.data.remark, '二姨');
  assert.equal(page.data.displayName, '二姨');
  page.onEditRemark();
  page.onRemarkInput({detail: {value: '  二姨，周末方便联系  '}});
  await page.onSaveRemark();
  const writes = calls.filter(call => /update|create/.test(call.action));
  assert.deepEqual(writes, [{action: 'person.remark.update', payload: {circleId: 'c', personId: 'other', remark: '二姨，周末方便联系'}}]);
  assert.equal(page.data.remark, '二姨，周末方便联系');
  assert.equal(page.data.displayName, '二姨，周末方便联系');
  assert.equal(page.data.remarkEditing, false);
  assert.equal(page.data.person.name, '家人');
});

test('remark load failure cannot overwrite a note and save failure retains the draft', async () => {
  let calls = handler({failRead: true});
  const page = pageAt('person');
  await page.loadData();
  assert.equal(page.data.loadError, '');
  assert.equal(page.data.remarkError, '备注暂时无法读取');
  page.onEditRemark(); await page.onSaveRemark();
  assert.equal(page.data.remarkEditing, false);
  assert.equal(calls.some(call => call.action === 'person.remark.update'), false);
  handler({remark: '原备注', failSave: true});
  await page.loadRemark(); page.onEditRemark();
  page.onRemarkInput({detail: {value: '待保存备注'}});
  await page.onSaveRemark();
  assert.equal(page.data.remark, '原备注');
  assert.equal(page.data.remarkDraft, '待保存备注');
  assert.equal(page.data.remarkEditing, true);
  assert.equal(page.data.remarkSaving, false);
  page.onCancelRemark();
  assert.equal(page.data.remarkDraft, '原备注');
});

test('self profile still opens the one account profile editor and has no private note UI', async () => {
  const calls = handler({self: true});
  const routes = [];
  wx.navigateTo = options => routes.push(options.url);
  const page = pageAt('person');
  await page.loadData();
  page.onEdit(); page.onPhoto(); page.onEditRemark();
  assert.deepEqual(routes, ['/pages/profile/index', '/pages/profile/index']);
  assert.equal(calls.some(call => call.action === 'person.remark.get'), false);
  assert.equal(page.data.remarkEditing, false);
});

test('direct editor navigation cannot revive a members legacy delegation', async () => {
  const calls = handler();
  const page = pageAt('person-edit');
  await page.loadData();
  assert.equal(page.data.loadError, '只有管理员可以修改他人资料');
  await page.onSave(); await page.onSavePhoto();
  assert.equal(calls.some(call => /update|upload/.test(call.action)), false);
  const newPage = pageAt('person-edit');
  newPage.personId = ''; newPage.createMode = 'other';
  await newPage.loadData();
  assert.match(newPage.data.loadError, /只有管理员可以添加他人/);
});

test('person deletion remains available in management and connected people route to relationship management', async () => {
  const page = pageAt('manage');
  page.data.people = [{id: 'p1', name: '长辈', isClaimed: false}];
  page.data.relations = [{id: 'r', from: 'p1', to: 'p2', type: 'parent'}];
  let labels;
  wx.showActionSheet = options => {labels = options.itemList;};
  page.onPersonMenu({currentTarget: {dataset: {id: 'p1'}}});
  assert.deepEqual(labels, ['删除人物']);
  api.invoke = async request => {
    assert.equal(request.action, 'relation.list');
    return {ok: true, data: {relations: page.data.relations}};
  };
  wx.showModal = options => options.success({confirm: true});
  await page.onDeletePerson('p1');
  assert.equal(page.data.activeTab, 'relations');
  assert.equal(page.data.relationFocusPersonId, 'p1');
  assert.equal(page.deleteBusy, false);
});


test('clearing a private remark immediately restores the original name', async () => {
  handler({remark: '二姨'});
  const page = pageAt('person'); await page.loadData(); page.onEditRemark();
  page.onRemarkInput({detail: {value: ''}}); await page.onSaveRemark();
  assert.equal(page.data.displayName, '家人'); assert.equal(page.data.remark, '');
  assert.equal(page.data.person.name, '家人');
});
