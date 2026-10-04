const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {ApiService} = require('../dist/service.js');
const {MemoryRepository} = require('../dist/memory-repository.js');

// These flows use the public service methods end to end. In particular, no
// fixture inserts memberships or silently adds a relationship for a new person.
async function fixture() {
  let now = 1_800_000_000_000;
  const repo = new MemoryRepository();
  const api = new ApiService(repo, () => now);
  const call = (actor, action, payload = {}) => api.invoke({action, payload}, actor);
  const ok = async (actor, action, payload = {}) => {
    const response = await call(actor, action, payload);
    assert.equal(response.ok, true, `${actor} ${action}: ${JSON.stringify(response)}`);
    return response.data;
  };
  const denied = async (actor, action, payload, code = 'FORBIDDEN') => {
    const response = await call(actor, action, payload);
    assert.equal(response.ok, false, `${actor} ${action} unexpectedly succeeded`);
    assert.equal(response.error.code, code, `${actor} ${action}: ${JSON.stringify(response)}`);
  };
  const profile = actor => ({name: actor, gender: 'female', country: '中国', province: '浙江', city: '杭州',
    birthday: {calendar: 'solar', year: 1994, month: 6, day: 8}, phone: '13800138000', wechatId: `${actor}_wx`});
  const register = async actor => {
    const linked = await api.linkVerifiedPhone(actor, actor === 'matched' ? '13800138009' : '13800138000');
    assert.equal(linked.ok, true, JSON.stringify(linked));
    await ok(actor, 'account.profile.update', {patch: profile(actor)});
  };
  const createRecord = async (owner, type = 'family') => (await ok(owner, 'circle.create', {
    type, name: `${owner}的记录`, mode: 'shared', ...(type === 'classmate' ? {school: '一中', cohort: '2020', className: '三班'} : {})
  })).circle;
  const apply = async (inviter, actor, circle, suppliedInvite) => {
    await register(actor);
    const invite = suppliedInvite || (await ok(inviter, 'invite.create', {circleId: circle.id})).invite;
    const application = (await ok(actor, 'invite.apply', {token: invite.token, note: '一中三班同学'})).application;
    return {invite, application};
  };
  const approve = async (reviewer, circle, application, options = {}) => {
    const row = (await ok(reviewer, 'join.list', {circleId: circle.id})).applications.find(row => row.id === application.id);
    assert.ok(row, 'reviewer must see the pending application');
    return ok(reviewer, 'join.approve', {circleId: circle.id, applicationId: application.id, reviewToken: row.reviewToken,
      ...(circle.type === 'family' && !options.targetPersonId ? {deferRelation: true} : {}), ...options});
  };
  const join = async (inviter, actor, circle, options = {}) => {
    const {application, invite} = await apply(inviter, actor, circle);
    await approve(inviter, circle, application, options);
    const member = (await ok(actor, 'member.list', {circleId: circle.id})).members.find(row => row.isSelf);
    return {application, invite, member, person: (await ok(actor, 'person.get', {circleId: circle.id, personId: member.personId})).person};
  };
  await register('owner');
  const circle = await createRecord('owner');
  const self = (await ok('owner', 'person.create', {circleId: circle.id, ...profile('owner'), claimSelf: true})).person;
  return {repo, api, call, ok, denied, profile, register, createRecord, apply, approve, join, circle, self,
    now: () => now, advance: ms => {now += ms;}};
}

