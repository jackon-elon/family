const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiService } = require('../dist/service.js');
const { MemoryRepository } = require('../dist/memory-repository.js');
const { handlePhotoUpload } = require('../../cloudfunctions/api/photo-upload.js');

function fixture() {
  let clock = 1_800_000_000_000;
  const api = new ApiService(new MemoryRepository(), () => clock);
  const call = async (user, action, payload = {}) => api.invoke({action, payload}, user);
  const ok = async (user, action, payload = {}) => {
    const response = await call(user, action, payload);
    assert.equal(response.ok, true, `${action}: ${JSON.stringify(response)}`);
    return response.data;
  };
  const denied = async (user, action, payload, code) => {
    const response = await call(user, action, payload);
    assert.deepEqual(response.ok, false);
    assert.equal(response.error.code, code, JSON.stringify(response));
  };
  const create = async (user = 'owner', type = 'family', mode = 'shared') => {
    const payload = {name: '测试圈', type, mode};
    if (type === 'classmate') Object.assign(payload, {school: '一中', cohort: '2020', className: '三班'});
    return (await ok(user, 'circle.create', payload)).circle;
  };
  const join = async (owner, user, circleId, claimPersonId) => {
    const invite = (await ok(owner, 'invite.create', {circleId})).invite;
    const application = (await ok(user, 'invite.apply', {token: invite.token, name: user, note: '本班同学', claimPersonId})).application;
    await ok(owner, 'join.approve', {circleId, applicationId: application.id});
    return (await ok(owner, 'member.list', {circleId})).members.find(m => !m.isSelf && m.personId === claimPersonId);
  };
  return {api, call, ok, denied, create, join, advance: ms => {clock += ms;}};
}

test('圈子隔离与跨圈管理员越权', async () => {
  const f = fixture();
  const family = await f.create('a');
  assert.equal(family.ownerId, undefined);
  const classmate = await f.create('b', 'classmate');
  await f.ok('a', 'person.create', {circleId: family.id, name: '外婆'});
  await f.denied('b', 'person.list', {circleId: family.id}, 'FORBIDDEN');
  await f.denied('a', 'invite.create', {circleId: classmate.id}, 'FORBIDDEN');
  const familyPerson = (await f.ok('a', 'person.list', {circleId: family.id})).persons[0];
  await f.denied('b', 'person.get', {circleId: classmate.id, personId: familyPerson.id}, 'NOT_FOUND');
  await f.denied('b', 'relation.create', {circleId: classmate.id, from: familyPerson.id, to: familyPerson.id, type: 'parent'}, 'WRONG_CIRCLE_TYPE');
});

test('转发邀请只可申请，一次审批有效，含并发审批', async () => {
  const f = fixture();
  const circle = await f.create();
  const invite = (await f.ok('owner', 'invite.create', {circleId: circle.id})).invite;
  assert.match(invite.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(invite.token.length, 32);
  const preview = await f.ok(undefined, 'invite.preview', {token: invite.token});
  assert.equal(preview.circle.name, circle.name);
  assert.equal(preview.circle.memberCount, undefined);
  await f.denied('stranger', 'person.list', {circleId: circle.id}, 'FORBIDDEN');
  const a = (await f.ok('alice', 'invite.apply', {token: invite.token, name: '爱丽丝'})).application;
  const b = (await f.ok('bob', 'invite.apply', {token: invite.token, name: '鲍勃'})).application;
  await f.denied('alice', 'person.list', {circleId: circle.id}, 'FORBIDDEN');
  const results = await Promise.all([
    f.call('owner', 'join.approve', {circleId: circle.id, applicationId: a.id}),
    f.call('owner', 'join.approve', {circleId: circle.id, applicationId: b.id})
  ]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => !r.ok).length, 1);
  const members = (await f.ok('owner', 'member.list', {circleId: circle.id})).members;
  assert.equal(members.length, 2);
  const used = await f.ok(undefined, 'invite.preview', {token: invite.token});
  assert.equal(used.status, 'used');
});

test('撤销和过期邀请不可申请或审批', async () => {
  const f = fixture();
  const circle = await f.create();
  const revoked = (await f.ok('owner', 'invite.create', {circleId: circle.id})).invite;
  await f.ok('owner', 'invite.revoke', {circleId: circle.id, inviteId: revoked.id});
  await f.denied('a', 'invite.apply', {token: revoked.token, name: 'A'}, 'INVITE_INACTIVE');
  const expiring = (await f.ok('owner', 'invite.create', {circleId: circle.id})).invite;
  const application = (await f.ok('a', 'invite.apply', {token: expiring.token, name: 'A'})).application;
  f.advance(72 * 60 * 60 * 1000);
  await f.denied('owner', 'join.approve', {circleId: circle.id, applicationId: application.id}, 'INVITE_INACTIVE');
});

