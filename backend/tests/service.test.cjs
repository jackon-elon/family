const test = require('node:test');
const assert = require('node:assert/strict');
const { ApiService } = require('../dist/service.js');
const { MemoryRepository } = require('../dist/memory-repository.js');
const { handlePhotoUpload } = require('../../cloudfunctions/api/photo-upload.js');

function fixture() {
  let clock = 1_800_000_000_000;
  const repo = new MemoryRepository();
  const api = new ApiService(repo, () => clock);
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
    const application = (await ok(user, 'invite.apply', {token: invite.token, name: user, note: '本班同学'})).application;
    await ok(owner, 'join.approve', {circleId, applicationId: application.id});
    if (claimPersonId) {
      const request = (await ok(user, 'person.claim', {circleId, personId: claimPersonId})).claimRequest;
      await ok(owner, 'person.claimApprove', {circleId, claimRequestId: request.id});
    }
    return (await ok(owner, 'member.list', {circleId})).members.find(m => !m.isSelf && (claimPersonId ? m.personId === claimPersonId : m.name === user));
  };
  return {api, repo, call, ok, denied, create, join, advance: ms => {clock += ms;}};
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

test('有效圈数超过事务读取上限时列表明确拒绝', async () => {
  const f = fixture();
  await f.create();
  await f.repo.atomic(async tx => {
    for (let i = 0; i < 80; i++) await tx.put('members', {
      id: `extra-member-${i}`, circleId: `extra-circle-${i}`, userId: 'owner',
      name: '圈主', role: 'owner', status: 'active', joinedAt: i
    });
  });
  await f.denied('owner', 'circle.list', {}, 'DATA_LIMIT');
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

test('管理员待审列表标明邀请临期、过期、撤销和缺失状态', async () => {
  const f = fixture();
  const circle = await f.create();
  const soon = (await f.ok('owner','invite.create',{circleId:circle.id})).invite;
  const application = (await f.ok('applicant','invite.apply',{token:soon.token,name:'申请人'})).application;
  const read = async id => (await f.ok('owner','join.list',{circleId:circle.id})).applications.find(item=>item.id===id);
  let row = await read(application.id);
  assert.equal(row.status,'pending');
  assert.equal(row.inviteStatus,'active');
  assert.equal(row.inviteExpiresAt,soon.expiresAt);
  f.advance(72*60*60*1000 - 60*1000);
  row = await read(application.id);
  assert.equal(row.inviteStatus,'active');
  assert.equal(row.inviteExpiresAt,soon.expiresAt);
  f.advance(60*1000);
  row = await read(application.id);
  assert.equal(row.inviteStatus,'expired');
  await f.denied('owner','join.approve',{circleId:circle.id,applicationId:application.id},'INVITE_INACTIVE');

  const revoked = (await f.ok('owner','invite.create',{circleId:circle.id})).invite;
  const revocation = (await f.ok('other','invite.apply',{token:revoked.token,name:'另一申请人'})).application;
  await f.ok('owner','invite.revoke',{circleId:circle.id,inviteId:revoked.id});
  assert.equal((await read(revocation.id)).inviteStatus,'revoked');
  await f.repo.atomic(tx=>tx.delete('invites',revoked.id));
  row = await read(revocation.id);
  assert.equal(row.inviteStatus,'missing');
  assert.equal(row.inviteExpiresAt,undefined);
  await f.denied('applicant','join.list',{circleId:circle.id},'FORBIDDEN');
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

test('任意城市代表点按城市权限过滤，并以约十公里精度保存', async () => {
  const f = fixture();
  const circle = await f.create();
  const me = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '我', claimSelf: true})).person;
  await f.join('owner', 'member', circle.id);
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: me.id, patch: {
    city: '奥斯陆', country: '挪威', latitude: 59.9139, longitude: 10.7522
  }});
  let view = (await f.ok('member', 'person.get', {circleId: circle.id, personId: me.id})).person;
  assert.equal(view.city, undefined);
  assert.equal(view.latitude, undefined);
  assert.equal(view.longitude, undefined);
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: me.id, patch: {}, visibility: {city: 'circle'}});
  view = (await f.ok('member', 'person.get', {circleId: circle.id, personId: me.id})).person;
  assert.equal(view.city, '奥斯陆');
  assert.equal(view.country, '挪威');
  assert.equal(view.latitude, 59.9);
  assert.equal(view.longitude, 10.8);
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: me.id, patch: {city: '卑尔根'}});
  view = (await f.ok('member', 'person.get', {circleId: circle.id, personId: me.id})).person;
  assert.equal(view.city, '卑尔根');
  assert.equal(view.latitude, undefined);
  assert.equal(view.longitude, undefined);
});

test('城市坐标必须成对、在范围内，不能在未填写城市时保存', async () => {
  const f = fixture();
  const circle = await f.create();
  const me = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '我', claimSelf: true})).person;
  const base = {circleId: circle.id, personId: me.id};
  await f.denied('owner', 'person.update', {...base, patch: {city: '北京', latitude: 39.9}}, 'INVALID_INPUT');
  await f.denied('owner', 'person.update', {...base, patch: {city: '北京', latitude: 91, longitude: 116.4}}, 'INVALID_INPUT');
  await f.denied('owner', 'person.update', {...base, patch: {latitude: 39.9, longitude: 116.4}}, 'INVALID_INPUT');
  const view = (await f.ok('owner', 'person.get', base)).person;
  assert.equal(view.city, undefined);
  assert.equal(view.latitude, undefined);
});

