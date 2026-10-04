const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText, filename);
};
const storage = new Map();
global.wx = {getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), showToast() {}};
const {invoke, resetDemoData, setDemoActor} = require('../services/api.ts');
const payload = {circleId: 'family_demo', personId: 'f_mom'};
const call = (action, params = payload) => invoke({action, payload: params});
const ok = async (action, params) => {
  const response = await call(action, params);
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data;
};

test('demo notes are personal even when an administrator opens the same person', async () => {
  resetDemoData();
  const publicBefore = await ok('person.get');
  const profileBefore = await ok('account.profile.get', {});
  const auditsBefore = await ok('audit.list', {circleId: payload.circleId});
  await ok('person.remark.update', {...payload, remark: '我的备注'});
  setDemoActor('demo-dad');
  assert.deepEqual(await ok('person.remark.get'), {remark: ''});
  await ok('person.remark.update', {...payload, remark: '  配偶自己的备注  '});
  setDemoActor('demo-owner');
  assert.deepEqual(await ok('person.remark.get'), {remark: '我的备注'});
  assert.deepEqual(await ok('person.get'), publicBefore);
  assert.deepEqual(await ok('account.profile.get', {}), profileBefore);
  assert.deepEqual(await ok('audit.list', {circleId: payload.circleId}), auditsBefore);
  const people = await ok('person.list', {circleId: payload.circleId});
  assert.equal(JSON.stringify(people).includes('配偶自己的备注'), false);
  setDemoActor('demo-dad');
  assert.deepEqual(await ok('person.remark.get'), {remark: '配偶自己的备注'});
});

test('demo rejects identity injection, external access and access after removal', async () => {
  resetDemoData();
  setDemoActor('demo-dad');
  await ok('person.remark.update', {...payload, remark: '私人内容'});
  setDemoActor('demo-owner');
  for (const actorField of ['actorId', 'userId']) {
    assert.equal((await call('person.remark.get', {...payload, [actorField]: 'demo-dad'})).error.code, 'INVALID_INPUT');
    assert.equal((await call('person.remark.update', {...payload, [actorField]: 'demo-dad', remark: '篡改'})).error.code, 'INVALID_INPUT');
  }
  await ok('member.remove', {circleId: payload.circleId, memberId: 'm_f_dad'});
  for (const actor of ['demo-dad', 'demo-guest']) {
    setDemoActor(actor);
    assert.equal((await call('person.remark.get')).error.code, 'FORBIDDEN');
    assert.equal((await call('person.remark.update', {...payload, remark: 'x'})).error.code, 'FORBIDDEN');
  }
  assert.equal(Object.values(storage.get('kin-network-demo-db-v2').personRemarks).some(row => row.actorId === 'demo-dad'), false);
});

test('demo validates and clears notes, rejects mismatched and deleted subjects', async () => {
  resetDemoData();
  await ok('person.remark.update', {...payload, remark: '字'.repeat(200)});
  for (const remark of ['字'.repeat(201), null, 1]) assert.equal((await call('person.remark.update', {...payload, remark})).error.code, 'INVALID_INPUT');
  assert.deepEqual(await ok('person.remark.update', {...payload, remark: ' \n '}), {remark: ''});
  assert.deepEqual(await ok('person.remark.get'), {remark: ''});
  assert.equal((await call('person.remark.get', {...payload, circleId: 'class_demo'})).error.code, 'NOT_FOUND');
  const unlinked = {circleId: 'class_demo', personId: 'c_sun'};
  await ok('person.remark.update', {...unlinked, remark: '旧同学'});
  await ok('person.delete', unlinked);
  assert.equal((await call('person.remark.get', unlinked)).error.code, 'NOT_FOUND');
  assert.equal((await call('person.remark.update', {...unlinked, remark: 'x'})).error.code, 'NOT_FOUND');
});

test('failed local storage writes do not report or retain a saved note', async () => {
  resetDemoData();
  await ok('person.remark.update', {...payload, remark: '原内容'});
  const save = wx.setStorageSync;
  try {
    wx.setStorageSync = () => {throw new Error('quota exceeded');};
    assert.equal((await call('person.remark.update', {...payload, remark: '没保存'})).error.code, 'STORAGE_FULL');
  } finally { wx.setStorageSync = save; }
  assert.deepEqual(await ok('person.remark.get'), {remark: '原内容'});
});