test('owner, promoted admin, member and outsider retain record-scoped access throughout role changes', async () => {
  const f = await fixture();
  const {circleId} = f.self;
  const admin = await f.join('owner', 'admin', f.circle);
  const member = await f.join('owner', 'member', f.circle);
  await f.ok('owner', 'member.setRole', {circleId, memberId: admin.member.id, role: 'admin'});
  const foreign = await f.createRecord('outsider');
  const foreignPerson = (await f.ok('outsider', 'person.create', {circleId: foreign.id, ...f.profile('foreign')})).person;
  const privateReads = ['circle.detail', 'person.list', 'member.list', 'relation.list', 'person.remark.list'];
  for (const actor of ['owner', 'admin', 'member']) {
    for (const action of privateReads) await f.ok(actor, action, {circleId});
    await f.denied(actor, 'person.get', {circleId, personId: foreignPerson.id}, 'NOT_FOUND');
    for (const action of privateReads) await f.denied(actor, action, {circleId: foreign.id});
    await f.denied(actor, 'person.update', {circleId: foreign.id, personId: foreignPerson.id, patch: {name: '越权'}});
  }
  for (const action of privateReads) await f.denied('outsider', action, {circleId});
  for (const actor of ['member', 'outsider']) {
    await f.denied(actor, 'invite.create', {circleId});
    await f.denied(actor, 'join.list', {circleId});
    await f.denied(actor, 'person.update', {circleId, personId: admin.person.id, patch: {name: '越权'}});
    await f.denied(actor, 'person.create', {circleId, ...f.profile('他人'), deferRelation: true});
    await f.denied(actor, 'member.setRole', {circleId, memberId: member.member.id, role: 'admin'});
  }
  await f.ok('member', 'person.update', {circleId, personId: member.person.id, patch: {nickname: '我的昵称'}});
  await f.ok('admin', 'person.update', {circleId, personId: member.person.id, patch: {nickname: '本录昵称'}});
  assert.equal((await f.ok('member', 'account.profile.get')).profile.nickname, '我的昵称');
  assert.equal((await f.ok('owner', 'person.get', {circleId, personId: member.person.id})).person.nickname, '本录昵称');
  await f.denied('admin', 'member.setRole', {circleId, memberId: member.member.id, role: 'admin'});
  await f.denied('admin', 'member.remove', {circleId, memberId: (await f.ok('owner', 'member.list', {circleId})).members.find(row => row.role === 'owner').id});
  await f.ok('admin', 'invite.create', {circleId});
  await f.ok('owner', 'member.setRole', {circleId, memberId: admin.member.id, role: 'member'});
  await f.denied('admin', 'invite.create', {circleId});
  await f.denied('admin', 'person.update', {circleId, personId: member.person.id, patch: {name: '旧管理员改名'}});
});

test('single-use invitations gate actual access; revoked and exactly expired invitations never grant membership', async () => {
  const f = await fixture();
  const payload = {circleId: f.circle.id};
  const admin = await f.join('owner', 'admin', f.circle);
  await f.ok('owner', 'member.setRole', {...payload, memberId: admin.member.id, role: 'admin'});
  const invite = (await f.ok('admin', 'invite.create', payload)).invite;
  const a = await f.apply('admin', 'alice', f.circle, invite);
  const b = await f.apply('admin', 'bob', f.circle, invite);
  assert.equal((await f.ok(undefined, 'invite.preview', {token: invite.token})).status, 'active');
  for (const actor of ['alice', 'bob']) await f.denied(actor, 'person.list', payload);
  const attempts = await Promise.all([a, b].map(({application}) => f.call('admin', 'join.approve', {...payload, applicationId: application.id, deferRelation: true})));
  assert.equal(attempts.filter(result => result.ok).length, 1);
  const winner = attempts[0].ok ? 'alice' : 'bob';
  const loser = winner === 'alice' ? 'bob' : 'alice';
  await f.ok(winner, 'person.list', payload);
  await f.denied(loser, 'person.list', payload);
  assert.equal((await f.ok(undefined, 'invite.preview', {token: invite.token})).status, 'used');
  await f.register('late');
  await f.denied('late', 'invite.apply', {token: invite.token}, 'INVITE_INACTIVE');
  const revoked = await f.apply('admin', 'revoked-person', f.circle);
  await f.ok('admin', 'invite.revoke', {...payload, inviteId: revoked.invite.id});
  await f.denied('owner', 'join.approve', {...payload, applicationId: revoked.application.id, deferRelation: true}, 'INVITE_INACTIVE');
  assert.equal((await f.ok('revoked-person', 'join.mine')).applications[0].status, 'expired');
  const expiring = await f.apply('admin', 'expired-person', f.circle);
  f.advance(expiring.invite.expiresAt - f.now());
  await f.denied('owner', 'join.approve', {...payload, applicationId: expiring.application.id, deferRelation: true}, 'INVITE_INACTIVE');
  await f.denied('expired-person', 'invite.apply', {token: expiring.invite.token}, 'INVITE_INACTIVE');
  for (const actor of ['revoked-person', 'expired-person']) await f.denied(actor, 'circle.detail', payload);
});

