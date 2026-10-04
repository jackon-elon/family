const test = require('node:test');
const assert = require('node:assert/strict');
const {ApiService} = require('../dist/service.js');
const {MemoryRepository} = require('../dist/memory-repository.js');

async function fixture() {
  let now = 1_800_000_000_000;
  const repo = new MemoryRepository();
  const api = new ApiService(repo, () => now);
  const call = (actor, action, payload = {}) => api.invoke({action, payload}, actor);
  const ok = async (actor, action, payload = {}) => {
    const result = await call(actor, action, payload);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  };
  const full = {name: '家人', country: '中国', city: '杭州', birthday: {calendar: 'solar', month: 5, day: 16}};
  const createCircle = async () => (await ok('owner', 'circle.create', {name: '亲友录', type: 'family', mode: 'shared'})).circle;
  const circle = await createCircle();
  const card = async (circleId = circle.id, extra = {}) => (await ok('owner', 'person.create', {circleId, ...full, deferRelation: true, ...extra})).person;
  const joinUnlinked = async (actor, circleId = circle.id, verify = true) => {
    if (verify) assert.equal((await api.linkVerifiedPhone(actor, '13800138000')).ok, true);
    await ok(actor, 'account.profile.update', {patch: {...full, name: actor}});
    const invite = (await ok('owner', 'invite.create', {circleId})).invite;
    const application = (await ok(actor, 'invite.apply', {token: invite.token})).application;
    await ok('owner', 'join.approve', {circleId, applicationId: application.id, deferRelation: true});
    const member = (await ok(actor, 'member.list', {circleId})).members.find(row => row.isSelf);
    await ok('owner', 'person.unclaim', {circleId, personId: member.personId});
    return member;
  };
  return {repo, api, call, ok, full, circle, createCircle, card, joinUnlinked, advance: ms => {now += ms;}, now: () => now};
}

test('claim approval enforces the same verified matching phone and expiry as invitation approval', async () => {
  for (const mode of ['wrong', 'missing', 'expired', 'matching']) {
    const f = await fixture();
    await f.joinUnlinked('member', f.circle.id, mode !== 'missing');
    const person = await f.card(f.circle.id, {matchPhone: mode === 'wrong' ? '13800138009' : '13800138000'});
    const payload = {circleId: f.circle.id, personId: person.id};
    const claim = (await f.ok('member', 'person.claim', payload)).claimRequest;
    if (mode === 'expired') f.advance(90 * 24 * 60 * 60 * 1000);
    const review = {circleId: f.circle.id, claimRequestId: claim.id};
    assert.equal((await f.call('member', 'person.claimApprove', review)).error.code, 'FORBIDDEN');
    const result = await f.call('owner', 'person.claimApprove', review);
    if (mode !== 'matching') {
      assert.equal(result.error.code, 'PHONE_MISMATCH', mode);
      assert.equal((await f.ok('owner', 'person.get', payload)).person.isClaimed, false);
      assert.equal((await f.ok('member', 'person.claimMine', {circleId: f.circle.id})).claimRequests[0].status, 'pending');
      assert.equal((await f.repo.atomic(tx => tx.find('phoneMatches', {circleId: f.circle.id}))).length, 1);
      // An administrator can correct a mistaken phone; no new approval flow is required.
      await f.ok('owner', 'person.update', {...payload, patch: {}, matchPhone: null});
      await f.ok('owner', 'person.claimApprove', review);
    } else assert.equal(result.ok, true);
    assert.equal((await f.ok('member', 'person.get', payload)).person.isSelf, true);
    assert.equal((await f.repo.atomic(tx => tx.find('phoneMatches', {circleId: f.circle.id}))).length, 0);
  }
});