test('照片临时链接只对获准查看的成员签发', async () => {
  const repo = new MemoryRepository();
  let signed = 0;
  const api = new ApiService(repo, () => 1_800_000_000_000, async fileId => {signed++; return `https://signed.example/${encodeURIComponent(fileId)}`;});
  const call = async (user, action, payload) => api.invoke({action, payload}, user);
  const circle = (await call('owner', 'circle.create', {type:'family', name:'家', mode:'shared'})).data.circle;
  const person = (await call('owner', 'person.create', {circleId:circle.id, name:'我', claimSelf:true})).data.person;
  const path = (await call('owner', 'photo.uploadPath', {circleId:circle.id, personId:person.id})).data.cloudPath;
  assert.match(path, /^photos\/[0-9a-f]{40}\/[0-9a-f-]{36}\.jpg$/);
  assert.equal(path.includes('/owner/'), false);
  const photoFileId = `cloud://long-production-env-12345678901234567890.very-long-bucket-12345678901234567890/${path}`;
  assert.ok(photoFileId.length > 120);
  assert.equal((await call('owner', 'person.update', {circleId:circle.id, personId:person.id, patch:{photoFileId:'cloud://other/elsewhere.jpg'}})).error.code, 'INVALID_INPUT');
  await call('owner', 'person.update', {circleId:circle.id, personId:person.id, patch:{photoFileId}});
  const ownView = (await call('owner', 'person.get', {circleId:circle.id, personId:person.id})).data.person;
  assert.equal(ownView.hasPhoto, true);
  assert.equal(ownView.photoFileId, undefined);
  const blocked = await call('other', 'photo.url', {circleId:circle.id, personId:person.id});
  assert.equal(blocked.error.code, 'FORBIDDEN');
  assert.equal(signed, 0);
  const visible = await call('owner', 'photo.url', {circleId:circle.id, personId:person.id});
  assert.equal(visible.ok, true);
  assert.match(visible.data.url, /^https:\/\/signed\.example\//);
  assert.equal(visible.data.url.includes('/owner/'), false);
  assert.equal(signed, 1);
  const invite = (await call('owner', 'invite.create', {circleId:circle.id})).data.invite;
  const application = (await call('helper', 'invite.apply', {token:invite.token, name:'代维护人'})).data.application;
  await call('owner', 'join.approve', {circleId:circle.id, applicationId:application.id});
  const helper = (await call('owner', 'member.list', {circleId:circle.id})).data.members.find(m => m.name === '代维护人');
  // Uploading a portrait does not silently publish it. The owner can share it
  // with this circle, and can withdraw that choice without losing the photo.
  assert.equal((await call('helper', 'photo.url', {circleId:circle.id, personId:person.id})).error.code, 'FORBIDDEN');
  assert.equal((await call('helper', 'person.get', {circleId:circle.id, personId:person.id})).data.person.hasPhoto, false);
  await call('owner', 'person.update', {circleId:circle.id, personId:person.id, patch:{}, visibility:{photoFileId:'circle'}});
  const publicView = (await call('helper', 'person.get', {circleId:circle.id, personId:person.id})).data.person;
  assert.equal(publicView.hasPhoto, true);
  assert.equal(publicView.photoFileId, undefined);
  assert.equal((await call('helper', 'photo.url', {circleId:circle.id, personId:person.id})).ok, true);
  await call('owner', 'person.update', {circleId:circle.id, personId:person.id, patch:{}, visibility:{photoFileId:'self'}});
  assert.equal((await call('helper', 'photo.url', {circleId:circle.id, personId:person.id})).error.code, 'FORBIDDEN');
  await call('owner', 'member.setRole', {circleId:circle.id, memberId:helper.id, role:'admin'});
  assert.equal((await call('helper', 'photo.url', {circleId:circle.id, personId:person.id})).error.code, 'FORBIDDEN');
  const delegation = (await call('owner', 'delegation.grant', {circleId:circle.id, personId:person.id, adminMemberId:helper.id, fields:['photoFileId']})).data.delegation;
  const delegatedView = (await call('helper', 'person.get', {circleId:circle.id, personId:person.id})).data.person;
  assert.equal(delegatedView.hasPhoto, true);
  assert.equal(delegatedView.photoFileId, undefined);
  assert.equal((await call('helper', 'photo.url', {circleId:circle.id, personId:person.id})).ok, true);
  await call('owner', 'delegation.revoke', {circleId:circle.id, delegationId:delegation.id});
  assert.equal((await call('helper', 'photo.url', {circleId:circle.id, personId:person.id})).error.code, 'FORBIDDEN');
});

test('照片临时链接在权限事务提交后签发', async () => {
  const memory = new MemoryRepository();
  let insideTransaction = false;
  const repo = {atomic: async work => {
    insideTransaction = true;
    try { return await memory.atomic(work); }
    finally { insideTransaction = false; }
  }};
  const api = new ApiService(repo, Date.now, async () => {
    assert.equal(insideTransaction, false);
    return 'https://signed.example/photo';
  });
  const call = async (actor, action, payload) => api.invoke({action, payload}, actor);
  const circle = (await call('owner', 'circle.create', {type: 'family', name: '家', mode: 'shared'})).data.circle;
  const person = (await call('owner', 'person.create', {circleId: circle.id, name: '我', claimSelf: true})).data.person;
  const cloudPath = (await call('owner', 'photo.uploadPath', {circleId: circle.id, personId: person.id})).data.cloudPath;
  await call('owner', 'person.update', {circleId: circle.id, personId: person.id, patch: {photoFileId: `cloud://env.bucket/${cloudPath}`}});
  const signed = await call('owner', 'photo.url', {circleId: circle.id, personId: person.id});
  assert.equal(signed.ok, true);
  assert.equal(signed.data.url, 'https://signed.example/photo');
});

test('批量照片签发只返回有权人物 URL，限 20 人且不返回文件路径', async () => {
  const f = fixture();
  const circle = await f.create();
  const own = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '圈主', claimSelf: true})).person;
  const viewer = await f.join('owner', 'viewer', circle.id);
  const other = (await f.ok('viewer', 'person.create', {circleId: circle.id, name: '成员', claimSelf: true})).person;
  const makePhoto = async (actor, personId, visibility) => {
    const path = (await f.ok(actor, 'photo.uploadPath', {circleId: circle.id, personId})).cloudPath;
    const fileId = `cloud://env.bucket/${path}`;
    await f.ok(actor, 'person.update', {circleId: circle.id, personId, patch: {photoFileId: fileId}, visibility: {photoFileId: visibility}});
    return fileId;
  };
  const ownFile = await makePhoto('owner', own.id, 'self');
  const otherFile = await makePhoto('viewer', other.id, 'circle');
  let batches = 0;
  const api = new ApiService(f.repo, Date.now, async fileId => `https://signed.example/${fileId}`, async ids => {
    batches++;
    assert.deepEqual(ids, [otherFile]);
    return {[otherFile]: 'https://signed.example/visible'};
  });
  const request = {action: 'photo.urls', payload: {circleId: circle.id, personIds: [own.id, other.id, other.id, 'unknown']}};
  const result = await api.invoke(request, 'viewer');
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.urls, {[other.id]: 'https://signed.example/visible'});
  assert.equal(JSON.stringify(result).includes(ownFile), false);
  assert.equal(batches, 1);
  const tooMany = await api.invoke({action: 'photo.urls', payload: {circleId: circle.id, personIds: Array.from({length: 21}, (_, i) => `p${i}`)}}, 'viewer');
  assert.equal(tooMany.error.code, 'INVALID_INPUT');
  await f.ok('owner', 'member.setRole', {circleId: circle.id, memberId: viewer.id, role: 'admin'});
  const delegated = (await f.ok('owner', 'delegation.grant', {circleId: circle.id, personId: own.id, adminMemberId: viewer.id, fields: ['photoFileId']})).delegation;
  const delegatedApi = new ApiService(f.repo, Date.now, undefined, async ids => Object.fromEntries(ids.map(id => [id, `https://signed.example/${id === ownFile ? 'private' : 'visible'}`])));
  const visibleToAdmin = await delegatedApi.invoke({action: 'photo.urls', payload: {circleId: circle.id, personIds: [own.id, other.id]}}, 'viewer');
  assert.equal(visibleToAdmin.data.urls[own.id], 'https://signed.example/private');
  await f.ok('owner', 'delegation.revoke', {circleId: circle.id, delegationId: delegated.id});
  const afterRevoke = await delegatedApi.invoke({action: 'photo.urls', payload: {circleId: circle.id, personIds: [own.id]}}, 'viewer');
  assert.deepEqual(afterRevoke.data.urls, {});
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
  assert.equal(response.data.person.hasPhoto, true);
  assert.equal(response.data.person.photoFileId, undefined);
});