test('matching a pre-recorded family member preserves relations and requires fresh review and verified matching identity', async () => {
  const f = await fixture();
  const payload = {circleId: f.circle.id};
  const preRecorded = (await f.ok('owner', 'person.create', {...payload, ...f.profile('妈妈'), matchPhone: '13800138009',
    initialRelation: {anchorPersonId: f.self.id, kind: 'newParent'}})).person;
  const relationsBefore = (await f.ok('owner', 'relation.list', payload)).relations;
  const wrong = await f.apply('owner', 'wrong-person', f.circle);
  await f.denied('owner', 'join.approve', {...payload, applicationId: wrong.application.id,
    targetPersonId: preRecorded.id, targetPersonUpdatedAt: (await f.ok('owner', 'person.get', {...payload, personId: preRecorded.id})).person.updatedAt}, 'PHONE_MISMATCH');
  await f.denied('wrong-person', 'person.get', {...payload, personId: preRecorded.id});
  const matched = await f.apply('owner', 'matched', f.circle);
  const oldTarget = (await f.ok('owner', 'person.get', {...payload, personId: preRecorded.id})).person;
  await f.ok('owner', 'person.update', {...payload, personId: preRecorded.id, patch: {nickname: '妈妈'}});
  await f.denied('owner', 'join.approve', {...payload, applicationId: matched.application.id,
    targetPersonId: preRecorded.id, targetPersonUpdatedAt: oldTarget.updatedAt}, 'TARGET_CHANGED');
  const current = (await f.ok('owner', 'person.get', {...payload, personId: preRecorded.id})).person;
  await f.approve('owner', f.circle, matched.application, {targetPersonId: current.id, targetPersonUpdatedAt: current.updatedAt});
  const people = (await f.ok('matched', 'person.list', payload)).persons;
  assert.equal(people.length, 2);
  assert.equal(people.find(person => person.isSelf).id, preRecorded.id);
  assert.deepEqual((await f.ok('matched', 'relation.list', payload)).relations, relationsBefore);
  const profile = (await f.ok('matched', 'account.profile.get')).profile;
  assert.equal(profile.name, 'matched');
  assert.equal(profile.nickname, undefined, 'administrator-entered nickname must not become account-owned data');
});

test('a deferred member is initially separate; only administrators can connect, replace and remove family relations later', async () => {
  const f = await fixture();
  const payload = {circleId: f.circle.id};
  const member = await f.join('owner', 'member', f.circle);
  const admin = await f.join('owner', 'admin', f.circle);
  await f.ok('owner', 'member.setRole', {...payload, memberId: admin.member.id, role: 'admin'});
  assert.deepEqual((await f.ok('member', 'relation.list', payload)).relations, []);
  const draft = {from: f.self.id, to: member.person.id, type: 'parent'};
  await f.denied('member', 'relation.create', {...payload, ...draft});
  await f.denied('member', 'relation.create', {...payload, from: f.self.id, to: admin.person.id, type: 'sibling'});
  const linked = (await f.ok('admin', 'relation.create', {...payload, ...draft})).relation;
  assert.equal((await f.ok('member', 'relation.list', payload)).relations.length, 1);
  await f.denied('member', 'relation.replace', {...payload, relationId: linked.id, relation: {from: f.self.id, to: member.person.id, type: 'sibling'}});
  await f.denied('member', 'relation.delete', {...payload, relationId: linked.id});
  const replacement = await f.ok('admin', 'relation.replace', {...payload, relationId: linked.id, relation: {from: f.self.id, to: member.person.id, type: 'sibling'}});
  const replacedId = replacement.relation.id;
  assert.equal((await f.ok('member', 'relation.list', payload)).relations[0].type, 'sibling');
  await f.ok('admin', 'relation.delete', {...payload, relationId: replacedId});
  assert.deepEqual((await f.ok('member', 'relation.list', payload)).relations, []);
  assert.equal((await f.ok('owner', 'person.list', payload)).persons.length, 3);
});