test('普通成员不能邀请，圈主可以任免管理员', async () => {
  const f = fixture();
  const circle = await f.create();
  await f.join('owner', 'member', circle.id);
  const members = (await f.ok('owner', 'member.list', {circleId: circle.id})).members;
  const target = members.find(m => !m.isSelf);
  await f.denied('member', 'invite.create', {circleId: circle.id}, 'FORBIDDEN');
  await f.ok('owner', 'member.setRole', {circleId: circle.id, memberId: target.id, role: 'admin'});
  await f.ok('member', 'invite.create', {circleId: circle.id});
  await f.denied('member', 'member.setRole', {circleId: circle.id, memberId: target.id, role: 'member'}, 'FORBIDDEN');
  await f.ok('owner', 'member.setRole', {circleId: circle.id, memberId: target.id, role: 'member'});
  await f.denied('member', 'invite.create', {circleId: circle.id}, 'FORBIDDEN');
});

test('圈主移交后原圈主可退出，新圈主仍须先移交', async () => {
  const f = fixture();
  const circle = await f.create();
  await f.join('owner', 'member', circle.id);
  const target = (await f.ok('owner', 'member.list', {circleId: circle.id})).members.find(m => !m.isSelf);
  await f.denied('member', 'audit.list', {circleId: circle.id}, 'FORBIDDEN');
  await f.denied('owner', 'member.leave', {circleId: circle.id}, 'OWNER_REQUIRED');
  await f.ok('owner', 'circle.transferOwner', {circleId: circle.id, memberId: target.id});
  const newOwner = await f.ok('member', 'circle.detail', {circleId: circle.id});
  assert.equal(newOwner.role, 'owner');
  await f.ok('owner', 'member.leave', {circleId: circle.id});
  await f.denied('owner', 'person.list', {circleId: circle.id}, 'FORBIDDEN');
  await f.denied('member', 'member.leave', {circleId: circle.id}, 'OWNER_REQUIRED');
  const audit = (await f.ok('member', 'audit.list', {circleId: circle.id})).events;
  assert.ok(audit.some(item => item.type === 'circle.transferOwner'));
  assert.ok(audit.some(item => item.type === 'member.leave'));
});

test('联系方式与城市由本人逐字段公开，管理员不能绕过', async () => {
  const f = fixture();
  const circle = await f.create();
  const self = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '圈主', claimSelf: true})).person;
  await f.join('owner', 'member', circle.id);
  const {cloudPath} = await f.ok('owner', 'photo.uploadPath', {circleId: circle.id, personId: self.id});
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: self.id, patch: {phone: '13800000000', wechatId: 'wx_owner', city: '北京', country: '中国', photoFileId: `cloud://env.bucket/${cloudPath}`}});
  let view = (await f.ok('member', 'person.get', {circleId: circle.id, personId: self.id})).person;
  for (const key of ['phone', 'wechatId', 'city', 'country', 'photoFileId']) assert.equal(view[key], undefined, key);
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: self.id, patch: {}, visibility: {city: 'circle', phone: 'circle'}});
  view = (await f.ok('member', 'person.get', {circleId: circle.id, personId: self.id})).person;
  assert.equal(view.phone, '13800000000');
  assert.equal(view.city, '北京');
  assert.equal(view.country, '中国');
  assert.equal(view.wechatId, undefined);
  assert.equal(view.photoFileId, undefined);
  assert.equal(view.visibility, undefined);
});

