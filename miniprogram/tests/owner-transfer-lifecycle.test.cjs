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

test('a transfer recipient leaving cancels the hidden pending request and lets the owner select another person immediately', async () => {
  resetDemoData();
  const payload = {circleId: 'family_demo'};
  const first = (await ok('circle.transferOwner', {...payload, memberId: 'm_f_dad'})).ownerTransfer;
  setDemoActor('demo-dad');
  await ok('member.leave', payload);
  setDemoActor('demo-owner');
  assert.equal((await ok('circle.detail', payload)).ownerTransfer, null);
  const next = (await ok('circle.transferOwner', {...payload, memberId: 'm_f_mom'})).ownerTransfer;
  assert.notEqual(next.id, first.id);
  assert.equal(next.targetMemberId, 'm_f_mom');
  const audits = (await ok('audit.list', payload)).events;
  assert.ok(audits.some(event => event.type === 'circle.transferCancelled' && event.targetId === 'm_f_dad'));
  assert.equal((await call('circle.acceptOwnerTransfer', {...payload, transferId: first.id, demoAcceptAsTarget: true})).ok, false);
});
