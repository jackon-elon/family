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
const payload = {circleId: 'family_demo'};
const call = (action, params = payload) => invoke({action, payload: params});
const ok = async (action, params) => {
  const result = await call(action, params);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
};
function seed(id, relationChange) {
  storage.get('kin-network-demo-db-v2').suggestions.push({id, circleId: payload.circleId, type: 'relation', message: '请核对关系',
    createdBy: 'demo-dad', status: 'pending', createdAt: Date.now(), ...(relationChange === undefined ? {} : {relationChange})});
}

test('demo administrators can close manually checked text relations with a note while graph and accepted state remain unchanged', async () => {
  resetDemoData();
  for (const [id, change] of [['text-only', undefined], ['empty-change', {}]]) {
    seed(id, change);
    const params = {...payload, suggestionId: id, status: 'handled', resolutionNote: '已人工核实并更正关系'};
    setDemoActor('demo-dad');
    assert.equal((await call('suggestion.resolve', params)).error.code, 'FORBIDDEN');
    setDemoActor('demo-owner');
    assert.equal((await call('suggestion.resolve', {...params, resolutionNote: ''})).ok, false);
    assert.equal((await call('suggestion.resolve', {...params, status: 'accepted'})).error.code, 'CHANGE_REQUIRED');
    const before = await ok('relation.list');
    const handled = await ok('suggestion.resolve', params);
    assert.equal(handled.suggestion.status, 'handled');
    assert.equal(handled.suggestion.resolutionNote, params.resolutionNote);
    assert.equal(handled.impact, undefined);
    assert.deepEqual(await ok('relation.list'), before);
    const audit = (await ok('audit.list')).events.find(event => event.targetId === id);
    assert.equal(audit.details.status, 'handled');
    assert.equal(audit.details.created, undefined);
  }
});

test('demo retains the structured relation guard even if the referenced edge no longer exists', async () => {
  resetDemoData();
  for (const [id, change] of [
    ['stale-removal', {removeRelationId: 'deleted-edge'}],
    ['concrete-addition', {relation: {from: 'f_me', to: 'f_dad', type: 'sibling'}}]
  ]) {
    seed(id, change);
    const params = {...payload, suggestionId: id, status: 'handled', resolutionNote: '不能跳过图更新'};
    assert.equal((await call('suggestion.resolve', params)).error.code, 'CHANGE_REQUIRED');
    assert.equal((await ok('suggestion.list')).suggestions.find(row => row.id === id).status, 'pending');
    await ok('suggestion.resolve', {...params, status: 'rejected'});
  }
});