test('leave and removal revoke access immediately; rejoining resets role and private remark generation while preserving the family node', async () => {
  const f = await fixture();
  const payload = {circleId: f.circle.id};
  const joined = await f.join('owner', 'returning', f.circle);
  await f.ok('owner', 'member.setRole', {...payload, memberId: joined.member.id, role: 'admin'});
  const relation = (await f.ok('owner', 'relation.create', {...payload, from: f.self.id, to: joined.person.id, type: 'sibling'})).relation;
  await f.ok('returning', 'person.remark.update', {...payload, personId: f.self.id, remark: '上一次加入的备注'});
  for (const ending of ['member.leave', 'member.remove']) {
    if (ending === 'member.leave') await f.ok('returning', ending, payload);
    else await f.ok('owner', ending, {...payload, memberId: joined.member.id});
    for (const action of ['circle.detail', 'person.list', 'member.list', 'relation.list', 'person.remark.list', 'invite.create']) {
      await f.denied('returning', action, payload);
    }
    await f.denied('returning', 'person.update', {...payload, personId: joined.person.id, patch: {name: '退群后改名'}});
    assert.equal((await f.ok('returning', 'join.mine')).applications.filter(a => a.status === 'approved').every(a => !a.canEnter), true);
    const retained = (await f.ok('owner', 'person.get', {...payload, personId: joined.person.id})).person;
    assert.equal(retained.isClaimed, false);
    for (const field of ['city', 'birthday', 'phone', 'wechatId']) assert.equal(retained[field], undefined);
    assert.equal((await f.ok('owner', 'relation.list', payload)).relations[0].id, relation.id);
    // The clock deliberately does not advance: distinct membership lifetimes
    // must stay isolated even if their wall-clock timestamps happen to match.
    const rejoining = await f.apply('owner', 'returning', f.circle);
    await f.approve('owner', f.circle, rejoining.application, {targetPersonId: retained.id, targetPersonUpdatedAt: retained.updatedAt});
    const currentMember = (await f.ok('returning', 'member.list', payload)).members.find(m => m.isSelf);
    assert.equal(currentMember.role, 'member');
    assert.equal(currentMember.personId, retained.id);
    assert.deepEqual(await f.ok('returning', 'person.remark.list', payload), {remarks: {}});
    assert.deepEqual(await f.ok('returning', 'person.remark.get', {...payload, personId: f.self.id}), {remark: ''});
    await f.ok('returning', 'person.remark.update', {...payload, personId: f.self.id, remark: '这一轮的备注'});
  }
});

test('two pending invitations for the same applicant cannot create duplicate membership or a second self card', async () => {
  const f = await fixture();
  const payload = {circleId: f.circle.id};
  const first = await f.apply('owner', 'same-applicant', f.circle);
  const second = await f.apply('owner', 'same-applicant', f.circle);
  await f.approve('owner', f.circle, first.application);
  await f.denied('owner', 'join.approve', {...payload, applicationId: second.application.id, deferRelation: true}, 'ALREADY_REVIEWED');
  assert.equal((await f.ok('same-applicant', 'person.list', payload)).persons.filter(p => p.isSelf).length, 1);
  assert.equal((await f.ok('same-applicant', 'member.list', payload)).members.filter(m => m.isSelf).length, 1);
  assert.equal((await f.ok('same-applicant', 'join.mine')).applications.find(a => a.id === second.application.id).status, 'expired');
});