test('更换照片时同一事务保存可见范围，旧客户端默认仅本人可见', async () => {
  const f = fixture();
  const circle = await f.create();
  const person = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '我', claimSelf: true})).person;
  await f.join('owner', 'viewer', circle.id);
  const oldPath = (await f.ok('owner', 'photo.uploadPath', {circleId: circle.id, personId: person.id})).cloudPath;
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: person.id,
    patch: {photoFileId: `cloud://env.bucket/${oldPath}`}, visibility: {photoFileId: 'circle'}});
  assert.equal((await f.ok('viewer', 'person.get', {circleId: circle.id, personId: person.id})).person.hasPhoto, true);
  const base64 = Buffer.from([0xff, 0xd8, 0x00, 0x00, 0xff, 0xd9]).toString('base64');
  const storage = {
    uploadFile: async ({cloudPath}) => ({fileID: `cloud://env.bucket/${cloudPath}`}),
    deleteFile: async () => ({})
  };
  const calls = [];
  const trackedApi = {invoke: async (request, actor) => {
    calls.push(request);
    return f.api.invoke(request, actor);
  }};
  const payload = {circleId: circle.id, personId: person.id, base64};
  let response = await handlePhotoUpload({payload: {...payload, visibility: 'self'}}, 'owner', trackedApi, storage);
  assert.equal(response.ok, true);
  assert.deepEqual(calls.filter(call => call.action === 'person.update').map(call => call.payload.visibility), [{photoFileId: 'self'}]);
  assert.equal((await f.ok('viewer', 'person.get', {circleId: circle.id, personId: person.id})).person.photoFileId, undefined);
  assert.equal((await f.ok('owner', 'person.get', {circleId: circle.id, personId: person.id})).person.visibility.photoFileId, 'self');
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: person.id, patch: {}, visibility: {photoFileId: 'circle'}});
  response = await handlePhotoUpload({payload}, 'owner', trackedApi, storage);
  assert.equal(response.ok, true);
  assert.equal((await f.ok('owner', 'person.get', {circleId: circle.id, personId: person.id})).person.visibility.photoFileId, 'self');
  assert.equal((await f.ok('viewer', 'person.get', {circleId: circle.id, personId: person.id})).person.photoFileId, undefined);
});

