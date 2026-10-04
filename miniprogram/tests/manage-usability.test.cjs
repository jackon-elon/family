const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const people = [
  {id: 'dad', name: '陈志远', city: '苏州', gender: 'male', profileComplete: true},
  {id: 'me', name: '陈小满', city: '上海', gender: 'female', profileComplete: true, isSelf: true},
  {id: 'sister', name: 'Alice', city: 'London', gender: 'female', profileComplete: true}
];
const relations = [
  {id: 'parent', circleId: 'family', from: 'dad', to: 'me', type: 'parent'},
  {id: 'sibling', circleId: 'family', from: 'me', to: 'sister', type: 'sibling', olderId: 'me'}
];
const event = dataset => ({currentTarget: {dataset}});
const input = value => ({detail: {value}});
const plain = value => JSON.parse(JSON.stringify(value));

function makePage(onInvoke) {
  const source = fs.readFileSync(path.join(__dirname, '../pages/manage/index.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText;
  const calls = [], errors = [], toasts = [], scrolls = [], confirmations = [], routes = [], sheets = [];
  const responses = {
    'circle.detail': {circle: {id: 'family', name: '陈家亲友录', type: 'family'}, role: 'owner'},
    'person.list': {persons: people}, 'member.list': {members: []}, 'join.list': {applications: []},
    'person.claimList': {claimRequests: []}, 'suggestion.list': {suggestions: []},
    'relation.list': {relations}, 'audit.list': {events: []}
  };
  const modules = {
    '../../services/api': {invoke: async request => {
      calls.push(plain(request));
      if (onInvoke) {
        const override = await onInvoke(request);
        if (override !== undefined) return override;
      }
      assert.ok(responses[request.action], `Unexpected API action ${request.action}`);
      return {ok: true, data: structuredClone(responses[request.action])};
    }, isDemoMode: () => true, showApiError: result => errors.push(result.error.message)},
    '../../utils/navigation': {confirm: async (...args) => {confirmations.push(args); return true;}, dateText: () => '', go: value => routes.push(value), q: value => value, toast: value => toasts.push(value)},
    '../../components/star-network/layout': {buildStarLayout: () => ({nodes: []})},
    '../../utils/relationship': {relationshipFor: () => ({label: '', path: ''})}
  };
  let definition;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, module: {exports}, require: name => {assert.ok(modules[name], name); return modules[name];},
    Page: page => {definition = page;}, wx: {pageScrollTo: options => scrolls.push(options), showActionSheet: options => sheets.push(options)}, Date
  });
  const page = {...definition, circleId: 'family', data: structuredClone(definition.data),
    setData(patch, callback) {Object.assign(this.data, patch); callback?.();}};
  return {page, calls, errors, toasts, scrolls, confirmations, routes, sheets};
}

function readyDraft(page) {
  Object.assign(page.data, {circle: {type: 'family'}, people: structuredClone(people), relations: structuredClone(relations),
    canCreateRelation: true, loading: false, activeTab: 'relations', showRelationEditor: true,
    editingRelationId: 'sibling', fromIndex: 2, toIndex: 3, relationIndex: 2, olderIndex: 1,
    relationPreview: '陈小满与Alice是兄弟姐妹', relationImpact: '称呼会更新。'});
}

test('person relationship entry opens the focused list, then editing and adding use a collapsible form', async () => {
  const {page} = makePage();
  await page.loadData();
  assert.equal(page.data.activeTab, 'people');
  page.onManagePersonRelation(event({id: 'dad'}));
  assert.equal(page.data.activeTab, 'relations');
  assert.equal(page.data.showRelationEditor, false);
  assert.equal(page.data.relationFocusName, '陈志远');
  assert.deepEqual(plain(page.data.relationRows.map(row => row.id)), ['parent']);
  page.onEditRelation(event({id: 'parent'}));
  assert.equal(page.data.showRelationEditor, true);
  assert.equal(page.data.editingRelationId, 'parent');
  assert.equal(page.data.fromIndex, 1);
  assert.equal(page.data.toIndex, 2);
  page.onCancelEdit();
  assert.equal(page.data.showRelationEditor, false);
  assert.equal(page.data.editingRelationId, '');
  assert.equal(page.data.relationFocusPersonId, 'dad');
  page.onStartRelation();
  assert.equal(page.data.showRelationEditor, true);
  assert.equal(page.data.fromIndex, 1, 'adding a relationship keeps the selected family member');
  assert.equal(page.data.toIndex, 0);
  page.onClearRelationFocus();
  assert.equal(page.data.relationRows.length, 2);
  for (const tab of ['settings', 'pending', 'people', 'relations']) {
    page.onTab(event({tab}));
    assert.equal(page.data.activeTab, tab);
  }
  page.data.circle.type = 'classmate';
  page.onTab(event({tab: 'people'}));
  page.onTab(event({tab: 'relations'}));
  assert.equal(page.data.activeTab, 'people');
});