test('invitation-specific application lookup finds older own history without exposing another applicant or granting access', async () => {
  const f = await fixture();
  const first = await f.apply('owner', 'history-reader', f.circle);
  for (let index = 0; index < 21; index++) {
    f.advance(1);
    const invite = (await f.ok('owner', 'invite.create', {circleId: f.circle.id})).invite;
    await f.ok('history-reader', 'invite.apply', {token: invite.token});
  }
  const latest = await f.ok('history-reader', 'join.mine');
  assert.equal(latest.applications.length, 20);
  assert.equal(latest.hasMore, true);
  assert.equal(latest.applications.some(row => row.id === first.application.id), false);
  const query = {inviteToken: first.invite.token};
  const precise = await f.ok('history-reader', 'join.mine', query);
  assert.equal(precise.hasMore, false);
  assert.deepEqual(precise.applications.map(row => row.id), [first.application.id]);
  assert.equal(precise.applications[0].status, 'pending');
  assert.equal(precise.applications[0].canEnter, false);
  assert.deepEqual(await f.ok('owner', 'join.mine', query), {applications: [], hasMore: false});
  assert.deepEqual(await f.ok('outsider', 'join.mine', query), {applications: [], hasMore: false});
  for (const inviteToken of ['', 'missing', 'x'.repeat(32), null, {}]) {
    await f.denied('history-reader', 'join.mine', {inviteToken}, 'INVALID_INVITE');
  }
  await f.denied('history-reader', 'join.mine', {...query, applicationId: first.application.id}, 'INVALID_INPUT');
  await f.denied('outsider', 'join.mine', {applicationId: first.application.id}, 'NOT_FOUND');
  f.advance(first.invite.expiresAt - f.now());
  const expired = (await f.ok('history-reader', 'join.mine', query)).applications[0];
  assert.equal(expired.id, first.application.id);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.inviteStatus, 'expired');
  assert.equal(expired.canEnter, false);
  await f.ok('owner', 'invite.revoke', {circleId: f.circle.id, inviteId: first.invite.id});
  assert.equal((await f.ok('history-reader', 'join.mine', query)).applications[0].inviteStatus, 'revoked');
  await f.denied('history-reader', 'person.list', {circleId: f.circle.id});
});

test('used invitation lookup retains an approval while current membership alone controls entry after leaving', async () => {
  const f = await fixture();
  const joined = await f.join('owner', 'returning-reader', f.circle);
  const query = {inviteToken: joined.invite.token};
  assert.equal((await f.ok('returning-reader', 'join.mine', query)).applications[0].canEnter, true);
  f.advance(joined.invite.expiresAt - f.now());
  assert.equal((await f.ok('returning-reader', 'join.mine', query)).applications[0].status, 'approved');
  await f.ok('returning-reader', 'member.leave', {circleId: f.circle.id});
  const history = await f.ok('returning-reader', 'join.mine', query);
  assert.equal(history.hasMore, false);
  assert.equal(history.applications[0].status, 'approved');
  assert.equal(history.applications[0].canEnter, false);
  assert.deepEqual(await f.ok('outsider', 'join.mine', query), {applications: [], hasMore: false});
  await f.denied('returning-reader', 'circle.detail', {circleId: f.circle.id});
});

test('pending card claims end with membership and cannot be approved after leaving or reused after rejoining', async () => {
  const f = await fixture();
  const payload = {circleId: f.circle.id};
  const joined = await f.join('owner', 'claimant', f.circle);
  await f.ok('owner', 'person.unclaim', {...payload, personId: joined.person.id, reasonCode: 'wrong_person'});
  const target = (await f.ok('owner', 'person.create', {...payload, ...f.profile('原来已有我'), deferRelation: true})).person;
  const pending = (await f.ok('claimant', 'person.claim', {...payload, personId: target.id})).claimRequest;
  await f.ok('owner', 'member.remove', {...payload, memberId: joined.member.id});
  await f.denied('owner', 'person.claimApprove', {...payload, claimRequestId: pending.id}, 'ALREADY_REVIEWED');
  assert.equal((await f.ok('owner', 'person.get', {...payload, personId: target.id})).person.isClaimed, false);
  const rejoining = await f.apply('owner', 'claimant', f.circle);
  const current = (await f.ok('owner', 'person.get', {...payload, personId: joined.person.id})).person;
  await f.approve('owner', f.circle, rejoining.application, {targetPersonId: current.id, targetPersonUpdatedAt: current.updatedAt});
  await f.denied('owner', 'person.claimApprove', {...payload, claimRequestId: pending.id}, 'ALREADY_REVIEWED');
  const mine = (await f.ok('claimant', 'member.list', payload)).members.filter(m => m.isSelf);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].personId, joined.person.id);
});