test('照片临时链接只对获准查看的成员签发', async () => {
  const repo = new MemoryRepository();
  let signed = 0;
  const api = new ApiService(repo, () => 1_800_000_000_000, async fileId => {signed++; return `https://signed.example/${encodeURIComponent(fileId)}`;});
  const call = async (user, action, payload) => api.invoke({action, payload}, user);
  const circle = (await call('owner', 'circle.create', {type:'family', name:'家', mode:'shared'})).data.circle;
  const person = (await call('owner', 'person.create', {circleId:circle.id, name:'我', claimSelf:true})).data.person;
  const path = (await call('owner', 'photo.uploadPath', {circleId:circle.id, personId:person.id})).data.cloudPath;
  const photoFileId = `cloud://long-production-env-12345678901234567890.very-long-bucket-12345678901234567890/${path}`;
  assert.ok(photoFileId.length > 120);
  assert.equal((await call('owner', 'person.update', {circleId:circle.id, personId:person.id, patch:{photoFileId:'cloud://other/elsewhere.jpg'}})).error.code, 'INVALID_INPUT');
  await call('owner', 'person.update', {circleId:circle.id, personId:person.id, patch:{photoFileId}});
  const blocked = await call('other', 'photo.url', {circleId:circle.id, personId:person.id});
  assert.equal(blocked.error.code, 'FORBIDDEN');
  assert.equal(signed, 0);
  const visible = await call('owner', 'photo.url', {circleId:circle.id, personId:person.id});
  assert.equal(visible.ok, true);
  assert.match(visible.data.url, /^https:\/\/signed\.example\//);
  assert.equal(signed, 1);
  const invite = (await call('owner', 'invite.create', {circleId:circle.id})).data.invite;
  const application = (await call('helper', 'invite.apply', {token:invite.token, name:'代维护人'})).data.application;
  await call('owner', 'join.approve', {circleId:circle.id, applicationId:application.id});
  const helper = (await call('owner', 'member.list', {circleId:circle.id})).data.members.find(m => m.name === '代维护人');
  await call('owner', 'member.setRole', {circleId:circle.id, memberId:helper.id, role:'admin'});
  assert.equal((await call('helper', 'photo.url', {circleId:circle.id, personId:person.id})).error.code, 'FORBIDDEN');
  const delegation = (await call('owner', 'delegation.grant', {circleId:circle.id, personId:person.id, adminMemberId:helper.id, fields:['photoFileId']})).data.delegation;
  assert.equal((await call('helper', 'photo.url', {circleId:circle.id, personId:person.id})).ok, true);
  await call('owner', 'delegation.revoke', {circleId:circle.id, delegationId:delegation.id});
  assert.equal((await call('helper', 'photo.url', {circleId:circle.id, personId:person.id})).error.code, 'FORBIDDEN');
});

test('照片上传先校验权限和大小，服务端上传后绑定人物', async () => {
  const f = fixture();
  const circle = await f.create();
  const person = (await f.ok('owner', 'person.create', {circleId:circle.id, name:'我', claimSelf:true})).person;
  let uploads = 0;
  const storage = {
    uploadFile: async ({cloudPath, fileContent}) => {uploads++; assert.ok(fileContent.length < 1024 * 1024); return {fileID: `cloud://env.bucket/${cloudPath}`};},
    deleteFile: async () => ({})
  };
  const base64 = Buffer.from([0xff, 0xd8, 0x00, 0x00, 0xff, 0xd9]).toString('base64');
  let response = await handlePhotoUpload({payload:{circleId:circle.id, personId:person.id, base64}}, 'stranger', f.api, storage);
  assert.equal(response.error.code, 'FORBIDDEN');
  assert.equal(uploads, 0);
  response = await handlePhotoUpload({payload:{circleId:circle.id, personId:person.id, base64:'not-an-image'}}, 'owner', f.api, storage);
  assert.equal(response.error.code, 'INVALID_IMAGE');
  assert.equal(uploads, 0);
  response = await handlePhotoUpload({payload:{circleId:circle.id, personId:person.id, base64}}, 'owner', f.api, storage);
  assert.equal(response.ok, true);
  assert.equal(uploads, 1);
  assert.match(response.data.person.photoFileId, /photos\/owner\//);
});

test('移除成员立即失去访问，人物节点保留但私人资料清空', async () => {
  const f = fixture();
  const circle = await f.create();
  const placeholder = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '长辈'})).person;
  await f.join('owner', 'elder', circle.id, placeholder.id);
  await f.ok('elder', 'person.update', {circleId: circle.id, personId: placeholder.id, patch: {city: '上海', phone: '12345'}, visibility: {city: 'circle', phone: 'circle'}});
  const member = (await f.ok('owner', 'member.list', {circleId: circle.id})).members.find(m => !m.isSelf);
  await f.ok('owner', 'member.remove', {circleId: circle.id, memberId: member.id});
  await f.denied('elder', 'person.list', {circleId: circle.id}, 'FORBIDDEN');
  const view = (await f.ok('owner', 'person.get', {circleId: circle.id, personId: placeholder.id})).person;
  assert.equal(view.name, '长辈');
  assert.equal(view.city, undefined);
  assert.equal(view.phone, undefined);
  assert.equal(view.isClaimed, false);
});