test('照片代维护上传沿用原可见范围且不能指定新范围', async () => {
  const f = fixture();
  const circle = await f.create();
  const person = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '长辈', claimSelf: true})).person;
  const helper = await f.join('owner', 'helper', circle.id);
  await f.ok('owner', 'member.setRole', {circleId: circle.id, memberId: helper.id, role: 'admin'});
  await f.ok('owner', 'delegation.grant', {circleId: circle.id, personId: person.id, adminMemberId: helper.id, fields: ['photoFileId']});
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: person.id, patch: {}, visibility: {photoFileId: 'self'}});
  let uploads = 0;
  const storage = {
    uploadFile: async ({cloudPath}) => {uploads++; return {fileID: `cloud://env.bucket/${cloudPath}`};},
    deleteFile: async () => ({})
  };
  const payload = {circleId: circle.id, personId: person.id, base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')};
  let response = await handlePhotoUpload({payload: {...payload, visibility: 'circle'}}, 'helper', f.api, storage);
  assert.equal(response.error.code, 'FORBIDDEN');
  assert.equal(uploads, 0);
  response = await handlePhotoUpload({payload}, 'helper', f.api, storage);
  assert.equal(response.ok, true);
  assert.equal(uploads, 1);
  assert.equal((await f.ok('owner', 'person.get', {circleId: circle.id, personId: person.id})).person.visibility.photoFileId, 'self');
});

test('旧认领人遗留的照片授权不能发放上传路径或占用云存储', async () => {
  const f = fixture();
  const circle = await f.create();
  const person = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '长辈', claimSelf: true})).person;
  const helper = await f.join('owner', 'helper', circle.id);
  await f.ok('owner', 'member.setRole', {circleId: circle.id, memberId: helper.id, role: 'admin'});
  const granted = (await f.ok('owner', 'delegation.grant', {circleId: circle.id, personId: person.id, adminMemberId: helper.id, fields: ['photoFileId']})).delegation;
  await f.repo.atomic(async tx => {
    const stale = await tx.get('delegations', granted.id);
    stale.ownerUserId = 'former-owner';
    await tx.put('delegations', stale);
  });
  await f.denied('helper', 'photo.uploadPath', {circleId: circle.id, personId: person.id}, 'FORBIDDEN');
  let uploaded = false;
  const storage = {uploadFile: async () => {uploaded = true; return {};}, deleteFile: async () => ({})};
  const base64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const result = await handlePhotoUpload({payload: {circleId: circle.id, personId: person.id, base64}}, 'helper', f.api, storage);
  assert.equal(result.error.code, 'FORBIDDEN');
  assert.equal(uploaded, false);
});

test('移除成员立即失去访问，人物节点保留但私人资料清空', async () => {
  const f = fixture();
  const circle = await f.create();
  const placeholder = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '长辈'})).person;
  await f.join('owner', 'elder', circle.id, placeholder.id);
  await f.ok('elder', 'person.update', {circleId: circle.id, personId: placeholder.id, patch: {city: '上海', latitude: 31.2, longitude: 121.5, phone: '12345'}, visibility: {city: 'circle', phone: 'circle'}});
  const member = (await f.ok('owner', 'member.list', {circleId: circle.id})).members.find(m => !m.isSelf);
  await f.ok('owner', 'member.remove', {circleId: circle.id, memberId: member.id});
  await f.denied('elder', 'person.list', {circleId: circle.id}, 'FORBIDDEN');
  const view = (await f.ok('owner', 'person.get', {circleId: circle.id, personId: placeholder.id})).person;
  assert.equal(view.name, '长辈');
  assert.equal(view.city, undefined);
  assert.equal(view.latitude, undefined);
  assert.equal(view.longitude, undefined);
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
  assert.deepEqual(delegatedView.myDelegatedFields, ['city', 'country', 'province', 'latitude', 'longitude']);
  assert.equal(delegatedView.city, '佛山');
  assert.equal(delegatedView.province, '广东');
  assert.equal(delegatedView.phone, undefined);
  assert.equal((await f.ok('other', 'person.get', {circleId: circle.id, personId: card.id})).person.city, undefined);
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: card.id, patch: {country: '中国', province: '广东', city: '广州', latitude: 23.1291, longitude: 113.2644}});
  const elderView = (await f.ok('elder', 'person.get', {circleId: circle.id, personId: card.id})).person;
  assert.equal(elderView.country, '中国');
  assert.equal(elderView.province, '广东');
  assert.equal(elderView.city, '广州');
  assert.equal(elderView.latitude, 23.1);
  assert.equal(elderView.longitude, 113.3);
  await f.denied('owner', 'person.update', {circleId: circle.id, personId: card.id, patch: {phone: '123'}}, 'FORBIDDEN');
  await f.denied('owner', 'person.update', {circleId: circle.id, personId: card.id, patch: {}, visibility: {city: 'circle'}}, 'FORBIDDEN');
  await f.ok('elder', 'delegation.revoke', {circleId: circle.id, delegationId: delegation.id});
  assert.equal((await f.ok('owner', 'person.get', {circleId: circle.id, personId: card.id})).person.city, undefined);
  await f.denied('owner', 'person.update', {circleId: circle.id, personId: card.id, patch: {city: '深圳'}}, 'FORBIDDEN');
});

