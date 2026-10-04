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
const call = (action, payload) => invoke({action, payload});
const ok = async (action, payload) => {
  const result = await call(action, payload);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
};
const person = {circleId: 'family_demo', personId: 'f_mom'};
const family = {circleId: 'family_demo'};
const profile = {name: '远方亲戚', country: '中国', city: '杭州', birthday: {calendar: 'solar', month: 6, day: 7}};

test('demo remark names list is private, record scoped and retains long existing content', async () => {
  resetDemoData();
  await ok('person.remark.update', {...person, remark: '字'.repeat(200)});
  await ok('person.remark.update', {circleId: 'class_demo', personId: 'c_sun', remark: '同桌'});
  setDemoActor('demo-dad');
  assert.deepEqual(await ok('person.remark.list', family), {remarks: {}});
  await ok('person.remark.update', {...person, remark: '爱人'});
  assert.deepEqual(await ok('person.remark.list', family), {remarks: {f_mom: '爱人'}});
  setDemoActor('demo-owner');
  assert.deepEqual(await ok('person.remark.list', family), {remarks: {f_mom: '字'.repeat(200)}});
  assert.deepEqual(await ok('person.remark.list', {circleId: 'class_demo'}), {remarks: {c_sun: '同桌'}});
  assert.equal((await call('person.remark.list', {...family, actorId: 'demo-dad'})).error.code, 'INVALID_INPUT');
  assert.notEqual((await ok('person.get', person)).person.name, '字'.repeat(200));
});

test('demo remark names list loses access after leaving and excludes deleted people', async () => {
  resetDemoData();
  setDemoActor('demo-dad');
  await ok('person.remark.update', {...person, remark: '旧备注'});
  setDemoActor('demo-owner');
  await ok('member.remove', {...family, memberId: 'm_f_dad'});
  setDemoActor('demo-dad');
  assert.equal((await call('person.remark.list', family)).error.code, 'FORBIDDEN');
  const db = storage.get('kin-network-demo-db-v2');
  db.members.push({id: 'new-dad-member', circleId: 'family_demo', actorId: 'demo-dad', status: 'joined', role: 'member'});
  assert.deepEqual(await ok('person.remark.list', family), {remarks: {}});
  setDemoActor('demo-owner');
  await ok('person.remark.update', {circleId: 'class_demo', personId: 'c_sun', remark: '旧同学'});
  await ok('person.delete', {circleId: 'class_demo', personId: 'c_sun'});
  assert.deepEqual(await ok('person.remark.list', {circleId: 'class_demo'}), {remarks: {}});
});

test('demo explicit postponed family relation creates no false edge, is idempotent and remains complete-profile only', async () => {
  resetDemoData();
  const payload = {...family, ...profile};
  const before = await ok('relation.list', family);
  assert.equal((await call('person.create', payload)).error.code, 'RELATION_REQUIRED');
  assert.equal((await call('person.create', {...payload, deferRelation: true, birthday: undefined})).error.code, 'PROFILE_INCOMPLETE');
  const first = await ok('person.create', {...payload, deferRelation: true, requestId: 'postponed-person-1'});
  const replay = await ok('person.create', {...payload, deferRelation: true, requestId: 'postponed-person-1'});
  assert.equal(first.person.id, replay.person.id);
  assert.equal((await call('person.create', {...payload, requestId: 'postponed-person-1'})).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await ok('relation.list', family), before);
  assert.equal((await call('person.create', {...payload, deferRelation: true, initialRelation: {anchorPersonId: 'f_me', kind: 'sibling'}})).error.code, 'INVALID_INPUT');
  assert.equal((await call('person.create', {...payload, deferRelation: 'true'})).error.code, 'INVALID_INPUT');
  assert.equal((await call('person.create', {...payload, circleId: 'class_demo', deferRelation: true})).error.code, 'WRONG_CIRCLE_TYPE');
  setDemoActor('demo-dad');
  assert.equal((await call('person.create', {...payload, deferRelation: true})).error.code, 'FORBIDDEN');
});

test('demo approval explicitly postpones relation only for a new family person', async () => {
  resetDemoData();
  const invite = (await ok('invite.create', family)).invite;
  setDemoActor('demo-guest');
  await ok('account.verifyPhone', {code: 'demo-verified-phone'});
  await ok('account.profile.update', {patch: profile});
  const application = (await ok('invite.apply', {token: invite.token})).application;
  setDemoActor('demo-owner');
  const payload = {...family, applicationId: application.id};
  assert.equal((await call('join.approve', payload)).error.code, 'RELATION_REQUIRED');
  assert.equal((await call('join.approve', {...payload, deferRelation: true, targetPersonId: 'f_mom'})).error.code, 'INVALID_INPUT');
  assert.equal((await call('join.approve', {...payload, deferRelation: true, initialRelation: {anchorPersonId: 'f_me', kind: 'sibling'}})).error.code, 'INVALID_INPUT');
  const before = await ok('relation.list', family);
  await ok('join.approve', {...payload, deferRelation: true});
  assert.deepEqual(await ok('relation.list', family), before);
  setDemoActor('demo-guest');
  const self = (await ok('person.list', family)).persons.find(row => row.isSelf);
  assert.equal(self.name, profile.name);
});
