const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function pageDefinition(pageName, invoke) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'pages', pageName, 'index.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText;
  const navigation = {confirm: async () => true, dateText: () => '', go() {}, q: value => value, toast() {}};
  const modules = {
    '../../services/api': {invoke, isDemoMode: () => true, showApiError() {}},
    '../../utils/navigation': navigation,
    '../../components/star-network/layout': {buildStarLayout: () => ({nodes: []})},
    '../../utils/relationship': {relationshipFor: () => ({label: '', path: ''})}
  };
  let definition;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, module: {exports},
    require: name => {
      if (!(name in modules)) throw new Error(`Unexpected dependency ${name}`);
      return modules[name];
    },
    Page: page => {definition = page;},
    wx: {reLaunch() {}, setNavigationBarTitle() {}},
    Date
  }, {filename: pageName});
  return {...definition, data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
}

function response(action, failRelation) {
  if (action === 'relation.list' && failRelation) return {ok: false, error: {code: 'NETWORK', message: '关系读取失败'}};
  const data = {
    'circle.detail': {circle: {id: 'circle-1', name: '亲友圈', type: 'family'}, role: 'admin'},
    'person.list': {persons: []}, 'member.list': {members: []}, 'join.list': {applications: []},
    'person.claimList': {claimRequests: []}, 'suggestion.list': {suggestions: []},
    'relation.list': {relations: []}, 'audit.list': {events: []}
  }[action];
  if (!data) throw new Error(`Unexpected action ${action}`);
  return {ok: true, data};
}

test('management page reports a failed dependency instead of showing an empty relation list', async () => {
  let failRelation = true;
  const page = pageDefinition('manage', async request => response(request.action, failRelation));
  page.circleId = 'circle-1';
  await page.loadData();
  assert.equal(page.data.loading, false);
  assert.equal(page.data.loadError, '关系读取失败');
  assert.equal(page.data.circle, null);
  failRelation = false;
  await page.onRetry();
  assert.equal(page.data.loadError, '');
  assert.equal(page.data.circle.id, 'circle-1');
});

test('privacy page retries a failed administrator list before offering delegation', async () => {
  let failMembers = true;
  const page = pageDefinition('privacy', async request => {
    if (request.action === 'person.get') return {ok: true, data: {person: {id: 'me', name: '我', isSelf: true, visibility: {}, delegations: []}}};
    if (request.action === 'member.list' && failMembers) return {ok: false, error: {code: 'NETWORK', message: '管理员名单读取失败'}};
    if (request.action === 'member.list') return {ok: true, data: {members: []}};
    if (request.action === 'person.list') return {ok: true, data: {persons: []}};
    throw new Error(`Unexpected action ${request.action}`);
  });
  page.circleId = 'circle-1'; page.personId = 'me';
  await page.loadData();
  assert.equal(page.data.loadError, '管理员名单读取失败');
  assert.equal(page.data.person, null);
  failMembers = false;
  await page.onRetry();
  assert.equal(page.data.loadError, '');
  assert.equal(page.data.person.id, 'me');
  assert.equal(page.data.delegable.length, 10);
});
