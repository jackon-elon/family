const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {ApiService} = require('../dist/service.js');
const {MemoryRepository} = require('../dist/memory-repository.js');

async function fixture() {
  const repo = new MemoryRepository();
  let now = 1_800_000_000_000;
  const api = new ApiService(repo, () => now);
  const call = (actor, action, payload) => api.invoke({action, payload}, actor);
  const ok = async (actor, action, payload) => {
    const result = await call(actor, action, payload);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  const circle = (await ok('owner', 'circle.create', {type: 'classmate', name: '同窗录', school: '一中', cohort: '2020', className: '三班', mode: 'shared'})).circle;
  const person = (await ok('owner', 'person.create', {circleId: circle.id, name: '李明', country: '中国', city: '杭州', birthday: {calendar: 'solar', month: 5, day: 9}})).person;
  const members = {};
  for (const [userId, role] of [['alice', 'member'], ['bob', 'member'], ['admin', 'admin']]) {
    const member = {id: `${circle.id}_${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 40)}`, circleId: circle.id, userId, name: userId, role, status: 'active', joinedAt: now};
    members[userId] = member;
    await repo.atomic(tx => tx.put('members', member));
  }
  const payload = {circleId: circle.id, personId: person.id};
  return {repo, call, ok, circle, person, members, payload, advance: () => {now += 1000; return now;}};
}

test('private notes are isolated across members and administrators and never alter public data', async () => {
  const f = await fixture();
  const before = await f.ok('alice', 'person.get', f.payload);
  const beforeAudits = await f.ok('owner', 'audit.list', {circleId: f.circle.id});
  await f.ok('alice', 'person.remark.update', {...f.payload, remark: '  高中同桌，周末方便联系  '});
  await f.ok('bob', 'person.remark.update', {...f.payload, remark: '球友'});
  assert.deepEqual(await f.ok('alice', 'person.remark.get', f.payload), {remark: '高中同桌，周末方便联系'});
  assert.deepEqual(await f.ok('bob', 'person.remark.get', f.payload), {remark: '球友'});
  for (const actor of ['owner', 'admin']) assert.deepEqual(await f.ok(actor, 'person.remark.get', f.payload), {remark: ''});
  await f.ok('admin', 'person.remark.update', {...f.payload, remark: '管理员自己的备注'});
  assert.deepEqual(await f.ok('alice', 'person.get', f.payload), before);
  assert.deepEqual(await f.ok('owner', 'audit.list', {circleId: f.circle.id}), beforeAudits);
  const list = await f.ok('owner', 'person.list', {circleId: f.circle.id});
  assert.equal(JSON.stringify(list).includes('高中同桌'), false);
  assert.deepEqual(await f.repo.atomic(tx => tx.find('userProfiles', {})), []);
});

test('note endpoints reject forged identities, unknown fields and cross-record people', async () => {
  const f = await fixture();
  await f.ok('alice', 'person.remark.update', {...f.payload, remark: '私人备注'});
  for (const actor of ['owner', 'admin', 'bob']) {
    for (const field of ['actorId', 'userId', 'ownerId']) {
      for (const action of ['person.remark.get', 'person.remark.update']) {
        const response = await f.call(actor, action, {...f.payload, ...(action.endsWith('update') ? {remark: '篡改'} : {}), [field]: 'alice'});
        assert.equal(response.ok, false);
        assert.equal(response.error.code, 'INVALID_INPUT');
      }
    }
  }
  assert.deepEqual(await f.ok('alice', 'person.remark.get', f.payload), {remark: '私人备注'});
  const other = (await f.ok('owner', 'circle.create', {type: 'family', name: '其他亲友录'})).circle;
  assert.equal((await f.call('owner', 'person.remark.get', {...f.payload, circleId: other.id})).error.code, 'NOT_FOUND');
});

test('outsiders, removed members and deleted people cannot read or change notes', async () => {
  const f = await fixture();
  await f.ok('alice', 'person.remark.update', {...f.payload, remark: '旧备注'});
  for (const action of ['person.remark.get', 'person.remark.update']) {
    assert.equal((await f.call('outsider', action, {...f.payload, ...(action.endsWith('update') ? {remark: 'x'} : {})})).error.code, 'FORBIDDEN');
  }
  await f.ok('owner', 'member.remove', {circleId: f.circle.id, memberId: f.members.alice.id});
  assert.equal((await f.call('alice', 'person.remark.get', f.payload)).error.code, 'FORBIDDEN');
  assert.equal((await f.call('alice', 'person.remark.update', {...f.payload, remark: 'x'})).error.code, 'FORBIDDEN');
  await f.repo.atomic(tx => tx.put('members', {...f.members.alice, joinedAt: f.advance()}));
  assert.deepEqual(await f.ok('alice', 'person.remark.get', f.payload), {remark: ''}, 'rejoining does not restore a note from an ended membership');
  await f.ok('bob', 'person.remark.update', {...f.payload, remark: '旧人物'});
  await f.ok('owner', 'person.delete', f.payload);
  assert.equal((await f.call('bob', 'person.remark.get', f.payload)).error.code, 'NOT_FOUND');
  assert.equal((await f.call('bob', 'person.remark.update', {...f.payload, remark: 'x'})).error.code, 'NOT_FOUND');
});

test('notes validate the 200-character limit, trim whitespace and clear independently', async () => {
  const f = await fixture();
  await f.ok('alice', 'person.remark.update', {...f.payload, remark: '字'.repeat(200)});
  await f.ok('bob', 'person.remark.update', {...f.payload, remark: '保留'});
  for (const remark of ['字'.repeat(201), null, 123, {}, undefined]) {
    assert.equal((await f.call('alice', 'person.remark.update', {...f.payload, remark})).error.code, 'INVALID_INPUT');
  }
  assert.equal((await f.ok('alice', 'person.remark.get', f.payload)).remark.length, 200);
  assert.deepEqual(await f.ok('alice', 'person.remark.update', {...f.payload, remark: ' \n\t '}), {remark: ''});
  assert.deepEqual(await f.ok('alice', 'person.remark.get', f.payload), {remark: ''});
  assert.deepEqual(await f.ok('bob', 'person.remark.get', f.payload), {remark: '保留'});
  assert.equal((await f.repo.atomic(tx => tx.find('personRemarks', {userId: 'alice'}))).length, 0);
});

test('remark names list stays personal and local to one record, retaining legacy long notes', async () => {
  const f = await fixture();
  const listPayload = {circleId: f.circle.id};
  await f.ok('alice', 'person.remark.update', {...f.payload, remark: '字'.repeat(200)});
  await f.ok('bob', 'person.remark.update', {...f.payload, remark: '李同桌'});
  assert.deepEqual(await f.ok('alice', 'person.remark.list', listPayload), {remarks: {[f.person.id]: '字'.repeat(200)}});
  assert.deepEqual(await f.ok('bob', 'person.remark.list', listPayload), {remarks: {[f.person.id]: '李同桌'}});
  for (const actor of ['owner', 'admin']) assert.deepEqual(await f.ok(actor, 'person.remark.list', listPayload), {remarks: {}});
  for (const field of ['userId', 'actorId', 'personId']) {
    assert.equal((await f.call('owner', 'person.remark.list', {...listPayload, [field]: 'alice'})).error.code, 'INVALID_INPUT');
  }
  const other = (await f.ok('alice', 'circle.create', {type: 'family', name: '另一份亲友录'})).circle;
  assert.deepEqual(await f.ok('alice', 'person.remark.list', {circleId: other.id}), {remarks: {}});
  assert.equal((await f.ok('alice', 'person.get', f.payload)).person.name, '李明');
});

test('remark name lists reject removed members and exclude previous memberships or missing person generations', async () => {
  const f = await fixture();
  const listPayload = {circleId: f.circle.id};
  await f.ok('alice', 'person.remark.update', {...f.payload, remark: '旧备注'});
  assert.equal((await f.call('outsider', 'person.remark.list', listPayload)).error.code, 'FORBIDDEN');
  await f.ok('owner', 'member.remove', {circleId: f.circle.id, memberId: f.members.alice.id});
  assert.equal((await f.call('alice', 'person.remark.list', listPayload)).error.code, 'FORBIDDEN');
  await f.repo.atomic(tx => tx.put('members', {...f.members.alice, joinedAt: f.advance()}));
  assert.deepEqual(await f.ok('alice', 'person.remark.list', listPayload), {remarks: {}});
  await f.ok('alice', 'person.remark.update', {...f.payload, remark: '新备注'});
  const person = await f.repo.atomic(tx => tx.get('persons', f.person.id));
  await f.repo.atomic(tx => tx.put('persons', {...person, createdAt: f.advance()}));
  assert.deepEqual(await f.ok('alice', 'person.remark.list', listPayload), {remarks: {}});
  await f.ok('alice', 'person.remark.update', {...f.payload, remark: '准备删除'});
  await f.ok('owner', 'person.delete', f.payload);
  assert.deepEqual(await f.ok('alice', 'person.remark.list', listPayload), {remarks: {}});
});

test('remark names use collection scans rather than one transaction read per person', async () => {
  const f = await fixture();
  const source = await f.repo.atomic(tx => tx.get('persons', f.person.id));
  await f.repo.atomic(async tx => {
    for (let index = 0; index < 140; index++) {
      const person = {...source, id: `bulk-${index}`};
      await tx.put('persons', person);
      await tx.put('personRemarks', {id: `bulk-note-${index}`, circleId: f.circle.id, userId: 'alice', personId: person.id,
        memberJoinedAt: f.members.alice.joinedAt, personCreatedAt: person.createdAt, remark: `备注${index}`, updatedAt: person.createdAt});
    }
  });
  const calls = [];
  const wrapped = {atomic: work => f.repo.atomic(tx => work({...tx,
    get: (collection, id) => {calls.push(['get', collection]); return tx.get(collection, id);},
    find: (collection, match) => {calls.push(['find', collection]); return tx.find(collection, match);}
  }))};
  const api = new ApiService(wrapped);
  const result = await api.invoke({action: 'person.remark.list', payload: {circleId: f.circle.id}}, 'alice');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(Object.keys(result.data.remarks).length, 140);
  assert.equal(calls.filter(([method, collection]) => method === 'get' && ['persons', 'personRemarks'].includes(collection)).length, 0);
  assert.equal(calls.filter(([method, collection]) => method === 'find' && collection === 'personRemarks').length, 1);
});
