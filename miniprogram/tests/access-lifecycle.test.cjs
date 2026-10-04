const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText, filename);
const storage = new Map();
global.wx = {getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), showToast() {}};
const {invoke, resetDemoData, setDemoActor} = require('../services/api.ts');
const {buildStarLayout} = require('../components/star-network/layout.ts');
const {relationshipFor} = require('../utils/relationship.ts');
const call = (action, payload = {}) => invoke({action, payload});
const ok = async (action, payload) => {const r = await call(action, payload); assert.equal(r.ok, true, `${action}: ${JSON.stringify(r)}`); return r.data;};
const denied = async (action, payload, code = 'FORBIDDEN') => {const r = await call(action, payload); assert.equal(r.ok, false, `${action} unexpectedly succeeded`); if (code) assert.equal(r.error.code, code, `${action}: ${JSON.stringify(r)}`); return r;};
const as = actor => assert.equal(setDemoActor(actor), true);
const family = {circleId: 'family_demo'};
const full = {country: '中国', province: '浙江', city: '杭州', birthday: {calendar: 'solar', year: 1995, month: 6, day: 7}};
async function signIn(actor, name = '新家人') {as(actor); await ok('account.verifyPhone', {code: 'demo-verified-phone'}); await ok('account.profile.update', {patch: {name, ...full}});}
async function apply(actor, invite, name) {await signIn(actor, name); return (await ok('invite.apply', {token: invite.token, note: '我们是同班同学'})).application;}
async function approve(application, options = {}) {
  const applicationId = application.id; const circleId = application.circleId;
  const review = (await ok('join.list', {circleId})).applications.find(row => row.id === applicationId);
  return ok('join.approve', {circleId, applicationId, reviewToken: review?.reviewToken, ...options});
}
async function targetApproval(application, personId) {
  const target = (await ok('person.get', {circleId: application.circleId, personId})).person;
  return approve(application, {targetPersonId: personId, targetPersonUpdatedAt: target.updatedAt});
}
async function mine(circleId = family.circleId) {return (await ok('person.list', {circleId})).persons.find(person => person.isSelf);}
async function currentMember(circleId = family.circleId) {return (await ok('member.list', {circleId})).members.find(member => member.isSelf);}
function db() {return storage.get('kin-network-demo-db-v2');}

test('new family records mother before login, links the invite to that same person, and enforces owner/admin/member/outsider boundaries', async () => {
  resetDemoData();
  const circleId = (await ok('circle.create', {type: 'family', name: '跨账号测试家庭', mode: 'shared'})).circle.id;
  const self = (await ok('person.create', {circleId, name: '先加入的我', gender: 'female', ...full, claimSelf: true})).person;
  const mom = (await ok('person.create', {circleId, name: '未登录的妈妈', gender: 'female', ...full, matchPhone: '13700137000', initialRelation: {anchorPersonId: self.id, kind: 'newParent'}})).person;
  const invite = (await ok('invite.create', {circleId})).invite;
  as('demo-guest');
  const preview = await ok('invite.preview', {token: invite.token});
  assert.equal(preview.circle.name, '跨账号测试家庭'); assert.equal(preview.circle.persons, undefined);
  for (const action of ['circle.detail', 'person.list', 'relation.list', 'member.list', 'person.remark.list', 'photo.urls', 'invite.create', 'join.list', 'audit.list']) await denied(action, {circleId});
  const application = await apply('demo-guest', invite, '妈妈');
  await denied('person.list', {circleId});
  as('demo-owner'); await targetApproval(application, mom.id);
  assert.equal((await ok('person.list', {circleId})).persons.length, 2);
  assert.equal((await ok('relation.list', {circleId})).relations.length, 1);
  as('demo-guest');
  assert.equal((await mine(circleId)).id, mom.id);
  await ok('person.update', {circleId, personId: mom.id, patch: {bio: '本人补充近况'}});
  for (const [action, extra] of [
    ['person.update', {personId: self.id, patch: {name: '擅自改名'}}], ['person.delete', {personId: self.id}],
    ['person.create', {name: '额外人物', ...full, deferRelation: true}], ['relation.create', {from: self.id, to: mom.id, type: 'sibling'}],
    ['invite.create', {}], ['join.list', {}], ['member.setRole', {memberId: 'irrelevant', role: 'admin'}]
  ]) await denied(action, {circleId, ...extra});
  await ok('person.remark.update', {circleId, personId: self.id, remark: '小朋友'});
  const guestMember = await currentMember(circleId);
  as('demo-owner'); assert.deepEqual(await ok('person.remark.list', {circleId}), {remarks: {}});
  await ok('member.setRole', {circleId, memberId: guestMember.id, role: 'admin'});
  as('demo-guest'); await ok('invite.create', {circleId}); await ok('person.update', {circleId, personId: self.id, patch: {bio: '管理员补充'}});
  const ownerMember = (await ok('member.list', {circleId})).members.find(member => member.role === 'owner');
  await denied('member.remove', {circleId, memberId: ownerMember.id});
  await denied('member.setRole', {circleId, memberId: guestMember.id, role: 'member'});
  await denied('invite.create', {circleId: 'class_demo'}); await denied('person.list', {circleId: 'family_demo'});
  as('demo-owner'); await ok('member.setRole', {circleId, memberId: guestMember.id, role: 'member'});
  as('demo-guest'); await denied('invite.create', {circleId}); await denied('person.update', {circleId, personId: self.id, patch: {bio: '降级后修改'}});
  as('demo-guest-2'); await denied('person.get', {circleId, personId: mom.id});
});