test('大量代维护授权阻止超过事务上限的移除和降权，成员状态保持不变', async () => {
  const f = fixture();
  const circle = await f.create();
  const helper = await f.join('owner', 'helper', circle.id);
  await f.ok('owner', 'member.setRole', {circleId: circle.id, memberId: helper.id, role: 'admin'});
  await f.repo.atomic(async tx => {
    for (let i = 0; i < 81; i++) await tx.put('delegations', {
      id: `bulk-${i}`, circleId: circle.id, personId: `person-${i}`,
      ownerUserId: 'owner', adminUserId: 'helper', fields: ['bio'], createdAt: 1
    });
  });
  await f.denied('owner', 'member.setRole', {circleId: circle.id, memberId: helper.id, role: 'member'}, 'DATA_LIMIT');
  await f.denied('owner', 'member.remove', {circleId: circle.id, memberId: helper.id}, 'DATA_LIMIT');
  const member = (await f.ok('owner', 'member.list', {circleId: circle.id})).members.find(m => m.id === helper.id);
  assert.equal(member.status, 'active');
  assert.equal(member.role, 'admin');
  const delegations = await f.repo.atomic(tx => tx.find('delegations', {circleId: circle.id}));
  assert.equal(delegations.filter(item => !item.revokedAt).length, 81);
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

test('认领申请待审核时不能新建本人卡或同时申请另一张卡', async () => {
  const f = fixture();
  const circle = await f.create();
  const first = (await f.ok('owner','person.create',{circleId:circle.id,name:'候选一'})).person;
  const second = (await f.ok('owner','person.create',{circleId:circle.id,name:'候选二'})).person;
  await f.join('owner','member',circle.id);
  const request = (await f.ok('member','person.claim',{circleId:circle.id,personId:first.id})).claimRequest;
  assert.equal((await f.ok('member','person.claim',{circleId:circle.id,personId:first.id})).claimRequest.id,request.id);
  await f.denied('member','person.claim',{circleId:circle.id,personId:second.id},'CLAIM_PENDING');
  await f.denied('member','person.create',{circleId:circle.id,name:'重复本人',claimSelf:true},'CLAIM_PENDING');
  assert.equal((await f.ok('owner','person.list',{circleId:circle.id})).persons.length,2);
  await f.ok('owner','person.claimReject',{circleId:circle.id,claimRequestId:request.id});
  const own = (await f.ok('member','person.create',{circleId:circle.id,name:'确实没有我的卡',claimSelf:true})).person;
  assert.equal(own.isSelf,true);
  await f.denied('member','person.claim',{circleId:circle.id,personId:second.id},'ALREADY_CLAIMED');
});

test('认领申请与新建本人卡并发时只允许一条路径成功', async () => {
  const f = fixture();
  const circle = await f.create();
  const card = (await f.ok('owner','person.create',{circleId:circle.id,name:'已有卡'})).person;
  await f.join('owner','member',circle.id);
  const [claimResult, createResult] = await Promise.all([
    f.call('member','person.claim',{circleId:circle.id,personId:card.id}),
    f.call('member','person.create',{circleId:circle.id,name:'新本人卡',claimSelf:true})
  ]);
  assert.equal([claimResult,createResult].filter(result=>result.ok).length,1);
  assert.equal((await f.ok('owner','person.list',{circleId:circle.id})).persons.length,createResult.ok ? 2 : 1);
  assert.equal((await f.ok('owner','person.claimList',{circleId:circle.id})).claimRequests.length,claimResult.ok ? 1 : 0);
});

test('入圈申请不能预认领，旧待审记录的预认领字段也不会被审批绑定', async () => {
  const f = fixture();
  const circle = await f.create();
  const card = (await f.ok('owner','person.create',{circleId:circle.id,name:'张三'})).person;
  const invite = (await f.ok('owner','invite.create',{circleId:circle.id})).invite;
  const request = {token:invite.token,name:'张三',claimPersonId:card.id};
  await f.denied('applicant','invite.apply',request,'INVALID_INPUT');
  const application = (await f.ok('applicant','invite.apply',{token:invite.token,name:'张三'})).application;
  await f.denied('applicant','invite.apply',request,'INVALID_INPUT');
  await f.repo.atomic(async tx => {
    const stored = await tx.get('applications',application.id);
    stored.claimPersonId = card.id; // Migration case: an older client submitted this field.
    await tx.put('applications',stored);
  });
  const pending = (await f.ok('owner','join.list',{circleId:circle.id})).applications[0];
  assert.equal(pending.claimPersonId,undefined);
  await f.ok('owner','join.approve',{circleId:circle.id,applicationId:application.id});
  const member = (await f.ok('owner','member.list',{circleId:circle.id})).members.find(item=>!item.isSelf);
  assert.equal(member.personId,undefined);
  assert.equal((await f.ok('owner','person.get',{circleId:circle.id,personId:card.id})).person.isClaimed,false);
  const claim = (await f.ok('applicant','person.claim',{circleId:circle.id,personId:card.id})).claimRequest;
  assert.equal(claim.status,'pending');
  await f.ok('owner','person.claimApprove',{circleId:circle.id,claimRequestId:claim.id});
  assert.equal((await f.ok('owner','member.list',{circleId:circle.id})).members.find(item=>!item.isSelf).personId,card.id);
});

test('管理员可纠正误认领并清除私人资料，申请人只看自己的进度', async () => {
  const f = fixture();
  const circle = await f.create();
  const card = (await f.ok('owner', 'person.create', {circleId:circle.id, name:'同名卡'})).person;
  const token = (await f.ok('owner', 'invite.create', {circleId:circle.id})).invite.token;
  const application = (await f.ok('member', 'invite.apply', {token, name:'小李'})).application;
  const mine = (await f.ok('member', 'join.mine')).applications;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, application.id);
  await f.ok('owner', 'join.approve', {circleId:circle.id, applicationId:application.id});
  assert.equal((await f.ok('owner','member.list',{circleId:circle.id})).members.find(m=>!m.isSelf).personId,undefined);
  const request = (await f.ok('member','person.claim',{circleId:circle.id,personId:card.id})).claimRequest;
  await f.ok('owner','person.claimApprove',{circleId:circle.id,claimRequestId:request.id});
  const oldMemberId = (await f.ok('owner','member.list',{circleId:circle.id})).members.find(m=>!m.isSelf).id;
  await f.ok('member', 'person.update', {circleId:circle.id, personId:card.id, patch:{phone:'12345',wechatId:'secret_wechat'}, visibility:{phone:'circle'}});
  await f.ok('owner', 'person.unclaim', {circleId:circle.id, personId:card.id, reasonCode:'wrong_person'});
  const view = (await f.ok('member', 'person.get', {circleId:circle.id, personId:card.id})).person;
  assert.equal(view.isClaimed, false);
  assert.equal(view.phone, undefined);
  const audit = (await f.ok('owner','audit.list',{circleId:circle.id})).events.find(event=>event.type==='person.unclaim');
  assert.equal(audit.details.oldMemberId,oldMemberId);
  assert.deepEqual(audit.details.clearedFields.sort(),['phone','wechatId'].sort());
  assert.equal(audit.details.reasonCode,'wrong_person');
  assert.equal(JSON.stringify(audit).includes('12345'),false);
  assert.equal(JSON.stringify(audit).includes('secret_wechat'),false);
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

test('大圈成员与最近审计列表不逐条执行事务文档读取', async () => {
  const f = fixture();
  const circle = await f.create();
  await f.repo.atomic(async tx => {
    for (let i = 0; i < 120; i++) {
      await tx.put('members', {id: `bulk-member-${i}`, circleId: circle.id, userId: `u${i}`, name: `成员${i}`, role: 'member', status: 'active', joinedAt: i});
      await tx.put('audit', {id: `bulk-audit-${i}`, circleId: circle.id, actorId: `u${i}`, type: 'test', targetId: `u${i}`, at: i});
    }
  });
  let documentReads = 0;
  const capped = {atomic: work => f.repo.atomic(tx => work({
    ...tx,
    get: async (...args) => {
      documentReads++;
      if (documentReads > 100) throw new Error('CloudBase transaction document read limit');
      return tx.get(...args);
    }
  }))};
  const api = new ApiService(capped);
  const members = await api.invoke({action: 'member.list', payload: {circleId: circle.id}}, 'owner');
  assert.equal(members.ok, true);
  assert.equal(members.data.members.length, 121);
  assert.ok(documentReads < 10);
  documentReads = 0;
  const audit = await api.invoke({action: 'audit.list', payload: {circleId: circle.id}}, 'owner');
  assert.equal(audit.ok, true);
  assert.equal(audit.data.events.length, 100);
  assert.ok(documentReads < 10);
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

test('关系预览和保存拦截亲子环、互斥关系及辈分矛盾', async () => {
  const f = fixture();
  const circle = await f.create();
  const names = ['祖辈', '父辈', '本人', '同辈'];
  const [grand, parent, child, peer] = await Promise.all(names.map(async name =>
    (await f.ok('owner', 'person.create', {circleId: circle.id, name})).person));
  const a = (await f.ok('owner', 'relation.create', {circleId:circle.id, from:grand.id, to:parent.id, type:'parent'})).relation;
  const b = (await f.ok('owner', 'relation.create', {circleId:circle.id, from:parent.id, to:child.id, type:'parent'})).relation;
  const base = {circleId: circle.id};
  await f.denied('owner', 'relation.create', {...base, from:child.id, to:grand.id, type:'parent'}, 'RELATION_CYCLE');
  await f.denied('owner', 'relation.create', {...base, from:parent.id, to:child.id, type:'sibling'}, 'RELATION_CONFLICT');
  await f.denied('owner', 'relation.create', {...base, from:grand.id, to:child.id, type:'sibling'}, 'GENERATION_CONFLICT');
  await f.denied('owner', 'relation.preview', {...base, relationChange:{relation:{from:grand.id,to:child.id,type:'spouse'}}}, 'GENERATION_CONFLICT');
  const preview = await f.ok('owner', 'relation.preview', {...base, relationChange:{removeRelationId:b.id,relation:{from:parent.id,to:peer.id,type:'parent'}}});
  assert.equal(preview.before.id, b.id);
  assert.equal(preview.after.from, parent.id);
  assert.ok(preview.impact.affectedPersonIds.includes(grand.id));
  assert.ok(preview.impact.affectedPersonIds.includes(child.id));
  assert.ok(preview.impact.affectedPersonIds.includes(peer.id));
  assert.deepEqual((await f.ok('owner','relation.list',base)).relations.map(relation => relation.id).sort(), [a.id,b.id].sort());
});

test('管理员直接替换关系会一次性更新边、计数和审计摘要', async () => {
  const f = fixture();
  const circle = await f.create();
  const parent = (await f.ok('owner','person.create',{circleId:circle.id,name:'爸爸'})).person;
  const child = (await f.ok('owner','person.create',{circleId:circle.id,name:'孩子'})).person;
  const old = (await f.ok('owner','relation.create',{circleId:circle.id,from:child.id,to:parent.id,type:'parent'})).relation;
  const result = await f.ok('owner','relation.replace',{circleId:circle.id,relationId:old.id,relation:{from:parent.id,to:child.id,type:'parent'}});
  assert.equal(result.impact.removedRelationIds[0], old.id);
  assert.equal(result.relation.from, parent.id);
  const relations = (await f.ok('owner','relation.list',{circleId:circle.id})).relations;
  assert.equal(relations.length, 1);
  assert.equal(relations[0].to, child.id);
  const audit = (await f.ok('owner','audit.list',{circleId:circle.id})).events.find(event => event.type === 'relation.replace');
  assert.equal(audit.actorName, '圈主');
  assert.equal(audit.details.removed.from, child.id);
  assert.equal(audit.details.created.from, parent.id);
  assert.equal(audit.actorId, undefined);
  assert.equal(audit.details.removed.createdBy, undefined);
  assert.equal(audit.details.created.createdBy, undefined);
  assert.equal(JSON.stringify(audit).includes('"createdBy"'), false);
  await f.denied('owner','person.delete',{circleId:circle.id,personId:parent.id},'RELATION_CONNECTED');
  await f.ok('owner','relation.delete',{circleId:circle.id,relationId:relations[0].id});
  await f.ok('owner','person.delete',{circleId:circle.id,personId:parent.id});
});

test('关系建议采纳时实际改图，失败仍待处理，旧文字建议不能假采纳', async () => {
  const f = fixture();
  const circle = await f.create();
  await f.join('owner','member',circle.id);
  const a = (await f.ok('owner','person.create',{circleId:circle.id,name:'甲'})).person;
  const b = (await f.ok('owner','person.create',{circleId:circle.id,name:'乙'})).person;
  const wrong = (await f.ok('owner','relation.create',{circleId:circle.id,from:b.id,to:a.id,type:'parent'})).relation;
  const change = {removeRelationId:wrong.id,relation:{from:a.id,to:b.id,type:'parent'}};
  const suggestion = (await f.ok('member','suggestion.create',{circleId:circle.id,type:'relation',message:'亲子方向填反了',relationChange:change})).suggestion;
  assert.equal(suggestion.relationChange.removeRelationId, wrong.id);
  assert.equal(suggestion.relationChange.relation.from, a.id);
  assert.equal(suggestion.relationChange.relation.to, b.id);
  await f.denied('member','suggestion.resolve',{circleId:circle.id,suggestionId:suggestion.id,status:'accepted'},'FORBIDDEN');
  const resolved = await f.ok('owner','suggestion.resolve',{circleId:circle.id,suggestionId:suggestion.id,status:'accepted'});
  assert.equal(resolved.suggestion.status,'accepted');
  assert.equal(resolved.impact.removedRelationIds[0],wrong.id);
  assert.equal((await f.ok('owner','relation.list',{circleId:circle.id})).relations[0].from,a.id);
  const audit = (await f.ok('owner','audit.list',{circleId:circle.id})).events.find(event => event.type === 'suggestion.resolve');
  assert.equal(audit.details.removed.from,b.id);
  assert.equal(audit.details.created.from,a.id);
  assert.equal(audit.details.removed.createdBy,undefined);
  assert.equal(audit.details.created.createdBy,undefined);
  await f.denied('owner','suggestion.resolve',{circleId:circle.id,suggestionId:suggestion.id,status:'accepted'},'ALREADY_REVIEWED');

  // Existing installations can have text-only relation suggestions. They must
  // remain pending on acceptance, while rejection remains possible.
  await f.repo.atomic(tx => tx.put('suggestions',{id:'legacy',circleId:circle.id,createdBy:'member',type:'relation',message:'以前的文字建议',status:'pending',createdAt:1}));
  await f.denied('owner','suggestion.resolve',{circleId:circle.id,suggestionId:'legacy',status:'accepted'},'CHANGE_REQUIRED');
  assert.equal((await f.ok('owner','suggestion.list',{circleId:circle.id})).suggestions.find(item=>item.id==='legacy').status,'pending');
  await f.ok('owner','suggestion.resolve',{circleId:circle.id,suggestionId:'legacy',status:'rejected'});
  const personNote = (await f.ok('member','suggestion.create',{circleId:circle.id,type:'person',message:'姓名有误'})).suggestion;
  await f.denied('owner','suggestion.resolve',{circleId:circle.id,suggestionId:personNote.id,status:'accepted'},'CHANGE_REQUIRED');
});

test('关系建议过期或与新边冲突时不会假采纳', async () => {
  const f = fixture();
  const circle = await f.create();
  await f.join('owner','member',circle.id);
  const a = (await f.ok('owner','person.create',{circleId:circle.id,name:'甲'})).person;
  const b = (await f.ok('owner','person.create',{circleId:circle.id,name:'乙'})).person;
  const old = (await f.ok('owner','relation.create',{circleId:circle.id,from:a.id,to:b.id,type:'sibling'})).relation;
  const suggestion = (await f.ok('member','suggestion.create',{circleId:circle.id,type:'relation',message:'改成长幼',relationChange:{removeRelationId:old.id,relation:{from:a.id,to:b.id,type:'sibling',olderId:a.id}}})).suggestion;
  await f.ok('owner','relation.replace',{circleId:circle.id,relationId:old.id,relation:{from:a.id,to:b.id,type:'sibling',olderId:b.id}});
  await f.denied('owner','suggestion.resolve',{circleId:circle.id,suggestionId:suggestion.id,status:'accepted'},'STALE_RELATION');
  assert.equal((await f.ok('owner','suggestion.list',{circleId:circle.id})).suggestions[0].status,'pending');
  assert.equal((await f.ok('owner','relation.list',{circleId:circle.id})).relations[0].olderId,b.id);
  await f.ok('owner','suggestion.resolve',{circleId:circle.id,suggestionId:suggestion.id,status:'rejected'});

  const third = (await f.ok('owner','person.create',{circleId:circle.id,name:'丙'})).person;
  const proposal = (await f.ok('member','suggestion.create',{circleId:circle.id,type:'relation',message:'甲是丙家长',relationChange:{relation:{from:a.id,to:third.id,type:'parent'}}})).suggestion;
  await f.ok('owner','relation.create',{circleId:circle.id,from:third.id,to:a.id,type:'parent'});
  await f.denied('owner','suggestion.resolve',{circleId:circle.id,suggestionId:proposal.id,status:'accepted'},'RELATION_CONFLICT');
  assert.equal((await f.ok('owner','suggestion.list',{circleId:circle.id})).suggestions.find(item => item.id===proposal.id).status,'pending');
});

test('自己的入圈和认领申请状态可持续查询，过期邀请不再显示审核中', async () => {
  const f = fixture();
  const circle = await f.create();
  const card = (await f.ok('owner','person.create',{circleId:circle.id,name:'待认领'})).person;
  const invite = (await f.ok('owner','invite.create',{circleId:circle.id})).invite;
  const pending = (await f.ok('member','invite.apply',{token:invite.token,name:'成员'})).application;
  let mine = (await f.ok('member','join.mine')).applications;
  assert.equal(mine.find(item=>item.id===pending.id).circleName,circle.name);
  assert.equal(mine.find(item=>item.id===pending.id).inviteStatus,'active');
  f.advance(72*60*60*1000);
  mine = (await f.ok('member','join.mine')).applications;
  assert.equal(mine.find(item=>item.id===pending.id).status,'expired');
  const fresh = (await f.ok('owner','invite.create',{circleId:circle.id})).invite;
  const application = (await f.ok('member','invite.apply',{token:fresh.token,name:'成员'})).application;
  await f.ok('owner','join.approve',{circleId:circle.id,applicationId:application.id});
  const claim = (await f.ok('member','person.claim',{circleId:circle.id,personId:card.id})).claimRequest;
  let requests = (await f.ok('member','person.claimMine',{circleId:circle.id})).claimRequests;
  assert.equal(requests[0].personName,'待认领');
  assert.equal(requests[0].status,'pending');
  await f.ok('owner','person.claimApprove',{circleId:circle.id,claimRequestId:claim.id});
  requests = (await f.ok('member','person.claimMine',{circleId:circle.id})).claimRequests;
  assert.equal(requests[0].status,'approved');
});

test('入圈申请列表限制关联读取，旧申请可用本人 ID 精确查询', async () => {
  const f = fixture();
  const circle = await f.create();
  const ids = [];
  for (let i = 0; i < 22; i++) {
    const invite = (await f.ok('owner', 'invite.create', {circleId: circle.id})).invite;
    const application = (await f.ok('applicant', 'invite.apply', {token: invite.token, name: `申请人${i}`})).application;
    ids.push(application.id);
    f.advance(1);
  }
  const list = await f.ok('applicant', 'join.mine');
  assert.equal(list.applications.length, 20);
  assert.equal(list.hasMore, true);
  assert.equal(list.applications.some(item => item.id === ids[0]), false);
  const old = await f.ok('applicant', 'join.mine', {applicationId: ids[0]});
  assert.equal(old.applications.length, 1);
  assert.equal(old.applications[0].id, ids[0]);
  await f.denied('other', 'join.mine', {applicationId: ids[0]}, 'NOT_FOUND');
});