test('management search matches names and cities, survives refresh and clears back to all people', async () => {
  const {page} = makePage();
  await page.loadData();
  page.onPersonSearch(input('小满'));
  assert.deepEqual(plain(page.data.visiblePersonRows.map(row => row.id)), ['me']);
  page.onPersonSearch(input('  LONDON  '));
  assert.deepEqual(plain(page.data.visiblePersonRows.map(row => row.id)), ['sister']);
  await page.loadData();
  assert.deepEqual(plain(page.data.visiblePersonRows.map(row => row.id)), ['sister']);
  page.onPersonSearch(input('杭州'));
  assert.equal(page.data.visiblePersonRows.length, 0);
  page.onPersonSearch(input(''));
  assert.equal(page.data.visiblePersonRows.length, people.length);
});

test('refreshing an open relationship editor keeps selected people by identity instead of list position', async () => {
  let listing = people;
  const {page, calls, toasts} = makePage(async request => request.action === 'person.list' ? {ok: true, data: {persons: structuredClone(listing)}} : undefined);
  await page.loadData();
  page.onEditRelation(event({id: 'parent'}));
  listing = [people[2], people[0], people[1]];
  await page.loadData();
  assert.equal(page.data.people[page.data.fromIndex - 1].id, 'dad');
  assert.equal(page.data.people[page.data.toIndex - 1].id, 'me');
  assert.equal(page.data.showRelationEditor, true);
  listing = [people[2], people[1]];
  await page.loadData();
  assert.equal(page.data.fromIndex, 0, 'a removed selection must require another explicit choice');
  assert.equal(page.data.people[page.data.toIndex - 1].id, 'me');
  await page.onAddRelation();
  assert.equal(calls.some(call => call.action === 'relation.create' || call.action === 'relation.replace'), false);
  assert.deepEqual(toasts, ['请选择两位不同的人物']);
});

test('a rejected relationship save keeps the draft and retry saves directly then collapses it', async () => {
  let succeed = false;
  const {page, calls, errors, confirmations} = makePage(async () => succeed
    ? {ok: true, data: {relation: relations[1]}}
    : {ok: false, error: {code: 'GENERATION_CONFLICT', message: '这条关系与现有辈分关系矛盾'}});
  readyDraft(page);
  let refreshes = 0;
  page.loadData = async () => {refreshes++;};
  const before = plain(page.data);
  await page.onAddRelation();
  assert.equal(page.data.busy, false);
  assert.equal(page.data.showRelationEditor, true);
  for (const field of ['editingRelationId', 'fromIndex', 'toIndex', 'relationIndex', 'olderIndex', 'relationPreview']) {
    assert.equal(page.data[field], before[field]);
  }
  assert.deepEqual(errors, ['这条关系与现有辈分关系矛盾']);
  assert.equal(refreshes, 0);
  succeed = true;
  await page.onAddRelation();
  assert.equal(page.data.showRelationEditor, false);
  assert.equal(page.data.editingRelationId, '');
  assert.equal(refreshes, 1);
  assert.deepEqual(calls.map(call => call.action), ['relation.replace', 'relation.replace']);
  assert.deepEqual(calls[1].payload, {circleId: 'family', relationId: 'sibling', relation: {from: 'me', to: 'sister', type: 'sibling', olderId: 'me'}});
  assert.equal(confirmations.length, 0, 'saving should not add another confirmation dialog');
});

test('relationship save sends once and keeps its draft stable while the request is in flight', async () => {
  let resolve;
  const {page, calls, toasts} = makePage(() => new Promise(done => {resolve = done;}));
  readyDraft(page);
  page.loadData = async () => {};
  const saving = page.onAddRelation();
  assert.equal(page.data.busy, true);
  await page.onAddRelation();
  assert.equal(calls.length, 1);
  page.onCancelEdit();
  assert.equal(page.data.showRelationEditor, true, 'cancel cannot discard a pending save');
  page.onEditRelation(event({id: 'parent'}));
  assert.equal(page.data.editingRelationId, 'sibling', 'a second editor cannot replace the pending draft');
  page.onPick({...event({field: 'olderIndex'}), ...input('2')});
  assert.equal(page.data.olderIndex, 1);
  resolve({ok: true, data: {relation: relations[1]}});
  await saving;
  assert.equal(page.data.busy, false);
  assert.equal(page.data.showRelationEditor, false);
  assert.deepEqual(toasts, ['关系已修改']);
});