test('代维护仅可按授权字段修改，撤销后立即失效', async () => {
  const f = fixture();
  const circle = await f.create();
  const card = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '长辈'})).person;
  await f.join('owner', 'elder', circle.id, card.id);
  await f.join('owner', 'other', circle.id);
  const elderMember = (await f.ok('owner', 'member.list', {circleId: circle.id})).members.find(m => m.personId === card.id);
  await f.ok('owner', 'member.setRole', {circleId: circle.id, memberId: elderMember.id, role: 'admin'});
  await f.ok('elder', 'person.update', {circleId: circle.id, personId: card.id, patch: {country: '中国', province: '广东', city: '佛山', phone: '12345'}});
  assert.equal((await f.ok('owner', 'person.get', {circleId: circle.id, personId: card.id})).person.city, undefined);
  // The circle owner is also an administrator and can be delegated by the elder.
  const ownerMember = (await f.ok('owner', 'member.list', {circleId: circle.id})).members.find(m => m.isSelf);
  const delegation = (await f.ok('elder', 'delegation.grant', {circleId: circle.id, personId: card.id, adminMemberId: ownerMember.id, fields: ['city']})).delegation;
  const delegatedView = (await f.ok('owner', 'person.get', {circleId: circle.id, personId: card.id})).person;
  assert.deepEqual(delegatedView.myDelegatedFields, ['city', 'country', 'province']);
  assert.equal(delegatedView.city, '佛山');
  assert.equal(delegatedView.province, '广东');
  assert.equal(delegatedView.phone, undefined);
  assert.equal((await f.ok('other', 'person.get', {circleId: circle.id, personId: card.id})).person.city, undefined);
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: card.id, patch: {country: '中国', province: '广东', city: '广州'}});
  const elderView = (await f.ok('elder', 'person.get', {circleId: circle.id, personId: card.id})).person;
  assert.equal(elderView.country, '中国');
  assert.equal(elderView.province, '广东');
  assert.equal(elderView.city, '广州');
  await f.denied('owner', 'person.update', {circleId: circle.id, personId: card.id, patch: {phone: '123'}}, 'FORBIDDEN');
  await f.denied('owner', 'person.update', {circleId: circle.id, personId: card.id, patch: {}, visibility: {city: 'circle'}}, 'FORBIDDEN');
  await f.ok('elder', 'delegation.revoke', {circleId: circle.id, delegationId: delegation.id});
  assert.equal((await f.ok('owner', 'person.get', {circleId: circle.id, personId: card.id})).person.city, undefined);
  await f.denied('owner', 'person.update', {circleId: circle.id, personId: card.id, patch: {city: '深圳'}}, 'FORBIDDEN');
});

test('普通成员认领须管理员批准，关联人物删除被阻止', async () => {
  const f = fixture();
  const circle = await f.create();
  const a = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '甲'})).person;
  const b = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '乙'})).person;
  await f.join('owner', 'member', circle.id);
  const claimRequest = (await f.ok('member', 'person.claim', {circleId: circle.id, personId: a.id})).claimRequest;
  assert.equal((await f.ok('owner', 'person.get', {circleId: circle.id, personId: a.id})).person.isClaimed, false);
  await f.ok('owner', 'person.claimApprove', {circleId: circle.id, claimRequestId: claimRequest.id});
  assert.equal((await f.ok('owner', 'person.get', {circleId: circle.id, personId: a.id})).person.isClaimed, true);
  await f.denied('member', 'person.claim', {circleId: circle.id, personId: b.id}, 'ALREADY_CLAIMED');
  await f.ok('owner', 'relation.create', {circleId: circle.id, from: a.id, to: b.id, type: 'parent'});
  await f.denied('owner', 'person.delete', {circleId: circle.id, personId: b.id}, 'RELATION_CONNECTED');
});