const shortHash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 40);
const profileId = userId => `user_profile_${shortHash(userId)}`;

function budgetRepository(repo, onAfterBulkRead) {
  const transactions = [];
  const queries = [];
  const wrapped = {atomic: async work => {
    let operations = 0, didBulkRead = false;
    const count = () => {if (++operations > 100) throw new Error('CloudBase transaction document operation limit');};
    const result = await repo.atomic(tx => work({...tx,
      get: async (...args) => {count(); return tx.get(...args);},
      put: async (...args) => {count(); return tx.put(...args);},
      delete: async (...args) => {count(); return tx.delete(...args);},
      find: async (collection, match) => {
        assert.notEqual(collection, 'userProfiles', 'never scan the account profile collection');
        return tx.find(collection, match);
      },
      findByIds: async (collection, ids) => {
        didBulkRead = true; queries.push({collection, ids});
        return tx.findByIds(collection, ids);
      }
    }));
    transactions.push(operations);
    if (didBulkRead && onAfterBulkRead) await onAfterBulkRead();
    return result;
  }};
  return {wrapped, transactions, queries};
}

test('100 linked family accounts and 100 pending applicants fit each transaction budget using scoped profile batches', async () => {
  const f = await fixture();
  const circleId = f.circle.id;
  const memberProfileIds = new Set([profileId('owner')]);
  const applicantProfileIds = new Set();
  await f.repo.atomic(async tx => {
    for (let index = 1; index < 100; index++) {
      const userId = `member-${index}`, personId = `capacity-person-${index}`;
      memberProfileIds.add(profileId(userId));
      await tx.put('persons', {id: personId, circleId, ...f.profile(`旧姓名${index}`), claimedBy: userId,
        visibility: {}, relationCount: 0, createdAt: f.now(), updatedAt: f.now()});
      await tx.put('members', {id: `${circleId}_${shortHash(userId)}`, circleId, userId, name: `旧姓名${index}`,
        personId, role: 'member', status: 'active', joinedAt: f.now()});
      await tx.put('userProfiles', {id: profileId(userId), userId, ...f.profile(`现姓名${index}`), createdAt: f.now(), updatedAt: f.now()});
    }
    for (let index = 0; index < 100; index++) {
      const userId = `applicant-${index}`, inviteId = `capacity-invite-${index}`;
      applicantProfileIds.add(profileId(userId));
      const profile = f.profile(`申请人${index}`);
      await tx.put('userProfiles', {id: profileId(userId), userId, ...profile, createdAt: f.now(), updatedAt: f.now()});
      await tx.put('invites', {id: inviteId, circleId, tokenHash: inviteId, createdBy: 'owner', createdAt: f.now(), expiresAt: f.now() + 72 * 3600000});
      await tx.put('applications', {id: `capacity-application-${index}`, circleId, inviteId, userId, name: profile.name,
        profile, status: 'pending', createdAt: f.now()});
    }
    await tx.put('userProfiles', {id: profileId('outsider'), userId: 'outsider', ...f.profile('不应读取'), createdAt: f.now(), updatedAt: f.now()});
  });
  for (const action of ['person.list', 'member.list', 'birthday.upcoming', 'join.list']) {
    const budget = budgetRepository(f.repo);
    const response = await new ApiService(budget.wrapped, f.now).invoke({action, payload: {circleId, days: 366}}, 'owner');
    assert.equal(response.ok, true, `${action}: ${JSON.stringify(response)}`);
    assert.ok(budget.transactions.length >= 2, 'batch list must perform a separate final access check');
    assert.ok(budget.transactions.every(count => count <= 4), `${action} transaction operations ${budget.transactions}`);
    const allowed = action === 'join.list' ? applicantProfileIds : memberProfileIds;
    for (const query of budget.queries) {
      if (query.collection === 'userProfiles') assert.ok(query.ids.every(id => allowed.has(id)), `${action} must query only its authorized subject profiles`);
      else if (query.collection === 'persons') assert.ok(query.ids.every(id => id === f.self.id || /^capacity-person-\d+$/.test(id)));
      else {
        assert.equal(query.collection, 'members');
        assert.ok(query.ids.every(id => id.startsWith(`${circleId}_`)), 'subject membership checks stay in the authorized circle');
      }
    }
    if (action === 'person.list') {
      assert.equal(response.data.persons.length, 100);
      assert.equal(response.data.persons.find(p => p.id === 'capacity-person-99').name, '现姓名99');
    }
    if (action === 'member.list') assert.equal(response.data.members.length, 100);
    if (action === 'birthday.upcoming') assert.equal(response.data.events.length, 99);
    if (action === 'join.list') assert.equal(response.data.applications.length, 100);
  }
  const budget = budgetRepository(f.repo);
  const response = await new ApiService(budget.wrapped, f.now).invoke({action: 'relation.create', payload: {
    circleId, from: f.self.id, to: 'capacity-person-99', type: 'sibling'
  }}, 'owner');
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(budget.transactions.every(count => count < 20), 'editing a relation must touch only its endpoints');
  const approvalBudget = budgetRepository(f.repo);
  const approval = await new ApiService(approvalBudget.wrapped, f.now).invoke({action: 'join.approve', payload: {
    circleId, applicationId: 'capacity-application-0', deferRelation: true
  }}, 'owner');
  assert.equal(approval.ok, true, JSON.stringify(approval));
  assert.ok(approvalBudget.transactions.every(count => count < 20), 'approval must not hydrate every existing member');
  const homeBudget = budgetRepository(f.repo);
  const home = await new ApiService(homeBudget.wrapped, f.now).invoke({action: 'birthday.upcoming', payload: {days: 366}}, 'owner');
  assert.equal(home.ok, true, JSON.stringify(home));
  assert.equal(home.data.events.length, 100);
  assert.ok(homeBudget.transactions.every(count => count <= 4), 'home birthday aggregation must also use profile batches');
});

