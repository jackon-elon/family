const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function deferred() {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};}
function loadPage(name, handler = async () => ({ok: true, data: {}}), confirmation = async () => true) {
  let definition; const calls = [], confirmations = [], messages = [];
  const source = fs.readFileSync(path.join(__dirname, `../pages/${name}/index.ts`), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText;
  const modules = {
    '../../services/api': {invoke: async request => {calls.push(request); return handler(request);}, isDemoMode: () => true, resolvePhotoUrls: async (_id, persons) => persons, showApiError: result => messages.push(result.error.message)},
    '../../utils/navigation': {confirm: async (...args) => {confirmations.push(args); return confirmation(...args);}, toast: message => messages.push(message), q: encodeURIComponent, dateText: () => '10月3日'},
    '../../utils/geography': {}, '../../utils/relationship': {}
  };
  vm.runInNewContext(compiled, {exports: {}, require: name => modules[name], Page: value => {definition = value;}, wx: {switchTab() {}}});
  const page = {...definition, circleId: 'family', personId: 'self-candidate', data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}, loadData: async () => {}};
  return {page, calls, confirmations, messages};
}

test('finding myself submits once without an extra dialog and still waits for administrator confirmation', async () => {
  for (const name of ['circle', 'person']) {
    const pending = deferred();
    const {page, calls, confirmations} = loadPage(name, async () => pending.promise);
    Object.assign(page.data, {canClaim: true, person: {id: 'self-candidate', name: '小满'}, unclaimedPeople: [{id: 'self-candidate', name: '小满'}]});
    const submit = name === 'circle' ? () => page.onClaimPerson({currentTarget: {dataset: {id: 'self-candidate'}}}) : () => page.onClaim();
    const first = submit(); await submit();
    assert.equal(calls.length, 1); assert.equal(calls[0].action, 'person.claim');
    assert.deepEqual(confirmations, []);
    pending.resolve({ok: true, data: {claimRequest: {id: 'claim', status: 'pending'}}}); await first;
    await submit(); assert.equal(calls.length, 1);
    if (name === 'circle') assert.equal(page.data.pendingClaim.status, 'pending');
    else {assert.equal(page.data.claimPending, true); assert.equal(page.data.canClaim, false);}
  }
});

test('a failed request to confirm my profile remains retryable without pretending it succeeded', async () => {
  const {page, calls, messages} = loadPage('person', async () => ({ok: false, error: {code: 'NETWORK', message: '连接中断'}}));
  page.data.canClaim = true;
  await page.onClaim(); await page.onClaim();
  assert.equal(calls.length, 2); assert.equal(page.data.canClaim, true); assert.equal(page.data.claimPending, false);
  assert.equal(page.data.claimBusy, false); assert.deepEqual(messages, ['连接中断', '连接中断']);
});

test('generating an invitation directly enables invitations once and creates one token without redundant confirmation', async () => {
  const pending = deferred();
  const {page, calls, confirmations} = loadPage('invite', async request => {
    if (request.action === 'circle.upgrade') return pending.promise;
    if (request.action === 'invite.create') return {ok: true, data: {invite: {id: 'inv', token: 'token', expiresAt: Date.now() + 1000}}};
    throw new Error(`Unexpected action: ${request.action}`);
  });
  Object.assign(page.data, {circle: {id: 'family', type: 'family', mode: 'private'}, loading: false, demoMode: true});
  const first = page.onGenerate(); await page.onGenerate();
  assert.equal(calls.length, 1);
  pending.resolve({ok: true, data: {circle: {id: 'family', type: 'family', mode: 'shared'}}}); await first;
  assert.deepEqual(calls.map(call => call.action), ['circle.upgrade', 'invite.create']);
  assert.deepEqual(confirmations, []); assert.equal(page.data.invite.token, 'token'); assert.equal(page.data.creating, false);
});

test('accepting creator succession has one clear confirmation and declining needs no second dialog', async () => {
  const decision = deferred();
  const {page, calls, confirmations} = loadPage('circle', undefined, async () => decision.promise);
  page.data.ownerTransfer = {id: 'transfer', isTarget: true};
  const event = {currentTarget: {dataset: {decision: 'accept'}}};
  const first = page.onOwnerTransfer(event); await page.onOwnerTransfer(event);
  assert.equal(confirmations.length, 1); assert.equal(calls.length, 0);
  assert.match(confirmations[0][0], /创建者/); assert.match(confirmations[0][1], /原创建者仍是管理员/);
  decision.resolve(false); await first; assert.equal(page.data.transferBusy, false);
  await page.onOwnerTransfer({currentTarget: {dataset: {decision: 'decline'}}});
  assert.equal(confirmations.length, 1); assert.equal(calls[0].action, 'circle.cancelOwnerTransfer');
});

test('leaving states the actual data loss once, allows cancellation and cannot be triggered by the owner', async () => {
  const choice = deferred();
  const {page, calls, confirmations} = loadPage('circle', undefined, async () => choice.promise);
  Object.assign(page.data, {role: 'member', circle: {type: 'family'}});
  const first = page.onLeave(); await page.onLeave();
  assert.equal(confirmations.length, 1); assert.match(confirmations[0][1], /照片、联系方式等资料会清除/); assert.match(confirmations[0][1], /姓名和亲属关系保留/);
  choice.resolve(false); await first;
  assert.equal(calls.length, 0); assert.equal(page.data.leaving, false);
  page.data.role = 'owner'; await page.onLeave(); assert.equal(confirmations.length, 1);
});