test('管理员可纠正误认领并清除私人资料，申请人只看自己的进度', async () => {
  const f = fixture();
  const circle = await f.create();
  const card = (await f.ok('owner', 'person.create', {circleId:circle.id, name:'同名卡'})).person;
  const token = (await f.ok('owner', 'invite.create', {circleId:circle.id})).invite.token;
  const application = (await f.ok('member', 'invite.apply', {token, name:'小李', claimPersonId:card.id})).application;
  const mine = (await f.ok('member', 'join.mine')).applications;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, application.id);
  await f.ok('owner', 'join.approve', {circleId:circle.id, applicationId:application.id});
  await f.ok('member', 'person.update', {circleId:circle.id, personId:card.id, patch:{phone:'12345'}, visibility:{phone:'circle'}});
  await f.ok('owner', 'person.unclaim', {circleId:circle.id, personId:card.id});
  const view = (await f.ok('member', 'person.get', {circleId:circle.id, personId:card.id})).person;
  assert.equal(view.isClaimed, false);
  assert.equal(view.phone, undefined);
  const own = (await f.ok('member', 'person.create', {circleId:circle.id, name:'正确本人', claimSelf:true})).person;
  assert.equal(own.isSelf, true);
});

test('成员列表与认领审核返回可核对的姓名', async () => {
  const f = fixture();
  const circle = await f.create();
  let owner = (await f.ok('owner', 'member.list', {circleId: circle.id})).members.find(m => m.isSelf);
  assert.equal(owner.name, '圈主');
  await f.ok('owner', 'person.create', {circleId: circle.id, name: '张圈主', claimSelf: true});
  owner = (await f.ok('owner', 'member.list', {circleId: circle.id})).members.find(m => m.isSelf);
  assert.equal(owner.name, '张圈主');
  const card = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '待认领'})).person;
  const invite = (await f.ok('owner', 'invite.create', {circleId: circle.id})).invite;
  const application = (await f.ok('student', 'invite.apply', {token: invite.token, name: '李同学'})).application;
  await f.ok('owner', 'join.approve', {circleId: circle.id, applicationId: application.id});
  const student = (await f.ok('owner', 'member.list', {circleId: circle.id})).members.find(m => !m.isSelf);
  assert.equal(student.name, '李同学');
  await f.ok('student', 'person.claim', {circleId: circle.id, personId: card.id});
  const claim = (await f.ok('owner', 'person.claimList', {circleId: circle.id})).claimRequests[0];
  assert.equal(claim.applicantName, '李同学');
});

test('无现成人物卡的同学可创建自己的资料，不能擅自建他人卡', async () => {
  const f = fixture();
  const circle = await f.create('owner', 'classmate');
  await f.join('owner', 'student', circle.id);
  await f.denied('student', 'person.create', {circleId: circle.id, name: '其他同学'}, 'FORBIDDEN');
  const self = (await f.ok('student', 'person.create', {circleId: circle.id, name: '小明', claimSelf: true})).person;
  assert.equal(self.isSelf, true);
  await f.ok('student', 'person.update', {circleId: circle.id, personId: self.id, patch: {city: '杭州', industry: '教育'}, visibility: {city: 'circle'}});
  await f.denied('student', 'person.create', {circleId: circle.id, name: '重复本人卡', claimSelf: true}, 'ALREADY_CLAIMED');
});

test('同学圈申请需提供同班核对说明', async () => {
  const f = fixture();
  const circle = await f.create('owner', 'classmate');
  const invite = (await f.ok('owner', 'invite.create', {circleId:circle.id})).invite;
  await f.denied('student', 'invite.apply', {token:invite.token, name:'小明'}, 'INVALID_INPUT');
  const application = (await f.ok('student', 'invite.apply', {token:invite.token, name:'小明', note:'2020 届三班'})).application;
  assert.equal(application.status, 'pending');
});

test('同一关系并发创建仅保留一条，关联计数阻止悬空人物', async () => {
  const f = fixture();
  const circle = await f.create();
  const a = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '甲'})).person;
  const b = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '乙'})).person;
  const request = {circleId: circle.id, from: a.id, to: b.id, type: 'sibling'};
  const results = await Promise.all([f.call('owner', 'relation.create', request), f.call('owner', 'relation.create', {...request, from: b.id, to: a.id})]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal((await f.ok('owner', 'relation.list', {circleId: circle.id})).relations.length, 1);
  await f.denied('owner', 'person.delete', {circleId: circle.id, personId: a.id}, 'RELATION_CONNECTED');
  const rid = results.find(r => r.ok).data.relation.id;
  assert.equal(results.find(r => r.ok).data.relation.createdBy, undefined);
  await f.ok('owner', 'relation.delete', {circleId: circle.id, relationId: rid});
  await f.ok('owner', 'person.delete', {circleId: circle.id, personId: a.id});
});