test('the same person cannot be submitted as both relationship endpoints', async () => {
  const {page, calls, toasts} = makePage();
  readyDraft(page);
  page.data.toIndex = page.data.fromIndex;
  await page.onAddRelation();
  assert.equal(calls.length, 0);
  assert.equal(page.data.busy, false);
  assert.equal(page.data.showRelationEditor, true);
  assert.deepEqual(toasts, ['请选择两位不同的人物']);
});


test('changing the endpoints of an old sibling relation cannot carry hidden seniority to another person', () => {
  const {page} = makePage(); readyDraft(page);
  page.onPick({...event({field: 'fromIndex'}), ...input('1')});
  assert.equal(page.data.olderIndex, 0);
  assert.doesNotMatch(page.data.relationPreview, /较年长/);
});

test('approval can explicitly defer an unknown family relation but never sends the flag for an existing person', async () => {
  const {page, calls} = makePage(request => request.action === 'join.approve' ? {ok: true, data: {}} : undefined);
  await page.loadData();
  const application = {id: 'pending', targetIndex: 1, applicantName: '新家人', profile: {name: '新家人'}, reviewToken: 'token', relationAnchorIndex: 1, relationKindIndex: 0, deferRelation: true};
  page.data.applications = [application];
  await page.onJoin(event({id: 'pending', decision: 'approve'}));
  const first = calls.find(call => call.action === 'join.approve').payload;
  assert.equal(first.deferRelation, true); assert.equal(first.initialRelation, undefined);
  page.data.people.push({id: 'known', name: '已记录的家人', updatedAt: 123});
  page.data.joinTargetIds = ['', '', 'known'];
  page.data.applications = [{...application, targetIndex: 2}];
  await page.onJoin(event({id: 'pending', decision: 'approve'}));
  const second = calls.filter(call => call.action === 'join.approve').at(-1).payload;
  assert.equal(second.targetPersonId, 'known'); assert.equal(second.deferRelation, undefined); assert.equal(second.initialRelation, undefined);
});

test('member menu offers daily actions by current role, with no transfer or unlink shortcut', async () => {
  const members = [
    {id: 'owner', name: '创建人', role: 'owner', isSelf: true},
    {id: 'admin', name: '管理员甲', role: 'admin'},
    {id: 'member', name: '同学乙', role: 'member'}
  ];
  let actorRole = 'owner';
  const {page, sheets, calls} = makePage(request => {
    if (request.action === 'member.list') return {ok: true, data: {members}};
    if (request.action === 'circle.detail') return {ok: true, data: {circle: {id: 'family', type: 'family'}, role: actorRole}};
  });
  await page.loadData();
  page.onMemberMenu(event({id: 'member'}));
  assert.deepEqual(plain(sheets.at(-1).itemList), ['设为管理员', '移出成员']);
  page.onMemberMenu(event({id: 'admin'}));
  assert.deepEqual(plain(sheets.at(-1).itemList), ['取消管理员', '移出成员']);
  page.onMemberMenu(event({id: 'owner'}));
  assert.equal(sheets.length, 2);
  actorRole = 'admin';
  await page.loadData();
  page.onMemberMenu(event({id: 'admin'}));
  assert.equal(sheets.length, 2, 'peer administrators have no member management menu');
  page.onMemberMenu(event({id: 'member'}));
  assert.deepEqual(plain(sheets.at(-1).itemList), ['移出成员']);
  const count = calls.length;
  await page.performMemberAction(page.data.members[2], 'promote');
  assert.equal(calls.length, count, 'administrator cannot grant roles');
});

test('creating an administrator is separate from transferring the creator and duplicate taps are blocked', async () => {
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  const {page, calls} = makePage(request => request.action === 'member.setRole' ? pending : undefined);
  const member = {id: 'member', name: '同学乙', role: 'member', canManage: true};
  Object.assign(page.data, {isOwner: true, members: [member]});
  page.loadData = async () => {};
  const first = page.performMemberAction(member, 'promote');
  await page.performMemberAction(member, 'promote');
  assert.equal(page.data.memberActionBusy, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {action: 'member.setRole', payload: {circleId: 'family', memberId: 'member', role: 'admin'}});
  release({ok: true, data: {}});
  await first;
  assert.equal(page.data.memberActionBusy, false);
  member.canManage = false;
  await page.performMemberAction({...member, canManage: true}, 'remove');
  assert.equal(page.data.removeCandidateId, '', 'stale menu object cannot override the refreshed member row');
});

