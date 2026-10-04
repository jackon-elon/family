const test = require('node:test');
const assert = require('node:assert/strict');
const {ApiService} = require('../dist/service.js');
const {MemoryRepository} = require('../dist/memory-repository.js');

async function fixture() {
  const repo = new MemoryRepository(), api = new ApiService(repo);
  const call = (actor, action, payload = {}) => api.invoke({action, payload}, actor);
  const ok = async (actor, action, payload) => {
    const response = await call(actor, action, payload);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  };
  const circle = (await ok('owner', 'circle.create', {type: 'family', mode: 'shared', name: '亲友录'})).circle;
  const seed = async (id, relationChange) => repo.atomic(tx => tx.put('suggestions', {
    id, circleId: circle.id, createdBy: 'member', type: 'relation', message: '请人工核对与妈妈的关系', status: 'pending',
    ...(relationChange === undefined ? {} : {relationChange}), createdAt: 1
  }));
  return {call, ok, seed, payload: {circleId: circle.id}};
}

test('text-only and empty legacy relation suggestions can be manually handled with a required note without claiming automatic graph changes', async () => {
  const f = await fixture();
  for (const [id, change] of [['text-only', undefined], ['empty-change', {}]]) {
    await f.seed(id, change);
    const payload = {...f.payload, suggestionId: id};
    assert.equal((await f.call('outsider', 'suggestion.resolve', {...payload, status: 'handled', resolutionNote: '越权'})).error.code, 'FORBIDDEN');
    assert.equal((await f.call('owner', 'suggestion.resolve', {...payload, status: 'handled', resolutionNote: '  '})).error.code, 'INVALID_INPUT');
    assert.equal((await f.call('owner', 'suggestion.resolve', {...payload, status: 'accepted', resolutionNote: '不能假采纳'})).error.code, 'CHANGE_REQUIRED');
    const before = await f.ok('owner', 'relation.list', f.payload);
    const resolved = await f.ok('owner', 'suggestion.resolve', {...payload, status: 'handled', resolutionNote: '已人工核对，关系已在管理页更正'});
    assert.equal(resolved.suggestion.status, 'handled');
    assert.equal(resolved.suggestion.resolutionNote, '已人工核对，关系已在管理页更正');
    assert.equal(resolved.impact, undefined);
    assert.deepEqual(await f.ok('owner', 'relation.list', f.payload), before);
    const audit = (await f.ok('owner', 'audit.list', f.payload)).events.find(row => row.targetId === id);
    assert.equal(audit.details.status, 'handled');
    assert.equal(audit.details.created, undefined);
    assert.equal(audit.details.removed, undefined);
    assert.equal((await f.call('owner', 'suggestion.resolve', {...payload, status: 'handled', resolutionNote: '重复'})).error.code, 'ALREADY_REVIEWED');
  }
});

test('concrete or stale relation operations cannot bypass applying the change by choosing handled', async () => {
  const f = await fixture();
  for (const [id, change] of [
    ['stale-removal', {removeRelationId: 'already-deleted-edge'}],
    ['concrete-addition', {relation: {from: 'a', to: 'b', type: 'parent'}}]
  ]) {
    await f.seed(id, change);
    const response = await f.call('owner', 'suggestion.resolve', {...f.payload, suggestionId: id, status: 'handled', resolutionNote: '不能绕过关系更新'});
    assert.equal(response.error.code, 'CHANGE_REQUIRED');
    assert.equal((await f.ok('owner', 'suggestion.list', f.payload)).suggestions.find(row => row.id === id).status, 'pending');
    await f.ok('owner', 'suggestion.resolve', {...f.payload, suggestionId: id, status: 'rejected', resolutionNote: '原关系已变动，请重新核对'});
  }
});