test('two invitations for the same applicant cannot create duplicate people or memberships; one token admits only one person', async () => {
  resetDemoData();
  const invite1 = (await ok('invite.create', family)).invite;
  const invite2 = (await ok('invite.create', family)).invite;
  const first = await apply('demo-guest', invite1, '亲戚甲');
  const second = (await ok('invite.apply', {token: invite2.token})).application;
  const other = await apply('demo-guest-2', invite1, '亲戚乙');
  as('demo-owner'); await approve(first, {deferRelation: true});
  const count = (await ok('person.list', family)).persons.length;
  await denied('join.approve', {...family, applicationId: second.id, deferRelation: true}, null);
  await denied('join.approve', {...family, applicationId: other.id, deferRelation: true}, null);
  assert.equal((await ok('person.list', family)).persons.length, count);
  assert.equal(db().members.filter(member => member.circleId === family.circleId && member.actorId === 'demo-guest' && member.status === 'joined').length, 1);
  assert.equal((await ok('invite.preview', {token: invite1.token})).status, 'used');
  as('demo-guest'); await denied('invite.apply', {token: invite2.token}, 'ALREADY_MEMBER');
});

test('invitation revocation and the exact expiry instant block both new applicants and pending approvals', async () => {
  resetDemoData();
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    const revoked = (await ok('invite.create', family)).invite;
    const expired = (await ok('invite.create', family)).invite;
    const revokedApplication = await apply('demo-guest', revoked, '待撤销申请');
    const expiredApplication = (await ok('invite.apply', {token: expired.token})).application;
    as('demo-owner'); await ok('invite.revoke', {...family, inviteId: revoked.id});
    await denied('join.approve', {...family, applicationId: revokedApplication.id, deferRelation: true}, 'INVITE_UNAVAILABLE');
    now = expired.expiresAt;
    assert.equal((await ok('invite.preview', {token: expired.token})).status, 'expired');
    assert.equal((await ok('invite.list', family)).invites.find(invite => invite.id === expired.id).status, 'expired');
    await denied('join.approve', {...family, applicationId: expiredApplication.id, deferRelation: true}, 'INVITE_UNAVAILABLE');
    await signIn('demo-guest-2', '新申请人');
    await denied('invite.apply', {token: revoked.token}, 'INVITE_UNAVAILABLE');
    await denied('invite.apply', {token: expired.token}, 'INVITE_UNAVAILABLE');
    as('demo-guest');
    assert.ok((await ok('join.mine')).applications.every(application => !application.canEnter));
  } finally {Date.now = realNow;}
});

