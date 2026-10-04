const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}
}).outputText, filename);
const storage = new Map();
global.wx = {getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), showToast() {}};
const {invoke, resetDemoData, setDemoActor} = require('../services/api.ts');
const call = (action, payload = {}) => invoke({action, payload});
const ok = async (action, payload) => {
  const result = await call(action, payload);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
};
const db = () => storage.get('kin-network-demo-db-v2');
const circleId = 'family_demo';
const full = {name: '家人', country: '中国', city: '杭州', birthday: {calendar: 'solar', month: 5, day: 16}};
const card = async extra => (await ok('person.create', {circleId, ...full, deferRelation: true, ...extra})).person;

test('demo claim approvals require a current matching phone and keep failed requests pending', async () => {
  for (const mode of ['wrong', 'missing', 'expired', 'matching']) {
    resetDemoData();
    setDemoActor('demo-dad');
    if (mode !== 'missing') await ok('account.verifyPhone', {code: 'demo-verified-phone'});
    setDemoActor('demo-owner');
    await ok('person.unclaim', {circleId, personId: 'f_dad'});
    const target = await card({matchPhone: mode === 'wrong' ? '13800138009' : '13900139000'});
    setDemoActor('demo-dad');
    const claim = (await ok('person.claim', {circleId, personId: target.id})).claimRequest;
    const review = {circleId, claimRequestId: claim.id};
    assert.equal((await call('person.claimApprove', review)).error.code, 'FORBIDDEN');
    if (mode === 'expired') db().phoneIdentities['demo-dad'].verifiedAt = Date.now() - 90 * 24 * 60 * 60 * 1000;
    setDemoActor('demo-owner');
    const result = await call('person.claimApprove', review);
    if (mode !== 'matching') {
      assert.equal(result.error.code, 'PHONE_MISMATCH', mode);
      assert.equal(db().claimRequests.find(row => row.id === claim.id).status, 'pending');
      assert.equal(db().persons.find(row => row.id === target.id).claimedBy, undefined);
      assert.ok(db().persons.find(row => row.id === target.id).matchPhone);
      await ok('person.update', {circleId, personId: target.id, patch: {}, matchPhone: null});
      await ok('person.claimApprove', review);
    } else assert.equal(result.ok, true);
    setDemoActor('demo-dad');
    assert.equal((await ok('person.get', {circleId, personId: target.id})).person.isSelf, true);
    assert.equal(db().persons.find(row => row.id === target.id).matchPhone, undefined);
  }
});

test('demo deletion closes the deleted person requests only, unblocks self creation and refuses excessive cleanup atomically', async () => {
  resetDemoData();
  await ok('person.unclaim', {circleId, personId: 'f_dad'});
  const target = await card();
  const other = await card();
  setDemoActor('demo-dad');
  const claim = (await ok('person.claim', {circleId, personId: target.id})).claimRequest;
  db().claimRequests.push({id: 'other-person', circleId, personId: other.id, actorId: 'demo-guest', status: 'pending', createdAt: Date.now()});
  db().claimRequests.push({id: 'other-record', circleId: 'class_demo', personId: 'c_sun', actorId: 'demo-dad', status: 'pending', createdAt: Date.now()});
  assert.equal((await call('person.delete', {circleId, personId: target.id})).error.code, 'FORBIDDEN');
  setDemoActor('demo-owner');
  await ok('person.delete', {circleId, personId: target.id});
  assert.equal(db().claimRequests.find(row => row.id === claim.id).status, 'rejected');
  assert.equal(db().claimRequests.find(row => row.id === 'other-person').status, 'pending');
  assert.equal(db().claimRequests.find(row => row.id === 'other-record').status, 'pending');
  setDemoActor('demo-dad');
  assert.equal((await card({claimSelf: true})).isSelf, true);
  setDemoActor('demo-owner');
  const bulk = await card({matchPhone: '13800138009'});
  for (let index = 0; index < 41; index++) db().claimRequests.push({id: `bulk-${index}`, circleId, personId: bulk.id,
    actorId: `applicant-${index}`, status: 'pending', createdAt: Date.now()});
  assert.equal((await call('person.delete', {circleId, personId: bulk.id})).error.code, 'DATA_LIMIT');
  assert.ok(db().persons.some(row => row.id === bulk.id));
  assert.equal(db().claimRequests.filter(row => row.personId === bulk.id && row.status === 'pending').length, 41);
  db().claimRequests = db().claimRequests.filter(row => row.id !== 'bulk-40');
  await ok('person.delete', {circleId, personId: bulk.id});
  assert.equal(db().claimRequests.filter(row => row.personId === bulk.id && row.status === 'rejected').length, 40);
});