test('bulk read results are withheld if the member is removed or the administrator is demoted while profiles load', async () => {
  const f = await fixture();
  const payload = {circleId: f.circle.id};
  for (const action of ['person.list', 'member.list', 'birthday.upcoming', 'join.list']) {
    const actor = `reader-${action}`;
    const joined = await f.join('owner', actor, f.circle);
    if (action === 'join.list') await f.ok('owner', 'member.setRole', {...payload, memberId: joined.member.id, role: 'admin'});
    let revoked = false;
    const budget = budgetRepository(f.repo, async () => {
      if (revoked) return;
      revoked = true;
      if (action === 'join.list') await f.ok('owner', 'member.setRole', {...payload, memberId: joined.member.id, role: 'member'});
      else await f.ok('owner', 'member.remove', {...payload, memberId: joined.member.id});
    });
    const response = await new ApiService(budget.wrapped, f.now).invoke({action, payload: {...payload, days: 366}}, actor);
    assert.equal(response.ok, false, `${action} must not release results after permission changes`);
    assert.equal(response.error.code, 'FORBIDDEN');
    assert.equal(response.data, undefined);
  }
});

test('bulk person, member and birthday views never attach a departed subject account profile to an old circle snapshot', async () => {
  for (const action of ['person.list', 'member.list', 'birthday.upcoming']) {
    const f = await fixture();
    const joined = await f.join('owner', 'departing', f.circle);
    const subjectProfileId = profileId('departing');
    let interleaved = false;
    const wrapped = {atomic: work => f.repo.atomic(tx => work({...tx,
      findByIds: async (collection, ids) => {
        if (!interleaved && collection === 'userProfiles' && ids.includes(subjectProfileId)) {
          interleaved = true;
          // CloudBase profile queries are external to the transaction. Model
          // a committed leave and account edit after the first person query,
          // but before these profile query results become visible.
          const member = await tx.get('members', joined.member.id);
          await tx.put('members', {...member, status: 'left', personId: undefined, endedAt: f.now()});
          const person = await tx.get('persons', joined.person.id);
          await tx.put('persons', {...person, claimedBy: undefined, birthday: undefined, country: undefined,
            province: undefined, city: undefined, phone: undefined, wechatId: undefined, profileOverrides: undefined});
          const profile = await tx.get('userProfiles', subjectProfileId);
          await tx.put('userProfiles', {...profile, name: '退出后的私有新名', city: '退出后的私有城市'});
        }
        return tx.findByIds(collection, ids);
      }
    }))};
    const result = await new ApiService(wrapped, f.now).invoke({action, payload: {circleId: f.circle.id, days: 366}}, 'owner');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(interleaved, true);
    assert.equal(JSON.stringify(result).includes('退出后的私有'), false);
    if (action === 'person.list') {
      const person = result.data.persons.find(person => person.id === joined.person.id);
      assert.equal(person.isClaimed, false);
      assert.equal(person.city, undefined);
    }
    if (action === 'member.list') assert.equal(result.data.members.some(member => member.id === joined.member.id), false);
    if (action === 'birthday.upcoming') assert.equal(result.data.events.some(event => event.personId === joined.person.id), false);
  }
});