test('deleting a person closes only their pending claims and immediately unblocks each applicant', async () => {
  const f = await fixture();
  const circleId = f.circle.id;
  for (const actor of ['member', 'peer', 'other']) await f.joinUnlinked(actor);
  const target = await f.card();
  const unrelated = await f.card();
  const claims = [];
  for (const actor of ['member', 'peer']) claims.push((await f.ok(actor, 'person.claim', {circleId, personId: target.id})).claimRequest);
  const sameCircleClaim = (await f.ok('other', 'person.claim', {circleId, personId: unrelated.id})).claimRequest;
  const foreign = await f.createCircle();
  await f.joinUnlinked('member', foreign.id);
  const foreignPerson = await f.card(foreign.id);
  const foreignClaim = (await f.ok('member', 'person.claim', {circleId: foreign.id, personId: foreignPerson.id})).claimRequest;
  assert.equal((await f.call('member', 'person.delete', {circleId, personId: target.id})).error.code, 'FORBIDDEN');
  await f.ok('owner', 'person.delete', {circleId, personId: target.id});
  for (const claim of claims) {
    const stored = await f.repo.atomic(tx => tx.get('claimRequests', claim.id));
    assert.equal(stored.status, 'rejected');
    assert.equal(stored.reviewedBy, 'owner');
    assert.equal((await f.call('owner', 'person.claimApprove', {circleId, claimRequestId: claim.id})).error.code, 'ALREADY_REVIEWED');
  }
  for (const request of [sameCircleClaim, foreignClaim]) assert.equal((await f.repo.atomic(tx => tx.get('claimRequests', request.id))).status, 'pending');
  const self = (await f.ok('member', 'person.create', {circleId, ...f.full, claimSelf: true, deferRelation: true})).person;
  assert.equal(self.isSelf, true);
  assert.equal((await f.ok('peer', 'person.claim', {circleId, personId: unrelated.id})).claimRequest.status, 'pending');
  const audit = (await f.ok('owner', 'audit.list', {circleId})).events.find(row => row.type === 'person.delete' && row.targetId === target.id);
  assert.equal(audit.details.cancelledClaimCount, 2);
});

test('claim cleanup respects the document transaction budget and rolls back excess claims before deleting', async () => {
  const f = await fixture();
  const person = await f.card(f.circle.id, {matchPhone: '13800138009'});
  const circleId = f.circle.id;
  await f.repo.atomic(async tx => {
    for (let index = 0; index < 41; index++) await tx.put('claimRequests', {id: `pending-${index}`, circleId, personId: person.id,
      userId: `applicant-${index}`, status: 'pending', createdAt: f.now()});
  });
  let operations = 0;
  const budgetRepo = {atomic: work => f.repo.atomic(tx => work({...tx,
    get: async (...args) => {assert.ok(++operations <= 100); return tx.get(...args);},
    put: async (...args) => {assert.ok(++operations <= 100); return tx.put(...args);},
    delete: async (...args) => {assert.ok(++operations <= 100); return tx.delete(...args);}
  }))};
  const api = new ApiService(budgetRepo, f.now);
  const request = {action: 'person.delete', payload: {circleId, personId: person.id}};
  assert.equal((await api.invoke(request, 'owner')).error.code, 'DATA_LIMIT');
  assert.equal((await f.repo.atomic(tx => tx.find('claimRequests', {circleId, status: 'pending'}))).length, 41);
  assert.equal((await f.ok('owner', 'person.get', request.payload)).person.id, person.id);
  assert.equal((await f.repo.atomic(tx => tx.find('phoneMatches', {circleId}))).length, 1);
  await f.repo.atomic(tx => tx.delete('claimRequests', 'pending-40'));
  operations = 0;
  assert.equal((await api.invoke(request, 'owner')).ok, true);
  assert.ok(operations <= 100);
  assert.equal((await f.repo.atomic(tx => tx.find('claimRequests', {circleId, status: 'rejected'}))).length, 40);
  assert.equal((await f.repo.atomic(tx => tx.find('phoneMatches', {circleId}))).length, 0);
});
