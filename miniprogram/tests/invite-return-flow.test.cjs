const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const token = 'existing-invitation-token';
const circle = {id: 'family-1', name: '家人', type: 'family'};
const profile = {name: '家人甲', country: '中国', city: '上海', birthday: {calendar: 'solar', month: 1, day: 1}};

function fixture(options = {}) {
  let definition;
  const calls = [];
  const destinations = [];
  const state = {status: 'active', verified: true, memberships: [], applications: [], ...options};
  const invoke = async request => {
    calls.push(request);
    if (request.action === 'invite.preview') return {ok: true, data: {circle, status: state.status, expiresAt: Date.now() + 1000}};
    if (request.action === 'account.sync') return {ok: true, data: {hasVerifiedPhone: state.verified}};
    if (request.action === 'circle.list') return state.membershipError
      ? {ok: false, error: {code: 'NETWORK', message: '成员列表暂未加载'}} : {ok: true, data: {circles: state.memberships}};
    if (request.action === 'join.mine') {
      assert.ok(state.verified, 'anonymous visitors must not look up application identities');
      if (!request.payload.applicationId) assert.equal(request.payload.inviteToken, token);
      return {ok: true, data: {applications: state.applications, hasMore: false}};
    }
    if (request.action === 'account.profile.get') return {ok: true, data: {profile}};
    throw new Error(`Unexpected request ${request.action}`);
  };
  const modules = {
    '../../services/api': {invoke, setDemoMode: () => true, showApiError() {}},
    '../../config': {CLOUD_ENV_ID: ''},
    '../../utils/navigation': {dateText: () => '2026-10-03', q: encodeURIComponent, toast() {}}
  };
  const source = fs.readFileSync(path.join(__dirname, '../pages/apply/index.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {exports, module: {exports}, Date,
    require(name) {if (!(name in modules)) throw new Error(`Unexpected dependency ${name}`); return modules[name];},
    Page(value) {definition = value;},
    wx: {redirectTo: value => destinations.push(value.url), reLaunch: value => destinations.push(value.url), navigateTo: value => destinations.push(value.url)}
  });
  const page = {...definition, data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
  return {page, state, calls, destinations};
}

test('current member can reopen the family record from used, expired or revoked invitations', async () => {
  for (const status of ['used', 'expired', 'revoked']) {
    const f = fixture({status, memberships: [circle]});
    await f.page.onLoad({token});
    assert.equal(f.page.data.canOpenCircle, true, status);
    assert.equal(f.page.data.inviteStateLoading, false);
    f.page.onOpenCircle();
    assert.deepEqual(f.destinations, ['/pages/circle/index?circleId=family-1']);
    await f.page.onSubmit();
    assert.equal(f.calls.some(request => request.action === 'invite.apply' || request.action === 'account.profile.get'), false);
    assert.equal(f.calls[1].action, 'account.sync');
  }
});

test('anonymous visitors to inactive invitations see no membership or application information', async () => {
  for (const status of ['used', 'expired', 'revoked']) {
    const f = fixture({status, verified: false, memberships: [circle], applications: [{id: 'private', circleId: circle.id, status: 'approved', canEnter: true}]});
    await f.page.onLoad({token});
    assert.equal(f.page.data.loginRequired, true);
    assert.equal(f.page.data.canOpenCircle, false);
    assert.equal(f.page.data.application, null);
    assert.deepEqual(f.calls.map(request => request.action), ['invite.preview', 'account.sync']);
    f.page.onOpenCircle();
    assert.deepEqual(f.destinations, []);
    f.page.onLogin();
    assert.equal(f.destinations[0], `/pages/login/index?next=${encodeURIComponent(`/pages/apply/index?token=${token}`)}`);
  }
});

test('logged-in visitors do not gain access from another record membership or an inactive token', async () => {
  for (const status of ['used', 'expired', 'revoked']) {
    const f = fixture({status, memberships: [{...circle, id: 'different-family'}]});
    await f.page.onLoad({token});
    assert.equal(f.page.data.canOpenCircle, false);
    assert.equal(f.page.data.submitted, false);
    f.page.onOpenCircle();
    await f.page.onSubmit();
    assert.deepEqual(f.destinations, []);
    assert.equal(f.calls.some(request => request.action === 'invite.apply' || request.action === 'account.profile.get'), false);
    f.page.onHome();
    assert.deepEqual(f.destinations, ['/pages/circles/index']);
  }
});

test('reopening a pending application restores its real state and does not submit a second application', async () => {
  const application = {id: 'my-pending-application', circleId: circle.id, status: 'pending', createdAt: Date.now(), canEnter: false};
  const f = fixture({applications: [application]});
  await f.page.onLoad({token});
  assert.equal(f.page.applicationId, application.id);
  assert.equal(f.page.data.submitted, true);
  assert.equal(f.page.data.applicationTitle, '等待管理员核对');
  assert.equal(f.page.data.canOpenCircle, false);
  f.page.onOpenCircle();
  await f.page.onSubmit();
  assert.deepEqual(f.destinations, []);
  assert.equal(f.calls.some(request => request.action === 'invite.apply'), false);
  assert.equal(f.calls.find(request => request.action === 'join.mine').payload.inviteToken, token);
});

test('an expired applicant or a former member cannot open the record from historical approval', async () => {
  for (const applicationStatus of ['expired', 'approved']) {
    const f = fixture({status: 'used', applications: [{id: 'my-history', circleId: circle.id, status: applicationStatus, canEnter: false, createdAt: Date.now()}]});
    await f.page.onLoad({token});
    assert.equal(f.page.data.canOpenCircle, false);
    assert.equal(f.page.data.application.status, applicationStatus);
    assert.equal(f.page.data.applicationTitle, applicationStatus === 'expired' ? '邀请已失效' : '曾通过申请');
    f.page.onOpenCircle();
    assert.deepEqual(f.destinations, []);
  }
});

test('active invite without an existing application still offers the ordinary application form', async () => {
  const f = fixture();
  await f.page.onLoad({token});
  assert.equal(f.page.data.profileReady, true);
  assert.equal(f.page.data.profile.name, profile.name);
  assert.equal(f.page.data.submitted, false);
  assert.equal(f.page.data.canOpenCircle, false);
  assert.equal(f.page.data.inviteStateError, '');
});

test('failed membership checks offer retry and never reuse a former positive access result', async () => {
  const f = fixture({status: 'used', memberships: [circle]});
  await f.page.onLoad({token});
  assert.equal(f.page.data.canOpenCircle, true);
  f.state.membershipError = true;
  await f.page.loadAccountProfile();
  assert.equal(f.page.data.canOpenCircle, false);
  assert.equal(f.page.data.inviteStateError, '成员列表暂未加载');
  f.page.onOpenCircle();
  assert.deepEqual(f.destinations, []);
  f.state.membershipError = false;
  f.state.memberships = [];
  await f.page.onRetry();
  assert.equal(f.page.data.canOpenCircle, false);
  assert.equal(f.page.data.inviteStateError, '');
});

test('application status links require positive current access instead of treating a missing flag as permission', async () => {
  const f = fixture({applications: [{id: 'my-history', circleId: circle.id, status: 'approved', createdAt: Date.now()}]});
  await f.page.onLoad({applicationId: 'my-history'});
  f.page.onOpenCircle();
  assert.deepEqual(f.destinations, []);
  f.state.applications[0].canEnter = true;
  await f.page.loadMyStatus();
  f.page.onOpenCircle();
  assert.deepEqual(f.destinations, ['/pages/circle/index?circleId=family-1']);
});