test('an application rejected during bulk profile reads cannot reveal later applicant profile changes in the approval list', async () => {
  const f = await fixture();
  const pending = await f.apply('owner', 'declined', f.circle);
  let interleaved = false;
  const wrapped = {atomic: work => f.repo.atomic(tx => work({...tx,
    findByIds: async (collection, ids) => {
      if (!interleaved && collection === 'userProfiles') {
        interleaved = true;
        const application = await tx.get('applications', pending.application.id);
        await tx.put('applications', {...application, status: 'rejected'});
        const profile = await tx.get('userProfiles', profileId('declined'));
        await tx.put('userProfiles', {...profile, name: '拒绝后修改的私有名字'});
      }
      return tx.findByIds(collection, ids);
    }
  }))};
  const result = await new ApiService(wrapped, f.now).invoke({action: 'join.list', payload: {circleId: f.circle.id}}, 'owner');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data.applications, []);
  assert.equal(JSON.stringify(result).includes('拒绝后'), false);
});

test('owner transfer settings hide expired or inactive targets so a stale request does not block the normal replacement flow', async () => {
  const f = await fixture();
  const payload = {circleId: f.circle.id};
  const first = await f.join('owner', 'first-target', f.circle);
  const second = await f.join('owner', 'second-target', f.circle);
  const transfer = (await f.ok('owner', 'circle.transferOwner', {...payload, memberId: first.member.id})).ownerTransfer;
  assert.ok((await f.ok('first-target', 'circle.detail', payload)).ownerTransfer);
  f.advance(transfer.expiresAt - f.now());
  assert.equal((await f.ok('owner', 'circle.detail', payload)).ownerTransfer, null);
  assert.equal((await f.ok('first-target', 'circle.detail', payload)).ownerTransfer, null);
  await f.denied('first-target', 'circle.acceptOwnerTransfer', {...payload, transferId: transfer.id}, 'TRANSFER_EXPIRED');
  const next = (await f.ok('owner', 'circle.transferOwner', {...payload, memberId: second.member.id})).ownerTransfer;
  assert.notEqual(next.id, transfer.id);
  await f.ok('second-target', 'member.leave', payload);
  assert.equal((await f.ok('owner', 'circle.detail', payload)).ownerTransfer, null);
  const replacement = (await f.ok('owner', 'circle.transferOwner', {...payload, memberId: first.member.id})).ownerTransfer;
  assert.ok(replacement.id);
  // A legacy orphaned transfer must not appear as actionable either.
  await f.repo.atomic(async tx => {
    const member = await tx.get('members', first.member.id);
    await tx.put('members', {...member, status: 'removed'});
  });
  assert.equal((await f.ok('owner', 'circle.detail', payload)).ownerTransfer, null);
  const third = await f.join('owner', 'third-target', f.circle);
  const recovered = (await f.ok('owner', 'circle.transferOwner', {...payload, memberId: third.member.id})).ownerTransfer;
  assert.equal(recovered.targetMemberId, third.member.id);
});