test('admin admits a relative with unknown relationship, later connects them, and both users see the completed graph', async () => {
  resetDemoData(); await ok('member.setRole', {...family, memberId: 'm_f_dad', role: 'admin'});
  as('demo-dad'); const invite = (await ok('invite.create', family)).invite;
  const application = await apply('demo-guest', invite, '后来补关系的家人');
  as('demo-dad'); await approve(application, {deferRelation: true});
  as('demo-guest'); const guest = await mine();
  const initial = (await ok('relation.list', family)).relations;
  assert.equal(initial.some(relation => [relation.from, relation.to].includes(guest.id)), false);
  await denied('relation.create', {...family, from: 'f_dad', to: guest.id, type: 'parent'});
  as('demo-owner');
  let people = (await ok('person.list', family)).persons;
  assert.equal(buildStarLayout(people, initial, 'f_me', 'f_me').nodes.find(node => node.id === guest.id).generation, null);
  as('demo-dad'); await ok('relation.create', {...family, from: 'f_dad', to: guest.id, type: 'parent'});
  as('demo-owner'); people = (await ok('person.list', family)).persons;
  const linked = (await ok('relation.list', family)).relations;
  const graph = buildStarLayout(people, linked, 'f_me', 'f_me');
  assert.equal(graph.nodes.find(node => node.id === guest.id).generation, 0);
  assert.equal(graph.nodes.find(node => node.id === guest.id).connected, true);
  as('demo-guest');
  assert.equal((await mine()).id, guest.id);
  const guestPeople = (await ok('person.list', family)).persons;
  assert.equal(relationshipFor(guestPeople, linked, guest.id, 'f_dad').label, '爸爸');
});

test('removing and re-inviting an admin restores one existing node as an ordinary member; leave revokes access again', async () => {
  resetDemoData(); const invite = (await ok('invite.create', family)).invite;
  const application = await apply('demo-guest', invite, '重新加入的亲戚');
  as('demo-owner'); await approve(application, {initialRelation: {anchorPersonId: 'f_me', kind: 'sibling'}});
  as('demo-guest'); const person = await mine(); const member = await currentMember();
  await ok('person.remark.update', {...family, personId: 'f_me', remark: '重新加入前的备注'});
  as('demo-owner'); await ok('member.setRole', {...family, memberId: member.id, role: 'admin'});
  await ok('member.remove', {...family, memberId: member.id});
  as('demo-guest');
  for (const action of ['circle.detail', 'person.list', 'person.remark.list', 'relation.list', 'invite.create']) await denied(action, family);
  assert.equal((await ok('join.mine')).applications.find(row => row.id === application.id).canEnter, false);
  await denied('invite.apply', {token: invite.token}, 'INVITE_UNAVAILABLE');
  as('demo-owner'); const fresh = (await ok('invite.create', family)).invite;
  const secondApplication = await apply('demo-guest', fresh, '重新加入的亲戚');
  as('demo-owner'); await targetApproval(secondApplication, person.id);
  as('demo-guest');
  assert.equal((await mine()).id, person.id);
  assert.equal((await currentMember()).role, 'member');
  assert.deepEqual(await ok('person.remark.list', family), {remarks: {}});
  await denied('invite.create', family);
  const count = (await ok('person.list', family)).persons.length;
  assert.equal(count, 8);
  assert.equal((await ok('relation.list', family)).relations.some(relation => [relation.from, relation.to].includes(person.id)), true);
  await ok('member.leave', family);
  await denied('person.list', family);
  as('demo-owner'); assert.equal((await ok('person.list', family)).persons.length, count);
});