test('creator transfer requires an explicit recipient and has a separate guarded request', async () => {
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  const {page, calls, confirmations} = makePage(request => request.action === 'circle.transferOwner' ? pending : undefined);
  Object.assign(page.data, {isOwner: true, members: [{id: 'member', name: '新创建者', role: 'member', canManage: true}], transferMemberIds: ['member']});
  page.loadData = async () => {};
  await page.onRequestOwnerTransfer();
  assert.equal(calls.length, 0);
  page.onToggleTransferSettings();
  page.onTransferMember(input('1'));
  const first = page.onRequestOwnerTransfer();
  await page.onRequestOwnerTransfer();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'circle.transferOwner');
  assert.match(confirmations[0][1], /你仍是管理员/);
  release({ok: true, data: {}}); await first;
  page.data.ownerTransfer = {id: 'existing'};
  await page.onRequestOwnerTransfer();
  assert.equal(calls.length, 1, 'a pending request cannot be overwritten from the page');
  page.onToggleTransferSettings();
  assert.equal(page.data.showTransferSettings, false, 'pending transfer can still be collapsed');
  page.data.ownerTransfer = null; page.data.isOwner = false;
  await page.onRequestOwnerTransfer();
  assert.equal(calls.length, 1);
});

test('correction tasks lead to the editable profile or existing family relationships', async () => {
  const {page, routes} = makePage();
  await page.loadData();
  page.data.suggestions = [
    {id: 'profile', type: 'person', personId: 'dad'},
    {id: 'relation', type: 'relation', personId: 'dad'},
    {id: 'general', type: 'relation'}
  ];
  page.onSuggestionTarget(event({id: 'profile'}));
  assert.equal(routes[0], '/pages/person-edit/index?circleId=family&personId=dad');
  page.onSuggestionTarget(event({id: 'relation'}));
  assert.equal(page.data.activeTab, 'relations');
  assert.equal(page.data.relationFocusPersonId, 'dad');
  assert.equal(page.data.relationRows[0].id, 'parent');
  assert.equal(page.data.showRelationEditor, false);
  page.onSuggestionTarget(event({id: 'general'}));
  assert.equal(page.data.relationFocusPersonId, '');
  assert.equal(page.data.relationRows.length, 2);
});

test('a structured correction with a deleted original edge remains structured', async () => {
  const {page} = makePage(request => request.action === 'suggestion.list' ? {ok: true, data: {suggestions: [
    {id: 'stale', type: 'relation', status: 'pending', relationChange: {removeRelationId: 'gone'}},
    {id: 'text', type: 'relation', status: 'pending'}
  ]}} : undefined);
  await page.loadData();
  assert.equal(page.data.suggestions[0].structuredRelation, true);
  assert.equal(page.data.suggestions[1].structuredRelation, false);
});

test('approval stays single-flight and keeps the selected family relationship while a request is pending', async () => {
  let finish;
  const pending = new Promise(resolve => {finish = resolve;});
  const {page, calls, confirmations, errors} = makePage(request => request.action === 'join.approve' ? pending : undefined);
  await page.loadData();
  page.data.applications = [{id: 'pending', targetIndex: 1, applicantName: '新家人', profile: {name: '新家人'}, reviewToken: 'token', relationAnchorIndex: 1, relationKindIndex: 0, deferRelation: true}];
  page.data.claimRequests = [{id: 'claim', personId: 'dad', applicantName: '爸爸'}];
  const first = page.onJoin(event({id: 'pending', decision: 'approve'}));
  await page.onJoin(event({id: 'pending', decision: 'approve'}));
  await page.onClaim(event({id: 'claim', decision: 'approve'}));
  page.onJoinDeferRelation({...event({id: 'pending'}), detail: {value: false}});
  assert.equal(page.data.reviewBusy, true);
  const requestCount = calls.length; await page.loadData();
  assert.equal(calls.length, requestCount, 'pull-to-refresh cannot discard a review in flight');
  assert.equal(page.data.applications[0].deferRelation, true);
  assert.equal(confirmations.length, 1);
  assert.equal(calls.filter(call => call.action === 'join.approve').length, 1);
  assert.equal(calls.some(call => call.action === 'person.claimApprove'), false);
  finish({ok: false, error: {code: 'NETWORK', message: '连接中断'}}); await first;
  assert.equal(page.data.reviewBusy, false);
  assert.equal(page.data.applications[0].deferRelation, true, 'failed approval retains the draft');
  assert.deepEqual(errors, ['连接中断']);
  await page.onJoin(event({id: 'pending', decision: 'approve'}));
  assert.equal(calls.filter(call => call.action === 'join.approve').length, 2, 'failed request can be retried');
});
