const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {ApiService} = require('../dist/service.js');
const {MemoryRepository} = require('../dist/memory-repository.js');
const profile = {name: '新家人', country: '中国', city: '杭州', birthday: {calendar: 'solar', month: 6, day: 7}};

async function fixture(type = 'family') {
  const repo = new MemoryRepository();
  const now = 1_800_000_000_000;
  const api = new ApiService(repo, () => now);
  const call = (actor, action, payload) => api.invoke({action, payload}, actor);
  const ok = async (actor, action, payload) => {
    const result = await call(actor, action, payload);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  const circle = (await ok('owner', 'circle.create', {type, name: '亲友录', mode: 'shared',
    ...(type === 'classmate' ? {school: '一中', cohort: '2020', className: '三班'} : {})})).circle;
  const anchor = (await ok('owner', 'person.create', {circleId: circle.id, ...profile, name: '已有家人'})).person;
  const apply = async () => {
    await ok('guest', 'account.profile.update', {patch: profile});
    const invite = (await ok('owner', 'invite.create', {circleId: circle.id})).invite;
    return (await ok('guest', 'invite.apply', {token: invite.token, name: profile.name, note: '同班同学'})).application;
  };
  return {repo, api, call, ok, circle, anchor, apply, now};
}

test('family creation can explicitly postpone relation, without fabricating an edge or bypassing required profile', async () => {
  const f = await fixture();
  const payload = {circleId: f.circle.id, ...profile};
  assert.equal((await f.call('owner', 'person.create', payload)).error.code, 'RELATION_REQUIRED');
  assert.equal((await f.call('owner', 'person.create', {...payload, deferRelation: false})).error.code, 'RELATION_REQUIRED');
  for (const deferRelation of ['true', 1, null]) assert.equal((await f.call('owner', 'person.create', {...payload, deferRelation})).error.code, 'INVALID_INPUT');
  assert.equal((await f.call('owner', 'person.create', {...payload, birthday: undefined, deferRelation: true})).error.code, 'PROFILE_INCOMPLETE');
  const first = await f.ok('owner', 'person.create', {...payload, deferRelation: true, requestId: 'deferred-family-001'});
  const replay = await f.ok('owner', 'person.create', {...payload, deferRelation: true, requestId: 'deferred-family-001'});
  assert.equal(first.person.id, replay.person.id);
  assert.equal((await f.call('owner', 'person.create', {...payload, requestId: 'deferred-family-001'})).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual((await f.ok('owner', 'relation.list', {circleId: f.circle.id})).relations, []);
  await f.ok('owner', 'relation.create', {circleId: f.circle.id, from: f.anchor.id, to: first.person.id, type: 'sibling'});
  assert.equal((await f.ok('owner', 'relation.list', {circleId: f.circle.id})).relations.length, 1);
});

test('relation postponement preserves creation permissions and rejects contradictory or classmate choices', async () => {
  const f = await fixture();
  const payload = {circleId: f.circle.id, ...profile, deferRelation: true};
  assert.equal((await f.call('owner', 'person.create', {...payload, initialRelation: {anchorPersonId: f.anchor.id, kind: 'sibling'}})).error.code, 'INVALID_INPUT');
  const member = {id: `${f.circle.id}_${crypto.createHash('sha256').update('member').digest('hex').slice(0, 40)}`,
    circleId: f.circle.id, userId: 'member', name: '普通成员', role: 'member', status: 'active', joinedAt: f.now};
  await f.repo.atomic(tx => tx.put('members', member));
  assert.equal((await f.call('member', 'person.create', payload)).error.code, 'FORBIDDEN');
  assert.equal((await f.call('outsider', 'person.create', {...payload, claimSelf: true})).error.code, 'FORBIDDEN');
  const self = await f.ok('member', 'person.create', {...payload, claimSelf: true});
  assert.equal(self.person.isSelf, true);
  const classmates = await fixture('classmate');
  assert.equal((await classmates.call('owner', 'person.create', {...profile, circleId: classmates.circle.id, deferRelation: true})).error.code, 'WRONG_CIRCLE_TYPE');
});

test('approving a new family member permits explicit postponement and keeps ordinary approval checks', async () => {
  const f = await fixture();
  const application = await f.apply();
  const payload = {circleId: f.circle.id, applicationId: application.id};
  assert.equal((await f.call('owner', 'join.approve', payload)).error.code, 'RELATION_REQUIRED');
  assert.equal((await f.call('owner', 'join.approve', {...payload, deferRelation: true, initialRelation: {anchorPersonId: f.anchor.id, kind: 'sibling'}})).error.code, 'INVALID_INPUT');
  assert.equal((await f.call('owner', 'join.approve', {...payload, deferRelation: true, targetPersonId: f.anchor.id})).error.code, 'INVALID_INPUT');
  assert.equal((await f.call('guest', 'join.approve', {...payload, deferRelation: true})).error.code, 'FORBIDDEN');
  await f.ok('owner', 'join.approve', {...payload, deferRelation: true});
  const people = (await f.ok('guest', 'person.list', {circleId: f.circle.id})).persons;
  assert.equal(people.length, 2);
  assert.equal(people.find(person => person.isSelf).name, profile.name);
  assert.deepEqual((await f.ok('guest', 'relation.list', {circleId: f.circle.id})).relations, []);
  const classmates = await fixture('classmate');
  const classApplication = await classmates.apply();
  assert.equal((await classmates.call('owner', 'join.approve', {circleId: classmates.circle.id, applicationId: classApplication.id, deferRelation: true})).error.code, 'WRONG_CIRCLE_TYPE');
});