test('an old claim cannot bind a removed account and a new self card after rejoining belongs to the current membership', async () => {
  resetDemoData(); const invite = (await ok('invite.create', family)).invite;
  const application = await apply('demo-guest', invite, '先离开再加入');
  as('demo-owner'); await approve(application, {deferRelation: true});
  as('demo-guest'); const first = await mine(); const oldMember = await currentMember();
  as('demo-owner'); await ok('person.unclaim', {...family, personId: first.id});
  as('demo-guest'); const claim = (await ok('person.claim', {...family, personId: 'f_uncle'})).claimRequest;
  as('demo-owner'); await ok('member.remove', {...family, memberId: oldMember.id});
  await denied('person.claimApprove', {...family, claimRequestId: claim.id}, null);
  assert.equal((await ok('person.get', {...family, personId: 'f_uncle'})).person.isClaimed, false);
  const fresh = (await ok('invite.create', family)).invite;
  const reapplication = await apply('demo-guest', fresh, '先离开再加入');
  as('demo-owner'); await targetApproval(reapplication, first.id);
  as('demo-guest'); const active = await currentMember();
  as('demo-owner'); await ok('person.unclaim', {...family, personId: first.id});
  await ok('person.update', {...family, personId: first.id, matchPhone: '13700137000', patch: full});
  as('demo-guest');
  assert.equal((await ok('account.sync')).linked.some(link => link.personId === first.id), true);
  assert.equal((await currentMember()).id, active.id);
  assert.equal((await currentMember()).personId, first.id);
  assert.equal(db().members.find(row => row.id === oldMember.id).personId, undefined);
  as('demo-owner'); await ok('person.unclaim', {...family, personId: first.id});
  as('demo-guest');
  const created = (await ok('person.create', {...family, name: '我的新资料', ...full, claimSelf: true, deferRelation: true})).person;
  assert.equal((await currentMember()).id, active.id);
  assert.equal((await currentMember()).personId, created.id);
  assert.equal(db().members.find(row => row.id === oldMember.id).personId, undefined);
});

test('classmate admission requires class verification, admin can admit an existing classmate, and family authority stays separate', async () => {
  resetDemoData(); const circleId = 'class_demo';
  const invitation = (await ok('invite.create', {circleId})).invite;
  await signIn('demo-guest', '回来的老同学');
  await denied('invite.apply', {token: invitation.token}, 'INVALID_INPUT');
  const application = (await ok('invite.apply', {token: invitation.token, note: '青禾中学 2014 届二班，班主任王老师'})).application;
  await denied('person.list', {circleId});
  as('demo-owner');
  assert.match((await ok('join.list', {circleId})).applications.find(row => row.id === application.id).note, /二班/);
  await approve(application);
  as('demo-guest'); const member = await currentMember(circleId); const self = await mine(circleId);
  assert.equal((await ok('person.list', {circleId})).persons.length, 6);
  await denied('person.update', {circleId, personId: 'c_sun', patch: {name: '改别人'} });
  await ok('person.update', {circleId, personId: self.id, patch: {bio: '现在在杭州工作'}});
  as('demo-owner'); await ok('member.setRole', {circleId, memberId: member.id, role: 'admin'});
  as('demo-guest'); const secondInvitation = (await ok('invite.create', {circleId})).invite;
  const secondApplication = await apply('demo-guest-2', secondInvitation, '孙妍');
  as('demo-guest'); await targetApproval(secondApplication, 'c_sun');
  assert.equal((await ok('person.list', {circleId})).persons.length, 6);
  assert.equal((await ok('relation.list', {circleId})).relations.length, 0);
  await denied('relation.create', {circleId, from: self.id, to: 'c_sun', type: 'sibling'}, 'WRONG_CIRCLE_TYPE');
  await denied('invite.create', family);
  as('demo-guest-2'); assert.equal((await mine(circleId)).id, 'c_sun');
  await denied('join.list', {circleId});
  await ok('member.leave', {circleId}); await denied('person.list', {circleId});
  as('demo-guest'); assert.equal((await ok('person.list', {circleId})).persons.length, 6);
});
