const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText, filename);
};
const storage = new Map();
global.wx = {getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), showToast() {}};
const {invoke, resetDemoData, setDemoActor} = require('../services/api.ts');
const call = (action, payload = {}) => invoke({action, payload});
const ok = async (action, payload) => {
  const result = await call(action, payload);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
};
const circleId = 'family_demo';

test('demo exact invitation lookup bypasses the recent-history limit and isolates the current applicant', async () => {
  resetDemoData();
  const db = storage.get('kin-network-demo-db-v2');
  const now = Date.now();
  for (let index = 0; index < 22; index++) {
    db.invites.push({id: `history-invite-${index}`, circleId, token: `history-token-${index}`, expiresAt: now + 3600000});
    db.applications.push({id: `history-app-${index}`, circleId, inviteId: `history-invite-${index}`, actorId: 'demo-guest',
      name: '申请人', status: 'pending', createdAt: now + index});
  }
  db.applications.push({id: 'foreign-app', circleId, inviteId: 'history-invite-0', actorId: 'demo-guest-2', name: '别人', status: 'rejected', createdAt: now});
  db.applications.push({id: 'legacy-app', circleId, inviteId: 'history-invite-0', name: '身份不明的旧数据', status: 'pending', createdAt: now});
  setDemoActor('demo-guest');
  const recent = await ok('join.mine');
  assert.equal(recent.applications.length, 20);
  assert.equal(recent.hasMore, true);
  assert.equal(recent.applications.some(row => row.id === 'history-app-0'), false);
  const query = {inviteToken: 'history-token-0'};
  const exact = await ok('join.mine', query);
  assert.equal(exact.hasMore, false);
  assert.deepEqual(exact.applications.map(row => row.id), ['history-app-0']);
  assert.equal(exact.applications[0].canEnter, false);
  setDemoActor('demo-guest-2');
  assert.deepEqual((await ok('join.mine', query)).applications.map(row => row.id), ['foreign-app']);
  setDemoActor('demo-owner');
  assert.deepEqual(await ok('join.mine', query), {applications: [], hasMore: false});
  for (const inviteToken of ['', 'missing', null, {}]) assert.equal((await call('join.mine', {inviteToken})).error.code, 'INVALID_INVITE');
  assert.equal((await call('join.mine', {...query, applicationId: 'history-app-0'})).error.code, 'INVALID_INPUT');
  setDemoActor('demo-guest');
  storage.get('kin-network-demo-db-v2').invites.find(row => row.id === 'history-invite-0').expiresAt = Date.now();
  const expired = (await ok('join.mine', query)).applications[0];
  assert.equal(expired.status, 'expired');
  assert.equal(expired.inviteStatus, 'expired');
  storage.get('kin-network-demo-db-v2').invites.find(row => row.id === 'history-invite-0').revokedAt = Date.now();
  assert.equal((await ok('join.mine', query)).applications[0].inviteStatus, 'revoked');
  assert.equal((await call('person.list', {circleId})).error.code, 'FORBIDDEN');
});

test('demo used invitation returns the same approval after leaving without allowing entry', async () => {
  resetDemoData();
  const invite = (await ok('invite.create', {circleId})).invite;
  setDemoActor('demo-guest');
  await ok('account.verifyPhone', {code: 'demo-verified-phone'});
  await ok('account.profile.update', {patch: {name: '新家人', country: '中国', province: '浙江', city: '杭州',
    birthday: {calendar: 'solar', year: 1994, month: 6, day: 8}}});
  const application = (await ok('invite.apply', {token: invite.token})).application;
  setDemoActor('demo-owner');
  const review = (await ok('join.list', {circleId})).applications.find(row => row.id === application.id);
  await ok('join.approve', {circleId, applicationId: application.id, reviewToken: review.reviewToken, deferRelation: true});
  setDemoActor('demo-guest');
  const query = {inviteToken: invite.token};
  assert.equal((await ok('join.mine', query)).applications[0].canEnter, true);
  await ok('member.leave', {circleId});
  const old = (await ok('join.mine', query)).applications[0];
  assert.equal(old.status, 'approved');
  assert.equal(old.canEnter, false);
  assert.equal(old.inviteStatus, 'used');
  assert.equal((await call('circle.detail', {circleId})).error.code, 'FORBIDDEN');
});
