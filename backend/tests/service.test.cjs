const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ApiService } = require('../dist/service.js');
const { MemoryRepository } = require('../dist/memory-repository.js');
const { handlePhotoUpload, stripJpegMetadata } = require('../../cloudfunctions/api/photo-upload.js');
const { handlePhoneVerify } = require('../../cloudfunctions/api/phone-verify.js');
const TEST_JPEG = fs.readFileSync(path.join(__dirname, 'fixtures', 'tiny.jpg'));

function jpegSegment(marker, payload) {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
}

async function stagePhoto(api, actor, circleId, personId, visibility, bucket = 'env.bucket') {
  const reserved = await api.reservePhotoUpload({circleId, personId}, actor);
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  const {cloudPath} = reserved.data;
  const fileID = `cloud://${bucket}/${cloudPath}`;
  const bound = await api.bindUploadedPhoto({circleId, personId, fileID, ...(visibility ? {visibility} : {})}, actor);
  assert.equal(bound.ok, true, JSON.stringify(bound));
  return {cloudPath, fileID};
}

function fixture() {
  let clock = 1_800_000_000_000;
  let legacyCardNumber = 0;
  const repo = new MemoryRepository();
  const api = new ApiService(repo, () => clock);
  const testProfile = {country: '中国', province: '浙江', city: '杭州', latitude: 30.3, longitude: 120.2,
    birthday: {calendar: 'solar', month: 5, day: 16}};
  const call = async (user, action, payload = {}) => {
    const requestPayload = action === 'invite.apply' && payload.profile === undefined ? {...payload, profile: testProfile}
      : action === 'person.create' ? {...testProfile, ...payload} : payload;
    // Older tests create several unrelated cards as setup. New user flows
    // require a relationship for every additional family card, so give these
    // setup cards a valid sibling edge unless a test specifies its own edge.
    if (action === 'person.create' && requestPayload.initialRelation === undefined &&
      (await repo.atomic(tx => tx.get('circles', requestPayload.circleId)))?.type === 'family') {
      const first = (await repo.atomic(tx => tx.find('persons', {circleId: requestPayload.circleId})))[0];
      if (first) requestPayload.initialRelation = {anchorPersonId: first.id, kind: 'sibling'};
    }
    if (action === 'join.approve' && requestPayload.targetPersonId === undefined && requestPayload.initialRelation === undefined &&
      (await repo.atomic(tx => tx.get('circles', requestPayload.circleId)))?.type === 'family') {
      const first = (await repo.atomic(tx => tx.find('persons', {circleId: requestPayload.circleId})))[0];
      if (first) requestPayload.initialRelation = {anchorPersonId: first.id, kind: 'sibling'};
    }
    if (action === 'join.approve' && requestPayload.targetPersonId && requestPayload.targetPersonUpdatedAt === undefined) {
      const target = await repo.atomic(tx => tx.get('persons', requestPayload.targetPersonId));
      if (target) requestPayload.targetPersonUpdatedAt = target.updatedAt;
    }
    if (action === 'invite.apply') {
      const staged = await api.invoke({action:'account.profile.update', payload:{patch:{
        name:requestPayload.name, ...(requestPayload.profile ?? {})
      }}}, user);
      if (!staged.ok) return staged;
    }
    return api.invoke({action, payload:requestPayload}, user);
  };
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
    await ok(owner, 'join.approve', {circleId, applicationId: application.id, ...(claimPersonId ? {targetPersonId: claimPersonId} : {})});
    // Most older tests exercise migration of members who joined before the
    // complete-profile workflow. Recreate that historical unbound state here.
    if (!claimPersonId) await legacyUnbind(user, circleId);
    return (await ok(owner, 'member.list', {circleId})).members.find(m => !m.isSelf && (claimPersonId ? m.personId === claimPersonId : m.name === user));
  };
  const legacyUnbind = async (user, circleId) => {
    const members = await repo.atomic(tx => tx.find('members', {circleId, userId: user, status: 'active'}));
    const member = members[0];
    if (!member?.personId) return;
    await repo.atomic(async tx => {
      const row = await tx.get('members', member.id);
      await tx.delete('persons', row.personId);
      row.personId = undefined;
      await tx.put('members', row);
    });
  };
  const legacyCard = async (circleId, name) => {
    const person = {id: `legacy-card-${++legacyCardNumber}`, circleId, name, visibility: {}, relationCount: 0,
      createdAt: clock, updatedAt: clock};
    await repo.atomic(tx => tx.put('persons', person));
    return person;
  };
  const legacyMember = async (circleId, userId) => {
    const member = {id: `${circleId}_${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 40)}`,
      circleId, userId, name: userId, role: 'member', status: 'active', joinedAt: clock};
    await repo.atomic(tx => tx.put('members', member));
    return member;
  };
  return {api, repo, call, ok, denied, create, join, legacyUnbind, legacyCard, legacyMember, testProfile, advance: ms => {clock += ms;}};
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

test('首页与详情都按人物资料数量展示，账号成员数另行保留', async () => {
  const f = fixture();
  const circle = await f.create();
  assert.equal(circle.personCount, 0);
  await f.ok('owner', 'person.create', {circleId: circle.id, name: '妈妈'});
  await f.ok('owner', 'person.create', {circleId: circle.id, name: '舅舅'});
  const listed = (await f.ok('owner', 'circle.list')).circles[0];
  const detail = (await f.ok('owner', 'circle.detail', {circleId: circle.id})).circle;
  for (const view of [listed, detail]) {
    assert.equal(view.personCount, 2);
    assert.equal(view.memberCount, 1);
  }
});

test('新增家人时可连到尚未登录的已有亲友，关系与人物在同一事务保存', async () => {
  const f = fixture();
  const circle = await f.create();
  const father = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '爸爸'})).person;
  const unclePayload = {circleId: circle.id, name: '伯父', requestId: 'uncle-once-00001',
    initialRelation: {anchorPersonId: father.id, kind: 'sibling', older: 'new'}};
  const uncle = (await f.ok('owner', 'person.create', unclePayload)).person;
  const replay = (await f.ok('owner', 'person.create', unclePayload)).person;
  assert.equal(replay.id, uncle.id);
  const child = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '孩子',
    initialRelation: {anchorPersonId: father.id, kind: 'newChild'}})).person;
  const relations = (await f.ok('owner', 'relation.list', {circleId: circle.id})).relations;
  assert.equal(relations.length, 2);
  assert.ok(relations.some(row => row.type === 'sibling' && row.olderId === uncle.id &&
    [row.from, row.to].includes(father.id) && [row.from, row.to].includes(uncle.id)));
  assert.ok(relations.some(row => row.type === 'parent' && row.from === father.id && row.to === child.id));
  await f.denied('owner', 'person.create', {circleId: circle.id, name: '错误资料',
    initialRelation: {anchorPersonId: 'missing', kind: 'spouse'}}, 'NOT_FOUND');
  const disconnected = await f.api.invoke({action: 'person.create', payload: {...f.testProfile, circleId: circle.id, name: '未填写关系'}}, 'owner');
  assert.equal(disconnected.error.code, 'RELATION_REQUIRED');
  assert.equal((await f.ok('owner', 'person.list', {circleId: circle.id})).persons.length, 3);
});

test('批准加入时新建家人可原子建立首条关系，失败不会消耗邀请', async () => {
  const f = fixture();
  const circle = await f.create();
  const parent = (await f.ok('owner','person.create',{circleId:circle.id,name:'父亲'})).person;
  const invite = (await f.ok('owner','invite.create',{circleId:circle.id})).invite;
  const application = (await f.ok('child','invite.apply',{token:invite.token,name:'孩子'})).application;
  await f.denied('owner','join.approve',{circleId:circle.id,applicationId:application.id,
    initialRelation:{anchorPersonId:'missing',kind:'newChild'}},'NOT_FOUND');
  assert.equal((await f.ok('owner','person.list',{circleId:circle.id})).persons.length,1);
  assert.equal((await f.ok('owner','relation.list',{circleId:circle.id})).relations.length,0);
  assert.equal((await f.ok('owner','invite.list',{circleId:circle.id})).invites[0].status,'active');
  assert.equal((await f.ok('owner','join.list',{circleId:circle.id})).applications[0].status,'pending');
  await f.ok('owner','join.approve',{circleId:circle.id,applicationId:application.id,
    initialRelation:{anchorPersonId:parent.id,kind:'newChild'}});
  const member = (await f.ok('owner','member.list',{circleId:circle.id})).members.find(row=>!row.isSelf);
  const relations = (await f.ok('owner','relation.list',{circleId:circle.id})).relations;
  assert.equal(relations.length,1);
  assert.equal(relations[0].from,parent.id);
  assert.equal(relations[0].to,member.personId);
  assert.equal((await f.repo.atomic(tx=>tx.get('persons',member.personId))).relationCount,1);
});

test('批准时关联已有家人保留原关系，不可同时指定新关系；同窗录不可建亲属边', async () => {
  const f = fixture();
  const family = await f.create();
  const parent = (await f.ok('owner','person.create',{circleId:family.id,name:'父亲'})).person;
  const existing = (await f.ok('owner','person.create',{circleId:family.id,name:'已记录的孩子',
    initialRelation:{anchorPersonId:parent.id,kind:'newChild'}})).person;
  const invite = (await f.ok('owner','invite.create',{circleId:family.id})).invite;
  const application = (await f.ok('child','invite.apply',{token:invite.token,name:'孩子'})).application;
  await f.denied('owner','join.approve',{circleId:family.id,applicationId:application.id,targetPersonId:existing.id,
    initialRelation:{anchorPersonId:parent.id,kind:'newChild'}},'INVALID_INPUT');
  await f.ok('owner','join.approve',{circleId:family.id,applicationId:application.id,targetPersonId:existing.id});
  const relations = (await f.ok('owner','relation.list',{circleId:family.id})).relations;
  assert.equal(relations.length,1);
  assert.equal(relations[0].from,parent.id);
  assert.equal(relations[0].to,existing.id);
  const classmates = await f.create('owner','classmate');
  const classInvite = (await f.ok('owner','invite.create',{circleId:classmates.id})).invite;
  const classApplication = (await f.ok('peer','invite.apply',{token:classInvite.token,name:'同学',note:'三班同学'})).application;
  await f.denied('owner','join.approve',{circleId:classmates.id,applicationId:classApplication.id,
    initialRelation:{anchorPersonId:parent.id,kind:'newChild'}},'WRONG_CIRCLE_TYPE');
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

test('创建圈子达到列表容量前就拒绝继续创建', async () => {
  const f = fixture();
  await f.repo.atomic(async tx => {
    for (let i = 0; i < 80; i++) await tx.put('members', {
      id: `joined-${i}`, circleId: `circle-${i}`, userId: 'owner',
      name: '成员', role: 'member', status: 'active', joinedAt: i
    });
  });
  await f.denied('owner', 'circle.create', {type: 'family', name: '再建一个'}, 'DATA_LIMIT');
});

test('创建圈子请求重试和并发只生成一个圈，同 key 改参数拒绝', async () => {
  const f = fixture();
  const payload = {name: '我的家', type: 'family', mode: 'shared', requestId: 'circle_create_retry_0001'};
  const [first, duplicate] = await Promise.all([f.call('owner', 'circle.create', payload), f.call('owner', 'circle.create', payload)]);
  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(first.data.circle.id, duplicate.data.circle.id);
  assert.equal((await f.ok('owner', 'circle.list')).circles.length, 1);
  assert.equal(first.data.circle.createPayloadHash, undefined);
  assert.equal(first.data.circle.createdBy, undefined);
  await f.denied('owner', 'circle.create', {...payload, name: '另一个圈'}, 'IDEMPOTENCY_CONFLICT');
  const retry = await f.ok('owner', 'circle.create', payload);
  assert.equal(retry.circle.id, first.data.circle.id);
  const joined = await f.join('owner', 'newOwner', retry.circle.id);
  const transfer = (await f.ok('owner', 'circle.transferOwner', {circleId: retry.circle.id, memberId: joined.id})).ownerTransfer;
  await f.ok('newOwner', 'circle.acceptOwnerTransfer', {circleId: retry.circle.id, transferId: transfer.id});
  const afterTransfer = await f.ok('owner', 'circle.create', payload);
  assert.equal(afterTransfer.circle.id, retry.circle.id);
  assert.equal(afterTransfer.circle.role, 'admin');
  await f.ok('owner', 'member.leave', {circleId: retry.circle.id});
  await f.denied('owner', 'circle.create', payload, 'FORBIDDEN');
  const audit = (await f.ok('newOwner', 'audit.list', {circleId: retry.circle.id})).events;
  assert.equal(audit.filter(item => item.type === 'circle.create').length, 1);
  await f.denied('owner', 'circle.create', {...payload, requestId: '短'}, 'INVALID_INPUT');
});

test('本人和管理员建人物卡重试只保留一张，改参数冲突', async () => {
  const f = fixture();
  const circle = await f.create();
  const placeholder = {circleId: circle.id, name: '外婆', requestId: 'admin_person_retry_0001'};
  const [first, duplicate] = await Promise.all([f.call('owner', 'person.create', placeholder), f.call('owner', 'person.create', placeholder)]);
  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(first.data.person.id, duplicate.data.person.id);
  assert.equal(first.data.person.createPayloadHash, undefined);
  await f.denied('owner', 'person.create', {...placeholder, name: '外公'}, 'IDEMPOTENCY_CONFLICT');
  await f.join('owner', 'member', circle.id);
  const selfPayload = {circleId: circle.id, name: '我', claimSelf: true, requestId: 'self_person_retry_0001'};
  const [selfFirst, selfRetry] = await Promise.all([f.call('member', 'person.create', selfPayload), f.call('member', 'person.create', selfPayload)]);
  assert.equal(selfFirst.ok, true);
  assert.equal(selfRetry.ok, true);
  assert.equal(selfFirst.data.person.id, selfRetry.data.person.id);
  assert.equal((await f.ok('owner', 'member.list', {circleId: circle.id})).members.find(m => m.personId === selfFirst.data.person.id).personId, selfFirst.data.person.id);
  await f.denied('member', 'person.create', {...selfPayload, name: '别人'}, 'IDEMPOTENCY_CONFLICT');
  await f.ok('owner', 'person.unclaim', {circleId: circle.id, personId: selfFirst.data.person.id});
  await f.denied('member', 'person.create', selfPayload, 'IDEMPOTENCY_STATE_CHANGED');
  const persons = (await f.ok('owner', 'person.list', {circleId: circle.id})).persons;
  assert.equal(persons.length, 2);
});

test('管理员和成员新建人物卡前必须填完整城市与生日，旧空卡仍可补录', async () => {
  const f = fixture();
  const circle = await f.create();
  const rawCreate = (user, payload) => f.api.invoke({action: 'person.create', payload: {circleId: circle.id, ...payload}}, user);
  for (const payload of [
    {name: '只有姓名'},
    {name: '缺少生日', country: '中国', city: '杭州'},
    {name: '缺少城市', country: '中国', birthday: {calendar: 'solar', month: 5, day: 16}}
  ]) assert.equal((await rawCreate('owner', payload)).error.code, 'PROFILE_INCOMPLETE');
  assert.equal((await rawCreate('owner', {name:'日期错误', country:'中国', city:'杭州', birthday:{calendar:'solar',month:2,day:30}})).error.code, 'INVALID_INPUT');
  assert.equal((await f.ok('owner','person.list',{circleId:circle.id})).persons.length, 0);
  await f.join('owner', 'member', circle.id);
  assert.equal((await rawCreate('member', {name:'本人',claimSelf:true})).error.code, 'PROFILE_INCOMPLETE');
  const self = await rawCreate('member', {name:'本人',claimSelf:true,country:'中国',city:'杭州',birthday:{calendar:'lunar',month:8,day:15}});
  assert.equal(self.ok, true, JSON.stringify(self));
  assert.equal(self.data.person.profileComplete, true);
  const oldCard = await f.legacyCard(circle.id, '旧空卡');
  assert.equal((await f.ok('owner','person.get',{circleId:circle.id,personId:oldCard.id})).person.profileComplete, false);
  await f.ok('owner','person.update',{circleId:circle.id,personId:oldCard.id,
    patch:{country:'中国',city:'北京',birthday:{calendar:'solar',month:1,day:1}}});
  assert.equal((await f.ok('owner','person.get',{circleId:circle.id,personId:oldCard.id})).person.profileComplete, true);
});

test('人物姓名不能被空字符串或 null 清空', async () => {
  const f = fixture();
  const circle = await f.create();
  const person = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '张三', claimSelf: true})).person;
  await f.denied('owner', 'person.update', {circleId: circle.id, personId: person.id, patch: {name: ''}}, 'INVALID_INPUT');
  await f.denied('owner', 'person.update', {circleId: circle.id, personId: person.id, patch: {name: null}}, 'INVALID_INPUT');
  assert.equal((await f.ok('owner', 'person.get', {circleId: circle.id, personId: person.id})).person.name, '张三');
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

test('同一邀请被拒后不可反复申请，新邀请可再次提交', async () => {
  const f = fixture();
  const circle = await f.create();
  const first = (await f.ok('owner', 'invite.create', {circleId: circle.id})).invite;
  const application = (await f.ok('member', 'invite.apply', {token: first.token, name: '成员'})).application;
  await f.ok('owner', 'join.reject', {circleId: circle.id, applicationId: application.id});
  const retry = await f.call('member', 'invite.apply', {token: first.token, name: '换个名字'});
  assert.equal(retry.error.code, 'APPLICATION_REJECTED');
  assert.match(retry.error.message, /新邀请/);
  assert.equal((await f.ok('owner', 'join.list', {circleId: circle.id})).applications.length, 0);
  const second = (await f.ok('owner', 'invite.create', {circleId: circle.id})).invite;
  const next = (await f.ok('member', 'invite.apply', {token: second.token, name: '成员'})).application;
  assert.notEqual(next.id, application.id);
  assert.equal(next.status, 'pending');
});

test('批准同一用户入圈后，同圈其他待审邀请自动失效', async () => {
  const f = fixture();
  const circle = await f.create();
  const first = (await f.ok('owner', 'invite.create', {circleId: circle.id})).invite;
  const second = (await f.ok('owner', 'invite.create', {circleId: circle.id})).invite;
  const firstApplication = (await f.ok('member', 'invite.apply', {token: first.token, name: '成员'})).application;
  const secondApplication = (await f.ok('member', 'invite.apply', {token: second.token, name: '成员'})).application;
  await f.ok('owner', 'join.approve', {circleId: circle.id, applicationId: firstApplication.id});
  const pending = (await f.ok('owner', 'join.list', {circleId: circle.id})).applications;
  assert.equal(pending.some(item => item.id === secondApplication.id), false);
  const mine = (await f.ok('member', 'join.mine', {applicationId: secondApplication.id})).applications[0];
  assert.equal(mine.status, 'expired');
  await f.denied('owner', 'join.approve', {circleId: circle.id, applicationId: secondApplication.id}, 'ALREADY_REVIEWED');
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

test('圈主移交须目标确认，原圈主可取消，过期和旧请求不能误生效', async () => {
  const f = fixture();
  const circle = await f.create();
  await f.join('owner', 'member', circle.id);
  await f.join('owner', 'observer', circle.id);
  const target = (await f.ok('owner', 'member.list', {circleId: circle.id})).members.find(m => m.name === 'member');
  assert.equal(target.name, 'member');
  await f.denied('member', 'audit.list', {circleId: circle.id}, 'FORBIDDEN');
  await f.denied('owner', 'member.leave', {circleId: circle.id}, 'OWNER_REQUIRED');
  const first = (await f.ok('owner', 'circle.transferOwner', {circleId: circle.id, memberId: target.id})).ownerTransfer;
  assert.equal(first.targetMemberId, target.id);
  assert.equal(first.targetName, 'member');
  assert.equal(first.isOwner, true);
  assert.equal(first.isTarget, false);
  assert.equal(first.expiresAt, 1_800_000_000_000 + 72 * 60 * 60 * 1000);
  assert.equal((await f.ok('owner', 'circle.detail', {circleId: circle.id})).role, 'owner');
  const targetDetail = await f.ok('member', 'circle.detail', {circleId: circle.id});
  assert.equal(targetDetail.ownerTransfer.id, first.id);
  assert.equal(targetDetail.ownerTransfer.isTarget, true);
  assert.equal(targetDetail.ownerTransfer.isOwner, false);
  assert.equal((await f.ok('observer', 'circle.detail', {circleId: circle.id})).ownerTransfer, null);
  assert.equal((await f.ok('observer', 'circle.list')).circles.find(item => item.id === circle.id).ownerTransfer, undefined);
  await f.denied('owner', 'circle.transferOwner', {circleId: circle.id, memberId: target.id}, 'TRANSFER_PENDING');
  await f.denied('owner', 'circle.acceptOwnerTransfer', {circleId: circle.id, transferId: first.id}, 'FORBIDDEN');
  await f.denied('observer', 'circle.acceptOwnerTransfer', {circleId: circle.id, transferId: first.id}, 'FORBIDDEN');
  await f.denied('observer', 'circle.cancelOwnerTransfer', {circleId: circle.id, transferId: first.id}, 'FORBIDDEN');
  await f.ok('member', 'circle.cancelOwnerTransfer', {circleId: circle.id, transferId: first.id});
  assert.equal((await f.ok('owner', 'circle.detail', {circleId: circle.id})).ownerTransfer, null);
  await f.denied('member', 'circle.acceptOwnerTransfer', {circleId: circle.id, transferId: first.id}, 'STALE_TRANSFER');

  const second = (await f.ok('owner', 'circle.transferOwner', {circleId: circle.id, memberId: target.id})).ownerTransfer;
  await f.ok('owner', 'circle.cancelOwnerTransfer', {circleId: circle.id, transferId: second.id});
  await f.denied('member', 'circle.acceptOwnerTransfer', {circleId: circle.id, transferId: second.id}, 'STALE_TRANSFER');

  const expiring = (await f.ok('owner', 'circle.transferOwner', {circleId: circle.id, memberId: target.id})).ownerTransfer;
  f.advance(72 * 60 * 60 * 1000);
  await f.denied('member', 'circle.acceptOwnerTransfer', {circleId: circle.id, transferId: expiring.id}, 'TRANSFER_EXPIRED');
  const fresh = (await f.ok('owner', 'circle.transferOwner', {circleId: circle.id, memberId: target.id})).ownerTransfer;
  assert.notEqual(fresh.id, expiring.id);
  await f.denied('member', 'circle.acceptOwnerTransfer', {circleId: circle.id, transferId: expiring.id}, 'STALE_TRANSFER');
  assert.equal((await f.ok('owner', 'circle.detail', {circleId: circle.id})).role, 'owner');
  await f.ok('member', 'circle.acceptOwnerTransfer', {circleId: circle.id, transferId: fresh.id});
  const newOwner = await f.ok('member', 'circle.detail', {circleId: circle.id});
  assert.equal(newOwner.role, 'owner');
  assert.equal(newOwner.ownerTransfer, null);
  await f.denied('owner', 'circle.cancelOwnerTransfer', {circleId: circle.id, transferId: fresh.id}, 'STALE_TRANSFER');
  await f.ok('owner', 'member.leave', {circleId: circle.id});
  await f.denied('owner', 'person.list', {circleId: circle.id}, 'FORBIDDEN');
  await f.denied('member', 'member.leave', {circleId: circle.id}, 'OWNER_REQUIRED');
  const audit = (await f.ok('member', 'audit.list', {circleId: circle.id})).events;
  assert.ok(audit.some(item => item.type === 'circle.transferRequested'));
  assert.ok(audit.some(item => item.type === 'circle.transferCancelled'));
  assert.ok(audit.some(item => item.type === 'circle.transferRejected'));
  assert.ok(audit.some(item => item.type === 'circle.transferAccepted'));
  assert.ok(audit.some(item => item.type === 'member.leave'));
});

test('接收成员离圈会撤销待接收移交，重新入圈不能接受旧请求', async () => {
  const f = fixture();
  const circle = await f.create();
  const target = await f.join('owner', 'member', circle.id);
  const transfer = (await f.ok('owner', 'circle.transferOwner', {circleId: circle.id, memberId: target.id})).ownerTransfer;
  await f.ok('owner', 'member.remove', {circleId: circle.id, memberId: target.id});
  assert.equal((await f.ok('owner', 'circle.detail', {circleId: circle.id})).ownerTransfer, null);
  await f.join('owner', 'member', circle.id);
  await f.denied('member', 'circle.acceptOwnerTransfer', {circleId: circle.id, transferId: transfer.id}, 'STALE_TRANSFER');
  assert.equal((await f.ok('member', 'circle.detail', {circleId: circle.id})).role, 'member');
});

test('圈内成员可读资料，圈外仍不可读且照片原始路径不泄露', async () => {
  const f = fixture();
  const circle = await f.create();
  const self = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '圈主', claimSelf: true})).person;
  await f.join('owner', 'member', circle.id);
  await stagePhoto(f.api, 'owner', circle.id, self.id);
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: self.id, patch: {phone: '13800000000', wechatId: 'wx_owner', city: '北京', country: '中国'}});
  let view = (await f.ok('member', 'person.get', {circleId: circle.id, personId: self.id})).person;
  assert.equal(view.phone, '13800000000');
  assert.equal(view.wechatId, 'wx_owner');
  assert.equal(view.city, '北京');
  assert.equal(view.country, '中国');
  assert.equal(view.hasPhoto, true);
  view = (await f.ok('member', 'person.get', {circleId: circle.id, personId: self.id})).person;
  assert.equal(view.photoFileId, undefined);
  assert.equal(view.visibility, undefined);
  await f.denied('outsider', 'person.get', {circleId: circle.id, personId: self.id}, 'FORBIDDEN');
});

test('任意城市代表点向圈内可见，并以约十公里精度保存', async () => {
  const f = fixture();
  const circle = await f.create();
  const me = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '我', claimSelf: true})).person;
  await f.join('owner', 'member', circle.id);
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: me.id, patch: {
    city: '奥斯陆', country: '挪威', latitude: 59.9139, longitude: 10.7522
  }});
  let view = (await f.ok('member', 'person.get', {circleId: circle.id, personId: me.id})).person;
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
  const me = await f.legacyCard(circle.id, '未补录城市的人物');
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
  const person = (await call('owner', 'person.create', {circleId:circle.id, name:'我', claimSelf:true,
    country:'中国', city:'杭州', birthday:{calendar:'solar',month:5,day:16}})).data.person;
  const staged = await stagePhoto(api, 'owner', circle.id, person.id, undefined, 'long-production-env-12345678901234567890.very-long-bucket-12345678901234567890');
  assert.match(staged.cloudPath, /^photos\/[0-9a-f]{40}\/[0-9a-f-]{36}\.jpg$/);
  assert.equal(staged.cloudPath.includes('/owner/'), false);
  const photoFileId = staged.fileID;
  assert.ok(photoFileId.length > 120);
  assert.equal((await call('owner', 'person.update', {circleId:circle.id, personId:person.id, patch:{photoFileId}})).error.code, 'FORBIDDEN');
  assert.equal((await call('owner', 'photo.uploadPath', {circleId:circle.id, personId:person.id})).error.code, 'UNKNOWN_ACTION');
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
  await call('helper', 'account.profile.update', {patch:{name:'代维护人',country:'中国',city:'北京',birthday:{calendar:'solar',month:5,day:16}}});
  const application = (await call('helper', 'invite.apply', {token:invite.token})).data.application;
  await call('owner', 'join.approve', {circleId:circle.id, applicationId:application.id,
    initialRelation:{anchorPersonId:person.id,kind:'sibling'}});
  const helper = (await call('owner', 'member.list', {circleId:circle.id})).data.members.find(m => m.name === '代维护人');
  assert.equal((await call('helper', 'photo.url', {circleId:circle.id, personId:person.id})).ok, true);
  const publicView = (await call('helper', 'person.get', {circleId:circle.id, personId:person.id})).data.person;
  assert.equal(publicView.hasPhoto, true);
  assert.equal(publicView.photoFileId, undefined);
  // Legacy per-field flags cannot hide a photo from an active circle member.
  await call('owner', 'person.update', {circleId:circle.id, personId:person.id, patch:{}, visibility:{photoFileId:'self'}});
  assert.equal((await call('helper', 'photo.url', {circleId:circle.id, personId:person.id})).ok, true);
  await call('owner', 'member.setRole', {circleId:circle.id, memberId:helper.id, role:'admin'});
  const delegation = (await call('owner', 'delegation.grant', {circleId:circle.id, personId:person.id, adminMemberId:helper.id, fields:['photoFileId']})).data.delegation;
  const delegatedView = (await call('helper', 'person.get', {circleId:circle.id, personId:person.id})).data.person;
  assert.equal(delegatedView.hasPhoto, true);
  assert.equal(delegatedView.photoFileId, undefined);
  assert.equal((await call('helper', 'photo.url', {circleId:circle.id, personId:person.id})).ok, true);
  await call('owner', 'delegation.revoke', {circleId:circle.id, delegationId:delegation.id});
  assert.equal((await call('helper', 'photo.url', {circleId:circle.id, personId:person.id})).ok, true);
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
  const person = (await call('owner', 'person.create', {circleId: circle.id, name: '我', claimSelf: true,
    country:'中国', city:'杭州', birthday:{calendar:'solar',month:5,day:16}})).data.person;
  await stagePhoto(api, 'owner', circle.id, person.id);
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
    return (await stagePhoto(f.api, actor, circle.id, personId, visibility)).fileID;
  };
  const ownFile = await makePhoto('owner', own.id, 'self');
  const otherFile = await makePhoto('viewer', other.id, 'circle');
  let batches = 0;
  const api = new ApiService(f.repo, Date.now, async fileId => `https://signed.example/${fileId}`, async ids => {
    batches++;
    assert.deepEqual(ids, [ownFile, otherFile]);
    return {[ownFile]: 'https://signed.example/owner', [otherFile]: 'https://signed.example/visible'};
  });
  const request = {action: 'photo.urls', payload: {circleId: circle.id, personIds: [own.id, other.id, other.id, 'unknown']}};
  const result = await api.invoke(request, 'viewer');
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.urls, {[own.id]: 'https://signed.example/owner', [other.id]: 'https://signed.example/visible'});
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
  assert.deepEqual(afterRevoke.data.urls, {[own.id]: 'https://signed.example/private'});
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
  const base64 = TEST_JPEG.toString('base64');
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

test('服务端剥离 JPEG 的 EXIF、位置、时间、ICC、注释，普通 JPEG 保留图像段', async () => {
  const exif = jpegSegment(0xe1, Buffer.from('Exif\0\0GPSLatitude=31.2;DateTimeOriginal=2026:01:01'));
  const xmp = jpegSegment(0xe1, Buffer.from('XMP GPSLongitude=121.5'));
  const icc = jpegSegment(0xe2, Buffer.from('ICC_PROFILE\0sensitive-profile'));
  const comment = jpegSegment(0xfe, Buffer.from('Comment home address'));
  const contaminated = Buffer.concat([
    TEST_JPEG.subarray(0, 2), exif, xmp, icc, comment,
    TEST_JPEG.subarray(2, -2), comment, TEST_JPEG.subarray(-2)
  ]);
  const expected = stripJpegMetadata(TEST_JPEG);
  assert.deepEqual(stripJpegMetadata(contaminated), expected);
  assert.equal(expected[0], 0xff);
  assert.equal(expected[1], 0xd8);
  assert.deepEqual(expected.subarray(-2), Buffer.from([0xff, 0xd9]));
  for (const sensitive of ['GPSLatitude', 'DateTimeOriginal', 'GPSLongitude', 'ICC_PROFILE', 'home address']) {
    assert.equal(expected.includes(Buffer.from(sensitive)), false);
  }
  const f = fixture();
  const circle = await f.create();
  const person = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '我', claimSelf: true})).person;
  let uploadedBytes;
  const storage = {
    uploadFile: async ({cloudPath, fileContent}) => {
      uploadedBytes = fileContent;
      return {fileID: `cloud://env.bucket/${cloudPath}`};
    },
    deleteFile: async () => ({})
  };
  const result = await handlePhotoUpload({payload: {circleId: circle.id, personId: person.id, base64: contaminated.toString('base64')}}, 'owner', f.api, storage);
  assert.equal(result.ok, true);
  assert.deepEqual(uploadedBytes, expected);
});

test('伪 JPEG 与超大像素尺寸上传在占用额度前拒绝', async () => {
  const f = fixture();
  const circle = await f.create();
  const person = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '我', claimSelf: true})).person;
  let uploads = 0;
  const storage = {uploadFile: async () => {uploads++; return {};}, deleteFile: async () => ({})};
  const fake = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x01, 0x02, 0xff, 0xd9]);
  const malformed = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), TEST_JPEG.subarray(2)]);
  const oversized = Buffer.from(TEST_JPEG);
  const frame = oversized.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(frame > 0);
  oversized.writeUInt16BE(8192, frame + 5);
  oversized.writeUInt16BE(8192, frame + 7);
  for (const bytes of [fake, malformed, oversized]) {
    const result = await handlePhotoUpload({payload: {circleId: circle.id, personId: person.id, base64: bytes.toString('base64')}}, 'owner', f.api, storage);
    assert.equal(result.error.code, 'INVALID_IMAGE');
  }
  assert.equal(uploads, 0);
  assert.equal((await f.repo.atomic(tx => tx.find('photoUploadBudgets', {}))).length, 0);
});

test('更换照片后圈内成员始终可见，旧可见标记不影响读取', async () => {
  const f = fixture();
  const circle = await f.create();
  const person = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '我', claimSelf: true})).person;
  await f.join('owner', 'viewer', circle.id);
  await stagePhoto(f.api, 'owner', circle.id, person.id, 'circle');
  assert.equal((await f.ok('viewer', 'person.get', {circleId: circle.id, personId: person.id})).person.hasPhoto, true);
  const base64 = TEST_JPEG.toString('base64');
  const storage = {
    uploadFile: async ({cloudPath}) => ({fileID: `cloud://env.bucket/${cloudPath}`}),
    deleteFile: async () => ({})
  };
  const calls = [];
  const trackedApi = {
    reservePhotoUpload: (...args) => f.api.reservePhotoUpload(...args),
    refundPhotoUpload: (...args) => f.api.refundPhotoUpload(...args),
    bindUploadedPhoto: async (payload, actor) => {
      calls.push(payload);
      return f.api.bindUploadedPhoto(payload, actor);
    }
  };
  const payload = {circleId: circle.id, personId: person.id, base64};
  let response = await handlePhotoUpload({payload: {...payload, visibility: 'self'}}, 'owner', trackedApi, storage);
  assert.equal(response.ok, true);
  assert.deepEqual(calls.map(call => call.visibility), [undefined]);
  assert.equal((await f.ok('viewer', 'person.get', {circleId: circle.id, personId: person.id})).person.photoFileId, undefined);
  assert.equal((await f.ok('viewer', 'person.get', {circleId: circle.id, personId: person.id})).person.hasPhoto, true);
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: person.id, patch: {}, visibility: {photoFileId: 'circle'}});
  response = await handlePhotoUpload({payload}, 'owner', trackedApi, storage);
  assert.equal(response.ok, true);
  assert.equal((await f.ok('owner', 'person.get', {circleId: circle.id, personId: person.id})).person.visibility, undefined);
  assert.equal((await f.ok('viewer', 'person.get', {circleId: circle.id, personId: person.id})).person.photoFileId, undefined);
});

test('照片代维护仍需授权，旧可见范围参数被忽略', async () => {
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
  const payload = {circleId: circle.id, personId: person.id, base64: TEST_JPEG.toString('base64')};
  let response = await handlePhotoUpload({payload: {...payload, visibility: 'circle'}}, 'helper', f.api, storage);
  assert.equal(response.ok, true);
  assert.equal(uploads, 1);
  response = await handlePhotoUpload({payload}, 'helper', f.api, storage);
  assert.equal(response.ok, true);
  assert.equal(uploads, 2);
  assert.equal((await f.ok('owner', 'person.get', {circleId: circle.id, personId: person.id})).person.visibility, undefined);
});

test('照片上传期间撤销管理员身份会阻止绑定，清理云文件并返还额度', async () => {
  const f = fixture();
  const circle = await f.create();
  const person = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '长辈', claimSelf: true})).person;
  const helper = await f.join('owner', 'helper', circle.id);
  await f.ok('owner', 'member.setRole', {circleId: circle.id, memberId: helper.id, role: 'admin'});
  let deleted = 0;
  const storage = {
    uploadFile: async ({cloudPath}) => {
      await f.ok('owner', 'member.setRole', {circleId: circle.id, memberId: helper.id, role: 'member'});
      return {fileID: `cloud://env.bucket/${cloudPath}`};
    },
    deleteFile: async ({fileList}) => {deleted++; return {fileList: [{fileID: fileList[0], status: 0, errMsg: 'ok'}]};}
  };
  const response = await handlePhotoUpload({payload: {circleId: circle.id, personId: person.id, base64: TEST_JPEG.toString('base64')}}, 'helper', f.api, storage);
  assert.equal(response.error.code, 'FORBIDDEN');
  assert.equal(deleted, 1);
  assert.equal((await f.ok('owner', 'person.get', {circleId: circle.id, personId: person.id})).person.hasPhoto, false);
  assert.equal((await f.repo.atomic(tx => tx.find('photoUploadBudgets', {})))[0].count, 0);
});

test('普通成员即使持有旧照片授权也不能发放上传路径或占用云存储', async () => {
  const f = fixture();
  const circle = await f.create();
  const person = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '长辈', claimSelf: true})).person;
  const helper = await f.join('owner', 'helper', circle.id);
  await f.ok('owner', 'member.setRole', {circleId: circle.id, memberId: helper.id, role: 'admin'});
  const granted = (await f.ok('owner', 'delegation.grant', {circleId: circle.id, personId: person.id, adminMemberId: helper.id, fields: ['photoFileId']})).delegation;
  await f.ok('owner', 'member.setRole', {circleId: circle.id, memberId: helper.id, role: 'member'});
  await f.repo.atomic(async tx => {
    const stale = await tx.get('delegations', granted.id);
    stale.ownerUserId = 'former-owner';
    await tx.put('delegations', stale);
  });
  const reserved = await f.api.reservePhotoUpload({circleId: circle.id, personId: person.id}, 'helper');
  assert.equal(reserved.error.code, 'FORBIDDEN');
  let uploaded = false;
  const storage = {uploadFile: async () => {uploaded = true; return {};}, deleteFile: async () => ({})};
  const base64 = TEST_JPEG.toString('base64');
  const result = await handlePhotoUpload({payload: {circleId: circle.id, personId: person.id, base64}}, 'helper', f.api, storage);
  assert.equal(result.error.code, 'FORBIDDEN');
  assert.equal(uploaded, false);
});

test('照片上传按微信账号持久限制 24 小时 20 次，并发也不会超额', async () => {
  const f = fixture();
  const circle = await f.create();
  const person = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '我', claimSelf: true})).person;
  // Public path preview does not reserve the server-side upload budget.
  // Public API cannot reserve a budget without actually running photo.upload.
  await f.denied('owner', 'photo.uploadPath', {circleId: circle.id, personId: person.id}, 'UNKNOWN_ACTION');
  assert.equal((await f.repo.atomic(tx => tx.find('photoUploadBudgets', {}))).length, 0);
  let uploads = 0;
  const storage = {
    uploadFile: async ({cloudPath}) => {uploads++; return {fileID: `cloud://env.bucket/${cloudPath}`};},
    deleteFile: async () => ({})
  };
  const payload = {circleId: circle.id, personId: person.id, base64: TEST_JPEG.toString('base64')};
  const results = await Promise.all(Array.from({length: 22}, () => handlePhotoUpload({payload}, 'owner', f.api, storage)));
  assert.equal(results.filter(result => result.ok).length, 20);
  assert.equal(results.filter(result => result.error?.code === 'PHOTO_UPLOAD_LIMIT').length, 2);
  assert.equal(uploads, 20);
  const budget = (await f.repo.atomic(tx => tx.find('photoUploadBudgets', {})))[0];
  assert.equal(budget.count, 20);
  f.advance(24 * 60 * 60 * 1000);
  assert.equal((await handlePhotoUpload({payload}, 'owner', f.api, storage)).ok, true);
});

test('照片绑定失败且云文件已清理时返还额度，未知上传结果保留额度', async () => {
  const f = fixture();
  const circle = await f.create();
  const person = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '我', claimSelf: true})).person;
  const payload = {circleId: circle.id, personId: person.id, base64: TEST_JPEG.toString('base64')};
  let deleted = 0;
  const storage = {
    uploadFile: async ({cloudPath}) => ({fileID: `cloud://env.bucket/${cloudPath}`}),
    deleteFile: async ({fileList}) => {deleted++; return {fileList: [{fileID: fileList[0], status: 0, errMsg: 'ok'}]};}
  };
  const failingApi = {
    reservePhotoUpload: (...args) => f.api.reservePhotoUpload(...args),
    refundPhotoUpload: (...args) => f.api.refundPhotoUpload(...args),
    bindUploadedPhoto: () => Promise.resolve({ok: false, error: {code: 'FORBIDDEN', message: '权限已改变'}})
  };
  const failed = await handlePhotoUpload({payload}, 'owner', failingApi, storage);
  assert.equal(failed.error.code, 'FORBIDDEN');
  assert.equal(deleted, 1);
  let budget = (await f.repo.atomic(tx => tx.find('photoUploadBudgets', {})))[0];
  assert.equal(budget.count, 0);
  const notDeleted = await handlePhotoUpload({payload}, 'owner', failingApi, {
    uploadFile: storage.uploadFile,
    deleteFile: async ({fileList}) => ({fileList: [{fileID: fileList[0], status: -1, errMsg: 'permission denied'}]})
  });
  assert.equal(notDeleted.error.code, 'FORBIDDEN');
  budget = (await f.repo.atomic(tx => tx.find('photoUploadBudgets', {})))[0];
  assert.equal(budget.count, 1, 'resolved delete with a per-file failure must retain the upload charge');
  const uncertain = await handlePhotoUpload({payload}, 'owner', f.api, {
    uploadFile: async () => {throw new Error('network lost after possible upload');},
    deleteFile: async () => ({})
  });
  assert.equal(uncertain.error.code, 'UPLOAD_FAILED');
  budget = (await f.repo.atomic(tx => tx.find('photoUploadBudgets', {})))[0];
  assert.equal(budget.count, 2);
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
  assert.equal(view.name, 'elder');
  assert.equal(view.city, undefined);
  assert.equal(view.latitude, undefined);
  assert.equal(view.longitude, undefined);
  assert.equal(view.phone, undefined);
  assert.equal(view.isClaimed, false);
});

test('管理员可直接更正本录已关联资料，普通成员不可改，账号主资料不变', async () => {
  const f = fixture();
  const circle = await f.create();
  const card = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '长辈'})).person;
  await f.join('owner', 'elder', circle.id, card.id);
  await f.join('owner', 'other', circle.id);
  const elderMember = (await f.ok('owner', 'member.list', {circleId: circle.id})).members.find(m => m.personId === card.id);
  await f.ok('owner', 'member.setRole', {circleId: circle.id, memberId: elderMember.id, role: 'admin'});
  await f.ok('elder', 'person.update', {circleId: circle.id, personId: card.id, patch: {country: '中国', province: '广东', city: '佛山', phone: '12345'}});
  assert.equal((await f.ok('owner', 'person.get', {circleId: circle.id, personId: card.id})).person.city, '佛山');
  await f.denied('other', 'person.update', {circleId: circle.id, personId: card.id, patch: {city: '北京'}}, 'FORBIDDEN');
  assert.equal((await f.ok('other', 'person.get', {circleId: circle.id, personId: card.id})).person.city, '佛山');
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: card.id, patch: {country: '中国', province: '广东', city: '广州', latitude: 23.1291, longitude: 113.2644}});
  const elderView = (await f.ok('elder', 'person.get', {circleId: circle.id, personId: card.id})).person;
  assert.equal(elderView.country, '中国');
  assert.equal(elderView.province, '广东');
  assert.equal(elderView.city, '广州');
  assert.equal(elderView.latitude, 23.1);
  assert.equal(elderView.longitude, 113.3);
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: card.id, patch: {phone: '123'}});
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: card.id, patch: {}, visibility: {city: 'circle'}});
  assert.equal((await f.ok('elder', 'account.profile.get')).profile.city, '佛山');
  assert.equal((await f.ok('elder', 'account.profile.get')).profile.phone, '12345');
  assert.equal((await f.ok('owner', 'person.get', {circleId: circle.id, personId: card.id})).person.city, '广州');
  await f.ok('owner', 'person.update', {circleId: circle.id, personId: card.id, patch: {city: '深圳'}});
  assert.equal((await f.ok('elder', 'account.profile.get')).profile.city, '佛山');
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
  assert.ok((await f.ok('owner', 'relation.list', {circleId: circle.id})).relations.some(row =>
    [row.from, row.to].includes(a.id) && [row.from, row.to].includes(b.id)));
  await f.denied('owner', 'person.delete', {circleId: circle.id, personId: b.id}, 'RELATION_CONNECTED');
});

test('历史关系计数漂移时仍不能删除被实际关系引用的人物', async () => {
  const f = fixture();
  const circle = await f.create();
  const a = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '甲'})).person;
  const b = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '乙'})).person;
  assert.equal((await f.ok('owner', 'relation.list', {circleId: circle.id})).relations.length, 1);
  await f.repo.atomic(async tx => {
    const person = await tx.get('persons', a.id);
    person.relationCount = 0;
    await tx.put('persons', person);
  });
  await f.denied('owner', 'person.delete', {circleId: circle.id, personId: a.id}, 'RELATION_CONNECTED');
  assert.equal((await f.ok('owner', 'person.list', {circleId: circle.id})).persons.some(person => person.id === a.id), true);
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

test('退出圈子使待审认领失效，重新加入后可以重新申请', async () => {
  const f = fixture();
  const circle = await f.create();
  const card = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '待认领'})).person;
  await f.join('owner', 'member', circle.id);
  const claim = (await f.ok('member', 'person.claim', {circleId: circle.id, personId: card.id})).claimRequest;
  await f.ok('member', 'member.leave', {circleId: circle.id});
  const pending = (await f.ok('owner', 'person.claimList', {circleId: circle.id})).claimRequests;
  assert.equal(pending.length, 0);
  await f.denied('owner', 'person.claimApprove', {circleId: circle.id, claimRequestId: claim.id}, 'ALREADY_REVIEWED');
  await f.join('owner', 'member', circle.id);
  const retry = (await f.ok('member', 'person.claim', {circleId: circle.id, personId: card.id})).claimRequest;
  assert.equal(retry.id, claim.id);
  assert.equal(retry.status, 'pending');
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

test('入圈申请不能预认领，旧待审记录的预认领字段不会被审批绑定', async () => {
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
  assert.ok(member.personId);
  assert.notEqual(member.personId, card.id);
  assert.equal((await f.ok('owner','person.get',{circleId:circle.id,personId:card.id})).person.isClaimed,false);
  await f.denied('applicant','person.claim',{circleId:circle.id,personId:card.id},'ALREADY_CLAIMED');
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
  await f.ok('owner', 'join.approve', {circleId:circle.id, applicationId:application.id, targetPersonId:card.id});
  assert.equal((await f.ok('owner','member.list',{circleId:circle.id})).members.find(m=>!m.isSelf).personId,card.id);
  const oldMemberId = (await f.ok('owner','member.list',{circleId:circle.id})).members.find(m=>!m.isSelf).id;
  await f.ok('member', 'person.update', {circleId:circle.id, personId:card.id, patch:{phone:'12345',wechatId:'secret_wechat'}, visibility:{phone:'circle'}});
  await f.ok('owner', 'person.unclaim', {circleId:circle.id, personId:card.id, reasonCode:'wrong_person'});
  const view = (await f.ok('member', 'person.get', {circleId:circle.id, personId:card.id})).person;
  assert.equal(view.isClaimed, false);
  assert.equal(view.phone, undefined);
  const audit = (await f.ok('owner','audit.list',{circleId:circle.id})).events.find(event=>event.type==='person.unclaim');
  assert.equal(audit.details.oldMemberId,oldMemberId);
  for (const field of ['birthday','city','country','phone','wechatId']) assert.ok(audit.details.clearedFields.includes(field));
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
  assert.equal(owner.name, '创建者');
  await f.ok('owner', 'person.create', {circleId: circle.id, name: '张圈主', claimSelf: true});
  owner = (await f.ok('owner', 'member.list', {circleId: circle.id})).members.find(m => m.isSelf);
  assert.equal(owner.name, '张圈主');
  const card = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '待认领'})).person;
  const invite = (await f.ok('owner', 'invite.create', {circleId: circle.id})).invite;
  const application = (await f.ok('student', 'invite.apply', {token: invite.token, name: '李同学'})).application;
  await f.ok('owner', 'join.approve', {circleId: circle.id, applicationId: application.id});
  await f.legacyUnbind('student', circle.id);
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
  const b = await f.legacyCard(circle.id, '乙');
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
  const [grand, parent, child, peer] = await Promise.all(names.map(name => f.legacyCard(circle.id, name)));
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
  const child = (await f.ok('owner','person.create',{circleId:circle.id,name:'孩子',
    initialRelation:{anchorPersonId:parent.id,kind:'newParent'}})).person;
  const old = (await f.ok('owner','relation.list',{circleId:circle.id})).relations[0];
  const result = await f.ok('owner','relation.replace',{circleId:circle.id,relationId:old.id,relation:{from:parent.id,to:child.id,type:'parent'}});
  assert.equal(result.impact.removedRelationIds[0], old.id);
  assert.equal(result.relation.from, parent.id);
  const relations = (await f.ok('owner','relation.list',{circleId:circle.id})).relations;
  assert.equal(relations.length, 1);
  assert.equal(relations[0].to, child.id);
  const audit = (await f.ok('owner','audit.list',{circleId:circle.id})).events.find(event => event.type === 'relation.replace');
  assert.equal(audit.actorName, '创建者');
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
  const b = (await f.ok('owner','person.create',{circleId:circle.id,name:'乙',
    initialRelation:{anchorPersonId:a.id,kind:'newParent'}})).person;
  const wrong = (await f.ok('owner','relation.list',{circleId:circle.id})).relations[0];
  const change = {removeRelationId:wrong.id,relation:{from:a.id,to:b.id,type:'parent'}};
  const suggestion = (await f.ok('member','suggestion.create',{circleId:circle.id,type:'relation',message:'亲子方向填反了',relationChange:change})).suggestion;
  assert.equal(suggestion.relationChange.removeRelationId, wrong.id);
  assert.equal(suggestion.relationChange.relation.from, a.id);
  assert.equal(suggestion.relationChange.relation.to, b.id);
  await f.denied('member','suggestion.resolve',{circleId:circle.id,suggestionId:suggestion.id,status:'accepted',resolutionNote:'核对后更正方向'},'FORBIDDEN');
  const resolved = await f.ok('owner','suggestion.resolve',{circleId:circle.id,suggestionId:suggestion.id,status:'accepted',resolutionNote:'核对后更正方向'});
  assert.equal(resolved.suggestion.status,'accepted');
  assert.equal(resolved.suggestion.resolutionNote,'核对后更正方向');
  assert.equal(resolved.impact.removedRelationIds[0],wrong.id);
  assert.equal((await f.ok('owner','relation.list',{circleId:circle.id})).relations[0].from,a.id);
  const audit = (await f.ok('owner','audit.list',{circleId:circle.id})).events.find(event => event.type === 'suggestion.resolve');
  assert.equal(audit.details.removed.from,b.id);
  assert.equal(audit.details.created.from,a.id);
  assert.equal(audit.details.resolutionNote,'核对后更正方向');
  assert.equal(audit.details.removed.createdBy,undefined);
  assert.equal(audit.details.created.createdBy,undefined);
  await f.denied('owner','suggestion.resolve',{circleId:circle.id,suggestionId:suggestion.id,status:'accepted',resolutionNote:'重复处理'},'ALREADY_REVIEWED');

  // Existing installations can have text-only relation suggestions. They must
  // remain pending on acceptance, while rejection remains possible.
  await f.repo.atomic(tx => tx.put('suggestions',{id:'legacy',circleId:circle.id,createdBy:'member',type:'relation',message:'以前的文字建议',status:'pending',createdAt:1}));
  await f.denied('owner','suggestion.resolve',{circleId:circle.id,suggestionId:'legacy',status:'accepted',resolutionNote:'无法直接改图'},'CHANGE_REQUIRED');
  assert.equal((await f.ok('owner','suggestion.list',{circleId:circle.id})).suggestions.find(item=>item.id==='legacy').status,'pending');
  await f.ok('owner','suggestion.resolve',{circleId:circle.id,suggestionId:'legacy',status:'rejected',resolutionNote:'请重新提交具体边变更'});
  const personNote = (await f.ok('member','suggestion.create',{circleId:circle.id,type:'person',message:'姓名有误'})).suggestion;
  await f.denied('owner','suggestion.resolve',{circleId:circle.id,suggestionId:personNote.id,status:'accepted',resolutionNote:'已核实'},'CHANGE_REQUIRED');
});

test('人物和邀请文字建议可注明人工处理结果，但不能假称已自动修改', async () => {
  const f = fixture();
  const circle = await f.create();
  await f.join('owner', 'member', circle.id);
  const person = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '原姓名'})).person;
  const personSuggestion = (await f.ok('member', 'suggestion.create', {circleId: circle.id, personId: person.id, type: 'person', message: '姓名可能有误'})).suggestion;
  await f.denied('owner', 'suggestion.resolve', {circleId: circle.id, suggestionId: personSuggestion.id, status: 'handled', resolutionNote: '  '}, 'INVALID_INPUT');
  assert.equal((await f.ok('owner', 'suggestion.list', {circleId: circle.id})).suggestions.find(item => item.id === personSuggestion.id).status, 'pending');
  const handled = (await f.ok('owner', 'suggestion.resolve', {circleId: circle.id, suggestionId: personSuggestion.id, status: 'handled', resolutionNote: '已电话核实，资料将在本人确认后更正'})).suggestion;
  assert.equal(handled.status, 'handled');
  assert.equal(handled.resolutionNote, '已电话核实，资料将在本人确认后更正');
  assert.equal((await f.ok('owner', 'person.get', {circleId: circle.id, personId: person.id})).person.name, '原姓名');
  const fromList = (await f.ok('member', 'suggestion.list', {circleId: circle.id})).suggestions.find(item => item.id === personSuggestion.id);
  assert.equal(fromList.resolutionNote, handled.resolutionNote);
  const audit = (await f.ok('owner', 'audit.list', {circleId: circle.id})).events.find(item => item.type === 'suggestion.resolve' && item.targetId === personSuggestion.id);
  assert.equal(audit.details.status, 'handled');
  assert.equal(audit.details.resolutionNote, handled.resolutionNote);

  const inviteSuggestion = (await f.ok('member', 'suggestion.create', {circleId: circle.id, type: 'invite', message: '请核对邀请对象'})).suggestion;
  const inviteHandled = (await f.ok('owner', 'suggestion.resolve', {circleId: circle.id, suggestionId: inviteSuggestion.id, status: 'handled', resolutionNote: '已联系邀请人重新核对'})).suggestion;
  assert.equal(inviteHandled.status, 'handled');
  assert.equal(inviteHandled.resolutionNote, '已联系邀请人重新核对');

  const a = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '甲'})).person;
  const b = (await f.ok('owner', 'person.create', {circleId: circle.id, name: '乙'})).person;
  const relationSuggestion = (await f.ok('member', 'suggestion.create', {circleId: circle.id, type: 'relation', message: '请核对关系', relationChange: {relation: {from: a.id, to: b.id, type: 'sibling'}}})).suggestion;
  await f.denied('owner', 'suggestion.resolve', {circleId: circle.id, suggestionId: relationSuggestion.id, status: 'handled', resolutionNote: '我看过了'}, 'CHANGE_REQUIRED');
  assert.equal((await f.ok('owner', 'suggestion.list', {circleId: circle.id})).suggestions.find(item => item.id === relationSuggestion.id).status, 'pending');
});

test('建议按账号和圈子限制待审数量及滚动 24 小时提交量', async () => {
  const f = fixture();
  const circle = await f.create();
  const otherCircle = await f.create();
  await f.join('owner', 'member', circle.id);
  await f.join('owner', 'member', otherCircle.id);
  const payload = {circleId: circle.id, type: 'person', message: '请核对人物资料'};
  const firstFive = [];
  for (let i = 0; i < 5; i++) {
    firstFive.push((await f.ok('member', 'suggestion.create', payload)).suggestion);
  }
  const pendingLimit = await f.call('member', 'suggestion.create', payload);
  assert.equal(pendingLimit.error.code, 'SUGGESTION_PENDING_LIMIT');
  assert.match(pendingLimit.error.message, /5 条待处理建议/);
  await f.ok('member', 'suggestion.create', {...payload, circleId: otherCircle.id});
  await f.ok('owner', 'suggestion.create', payload);
  for (const suggestion of firstFive) {
    await f.ok('owner', 'suggestion.resolve', {circleId: circle.id, suggestionId: suggestion.id, status: 'rejected', resolutionNote: '暂不采纳'});
  }
  const nextFive = [];
  for (let i = 0; i < 5; i++) {
    nextFive.push((await f.ok('member', 'suggestion.create', payload)).suggestion);
  }
  await f.ok('owner', 'suggestion.resolve', {circleId: circle.id, suggestionId: nextFive[0].id, status: 'rejected', resolutionNote: '暂不采纳'});
  const dailyLimit = await f.call('member', 'suggestion.create', payload);
  assert.equal(dailyLimit.error.code, 'SUGGESTION_DAILY_LIMIT');
  assert.match(dailyLimit.error.message, /每 24 小时.*10 条建议/);
  f.advance(24 * 60 * 60 * 1000 + 1);
  await f.ok('member', 'suggestion.create', payload);
  const all = (await f.ok('owner', 'suggestion.list', {circleId: circle.id})).suggestions;
  assert.equal(all.filter(item => item.message === payload.message).length, 12);
});

test('并发提交建议也不能超过同一成员的待审上限', async () => {
  const f = fixture();
  const circle = await f.create();
  await f.join('owner', 'member', circle.id);
  const payload = {circleId: circle.id, type: 'person', message: '请核对人物资料'};
  const results = await Promise.all(Array.from({length: 12}, () => f.call('member', 'suggestion.create', payload)));
  assert.equal(results.filter(result => result.ok).length, 5);
  assert.ok(results.filter(result => !result.ok).every(result => result.error.code === 'SUGGESTION_PENDING_LIMIT'));
  assert.equal((await f.ok('owner', 'suggestion.list', {circleId: circle.id})).suggestions.length, 5);
  assert.equal((await f.ok('owner', 'audit.list', {circleId: circle.id})).events.filter(event => event.type === 'suggestion.create').length, 5);
});

test('关系建议过期或与新边冲突时不会假采纳', async () => {
  const f = fixture();
  const circle = await f.create();
  await f.join('owner','member',circle.id);
  const a = (await f.ok('owner','person.create',{circleId:circle.id,name:'甲'})).person;
  const b = (await f.ok('owner','person.create',{circleId:circle.id,name:'乙'})).person;
  const old = (await f.ok('owner','relation.list',{circleId:circle.id})).relations[0];
  const suggestion = (await f.ok('member','suggestion.create',{circleId:circle.id,type:'relation',message:'改成长幼',relationChange:{removeRelationId:old.id,relation:{from:a.id,to:b.id,type:'sibling',olderId:a.id}}})).suggestion;
  await f.ok('owner','relation.replace',{circleId:circle.id,relationId:old.id,relation:{from:a.id,to:b.id,type:'sibling',olderId:b.id}});
  await f.denied('owner','suggestion.resolve',{circleId:circle.id,suggestionId:suggestion.id,status:'accepted',resolutionNote:'核对后更正'},'STALE_RELATION');
  assert.equal((await f.ok('owner','suggestion.list',{circleId:circle.id})).suggestions[0].status,'pending');
  assert.equal((await f.ok('owner','relation.list',{circleId:circle.id})).relations[0].olderId,b.id);
  await f.ok('owner','suggestion.resolve',{circleId:circle.id,suggestionId:suggestion.id,status:'rejected',resolutionNote:'原关系已变更，请重提'});

  const third = await f.legacyCard(circle.id, '丙');
  const proposal = (await f.ok('member','suggestion.create',{circleId:circle.id,type:'relation',message:'甲是丙家长',relationChange:{relation:{from:a.id,to:third.id,type:'parent'}}})).suggestion;
  await f.ok('owner','relation.create',{circleId:circle.id,from:third.id,to:a.id,type:'parent'});
  await f.denied('owner','suggestion.resolve',{circleId:circle.id,suggestionId:proposal.id,status:'accepted',resolutionNote:'核对后更正'},'RELATION_CONFLICT');
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
  await f.legacyUnbind('member', circle.id);
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

test('历史审核通过不等于当前仍可入圈，退出后入口状态会撤回', async () => {
  const f = fixture();
  const circle = await f.create();
  const invite = (await f.ok('owner', 'invite.create', {circleId: circle.id})).invite;
  const application = (await f.ok('member', 'invite.apply', {token: invite.token, name: '成员'})).application;
  await f.ok('owner', 'join.approve', {circleId: circle.id, applicationId: application.id});
  let status = (await f.ok('member', 'join.mine', {applicationId: application.id})).applications[0];
  assert.equal(status.status, 'approved');
  assert.equal(status.canEnter, true);
  await f.ok('member', 'member.leave', {circleId: circle.id});
  status = (await f.ok('member', 'join.mine', {applicationId: application.id})).applications[0];
  assert.equal(status.status, 'approved');
  assert.equal(status.canEnter, false);
});

test('旧空卡仍可见且可补录，只有城市和生日齐全才标记资料完整', async () => {
  const f = fixture();
  const circle = await f.create();
  const draft = await f.legacyCard(circle.id, '待补录长辈');
  assert.equal((await f.ok('owner','person.get',{circleId:circle.id,personId:draft.id})).person.profileComplete, false);
  await f.denied('owner','person.update',{circleId:circle.id,personId:draft.id,patch:{birthday:{calendar:'solar',month:2,day:30}}},'INVALID_INPUT');
  await f.ok('owner','person.update',{circleId:circle.id,personId:draft.id,patch:{country:'中国',province:'广东',city:'广州',latitude:23.1,longitude:113.3,birthday:{calendar:'lunar',month:8,day:15}}});
  const complete = (await f.ok('owner','person.list',{circleId:circle.id})).persons.find(person=>person.id===draft.id);
  assert.equal(complete.profileComplete,true);
  assert.deepEqual(complete.birthday,{calendar:'lunar',month:8,day:15});
  assert.equal(complete.city,'广州');
  await f.denied('owner','person.update',{circleId:circle.id,personId:draft.id,patch:{birthday:{calendar:'lunar',month:5,day:31}}},'INVALID_INPUT');
  await f.denied('owner','person.update',{circleId:circle.id,personId:draft.id,patch:{birthday:null}},'PROFILE_INCOMPLETE');
  await f.denied('owner','person.update',{circleId:circle.id,personId:draft.id,patch:{city:null}},'PROFILE_INCOMPLETE');
});

test('入圈申请须先填完整城市生日，审批原子建立本人卡且不会按同名自动认领', async () => {
  const f = fixture();
  const circle = await f.create();
  const oldCard = (await f.ok('owner','person.create',{circleId:circle.id,name:'小李'})).person;
  const invite = (await f.ok('owner','invite.create',{circleId:circle.id})).invite;
  const profile = {country:'中国',province:'浙江',city:'杭州',latitude:30.3,longitude:120.2,birthday:{calendar:'solar',month:3,day:8}};
  const missing = await f.api.invoke({action:'invite.apply',payload:{token:invite.token,name:'小李'}},'applicant');
  assert.equal(missing.error.code,'PROFILE_INCOMPLETE');
  await f.denied('applicant','invite.apply',{token:invite.token,name:'小李',profile:{...profile,birthday:{calendar:'solar',month:2,day:30}}},'INVALID_INPUT');
  const application = (await f.ok('applicant','invite.apply',{token:invite.token,name:'小李',profile})).application;
  assert.deepEqual(application.profile,profile);
  const review = (await f.ok('owner','join.list',{circleId:circle.id})).applications[0];
  assert.equal(review.profile.city,'杭州');
  await f.ok('owner','join.approve',{circleId:circle.id,applicationId:application.id});
  const member = (await f.ok('owner','member.list',{circleId:circle.id})).members.find(item=>!item.isSelf);
  assert.ok(member.personId);
  assert.notEqual(member.personId,oldCard.id);
  assert.equal((await f.ok('owner','person.get',{circleId:circle.id,personId:oldCard.id})).person.isClaimed,false);
  const self = (await f.ok('applicant','person.get',{circleId:circle.id,personId:member.personId})).person;
  assert.equal(self.isSelf,true);
  assert.equal(self.profileComplete,true);
  assert.deepEqual(self.birthday,profile.birthday);
  assert.equal(self.city,'杭州');
});

test('管理员明确选择现有卡时才绑定，跨圈卡或已认领卡拒绝且不消耗邀请', async () => {
  const f = fixture();
  const circle = await f.create();
  const foreign = await f.create('foreign');
  const foreignCard = (await f.ok('foreign','person.create',{circleId:foreign.id,name:'外圈卡'})).person;
  const card = (await f.ok('owner','person.create',{circleId:circle.id,name:'预录卡',country:'日本',city:'东京',latitude:35.7,longitude:139.7,birthday:{calendar:'solar',month:1,day:1}})).person;
  const invite = (await f.ok('owner','invite.create',{circleId:circle.id})).invite;
  const application = (await f.ok('newcomer','invite.apply',{token:invite.token,name:'真实姓名',profile:{country:'中国',city:'南京',birthday:{calendar:'solar',month:5,day:20}}})).application;
  await f.denied('owner','join.approve',{circleId:circle.id,applicationId:application.id,targetPersonId:foreignCard.id},'NOT_FOUND');
  assert.equal((await f.ok('owner','join.list',{circleId:circle.id})).applications[0].status,'pending');
  await f.ok('owner','join.approve',{circleId:circle.id,applicationId:application.id,targetPersonId:card.id});
  const bound = (await f.ok('owner','person.get',{circleId:circle.id,personId:card.id})).person;
  assert.equal(bound.name,'真实姓名');
  assert.equal(bound.profileComplete,true);
  assert.equal(bound.isClaimed,true);
  assert.equal(bound.city,'南京');
  assert.equal(bound.latitude,undefined);
  assert.equal(bound.longitude,undefined);
  assert.equal((await f.ok('owner','member.list',{circleId:circle.id})).members.find(member=>!member.isSelf).personId,card.id);
  const secondInvite = (await f.ok('owner','invite.create',{circleId:circle.id})).invite;
  const secondApplication = (await f.ok('other','invite.apply',{token:secondInvite.token,name:'另一人'})).application;
  await f.denied('owner','join.approve',{circleId:circle.id,applicationId:secondApplication.id,targetPersonId:card.id},'ALREADY_CLAIMED');
  assert.equal((await f.ok('owner','invite.list',{circleId:circle.id})).invites.find(row=>row.id===secondInvite.id).status,'active');
});

test('历史待审申请缺少完整资料时不能被批准，成员资格和邀请均不变', async () => {
  const f = fixture();
  const circle = await f.create();
  const invite = (await f.ok('owner','invite.create',{circleId:circle.id})).invite;
  const application = (await f.ok('applicant','invite.apply',{token:invite.token,name:'旧申请'})).application;
  await f.repo.atomic(async tx => {const row = await tx.get('applications',application.id);row.profile=undefined;await tx.put('applications',row);});
  await f.denied('owner','join.approve',{circleId:circle.id,applicationId:application.id},'PROFILE_INCOMPLETE');
  assert.equal((await f.ok('owner','member.list',{circleId:circle.id})).members.length,1);
  assert.equal((await f.ok('owner','join.list',{circleId:circle.id})).applications[0].status,'pending');
  assert.equal((await f.ok('owner','invite.list',{circleId:circle.id})).invites[0].status,'active');
});

test('近期生日跨本人圈汇总，忽略未补录卡和别人的圈', async () => {
  const f = fixture();
  const first = await f.create('owner');
  const second = await f.create('owner');
  const outside = await f.create('outsider');
  const details = {country:'中国',city:'北京',birthday:{calendar:'solar',month:1,day:16}};
  await f.ok('owner','person.create',{circleId:first.id,name:'甲',...details});
  await f.ok('owner','person.create',{circleId:second.id,name:'乙',...details});
  await f.legacyCard(first.id, '未补录');
  await f.ok('outsider','person.create',{circleId:outside.id,name:'外圈',...details});
  const events = (await f.ok('owner','birthday.upcoming',{days:3})).events;
  assert.deepEqual(events.map(event=>event.personName).sort(),['乙','甲']);
  assert.ok(events.every(event=>event.date==='2027-01-16'&&event.daysUntil===1&&event.birthdayText==='阳历1月16日'));
  assert.deepEqual((await f.ok('owner','birthday.upcoming',{circleId:first.id,days:3})).events.map(event=>event.personName),['甲']);
  await f.denied('owner','birthday.upcoming',{circleId:outside.id},'FORBIDDEN');
  await f.denied('owner','birthday.upcoming',{days:367},'INVALID_INPUT');
});

test('个人资料只保存一份，家庭与同学人物卡和生日都读取同一份', async () => {
  const f = fixture();
  const family = await f.create('owner');
  const classmates = await f.create('owner','classmate');
  const first = (await f.ok('owner','person.create',{circleId:family.id,name:'张三',claimSelf:true})).person;
  const second = (await f.ok('owner','person.create',{circleId:classmates.id,name:'旧名字',claimSelf:true})).person;
  await f.ok('owner','account.profile.update',{patch:{name:'张三',country:'中国',province:'上海',city:'上海',
    birthday:{calendar:'lunar',month:1,day:1},industry:'教育',school:'一中',phone:'13800000000',wechatId:'zhangsan'}});
  for (const [circle, person] of [[family,first],[classmates,second]]) {
    const view = (await f.ok('owner','person.get',{circleId:circle.id,personId:person.id})).person;
    assert.equal(view.name,'张三');
    assert.equal(view.city,'上海');
    assert.deepEqual(view.birthday,{calendar:'lunar',month:1,day:1});
    assert.equal(view.phone,'13800000000');
    assert.equal(view.wechatId,'zhangsan');
    assert.equal(view.industry,'教育');
    assert.equal((await f.ok('owner','person.list',{circleId:circle.id})).persons.find(row=>row.id===person.id).city,'上海');
  }
  await f.ok('owner','person.update',{circleId:family.id,personId:first.id,patch:{city:'苏州',province:'江苏'}});
  assert.equal((await f.ok('owner','account.profile.get')).profile.city,'苏州');
  assert.equal((await f.ok('owner','person.get',{circleId:classmates.id,personId:second.id})).person.city,'苏州');
  assert.equal((await f.repo.atomic(tx=>tx.find('userProfiles',{userId:'owner'}))).length,1);
  assert.equal((await f.ok('owner','birthday.upcoming',{days:366})).events.length,0);
  await f.join('owner','viewer',family.id);
  await f.join('owner','viewer',classmates.id);
  assert.equal((await f.ok('viewer','person.get',{circleId:classmates.id,personId:second.id})).person.city,'苏州');
  assert.notEqual((await f.ok('viewer','account.profile.get')).profile.name,'张三',
    '普通成员的账号资料接口只能返回本人');
  const events = (await f.ok('viewer','birthday.upcoming',{days:366})).events.filter(row=>row.personName==='张三');
  assert.equal(events.length,1);
  assert.equal(events[0].birthdayCalendar,'lunar');
  assert.equal(events[0].birthdayText,'农历1月1日');
});

test('旧关联卡不会在打开我的资料时反向填入账号主资料', async () => {
  const f = fixture();
  const family = await f.create('owner');
  const classmates = await f.create('owner','classmate');
  const first = (await f.ok('owner','person.create',{circleId:family.id,name:'原姓名',claimSelf:true,
    country:'中国',province:undefined,city:'上海',latitude:31.2,longitude:121.5,
    birthday:{calendar:'solar',month:5,day:16}})).person;
  const second = (await f.ok('owner','person.create',{circleId:classmates.id,name:'后录姓名',claimSelf:true,
    country:'日本',province:'东京都',city:'东京',latitude:35.7,longitude:139.7,
    birthday:{calendar:'lunar',month:8,day:15}})).person;
  await f.repo.atomic(async tx => {
    const profile = (await tx.find('userProfiles',{userId:'owner'}))[0];
    await tx.delete('userProfiles',profile.id); // Data created before account-wide profiles existed.
    const older = await tx.get('persons',first.id);
    older.latitude = undefined; older.longitude = undefined;
    older.industry = '教育'; older.createdAt = 1;
    await tx.put('persons',older);
    const newer = await tx.get('persons',second.id);
    newer.school = '一中'; newer.phone = '13800000000'; newer.wechatId = 'old_wechat';
    newer.createdAt = 2;
    await tx.put('persons',newer);
    await tx.put('persons',{id:'detached-card',circleId:family.id,claimedBy:'owner',name:'不该采用',
      nickname:'失效关联',visibility:{},createdAt:0,updatedAt:0});
  });
  assert.equal((await f.ok('owner','account.profile.get')).profile,null);
  assert.equal((await f.repo.atomic(tx=>tx.find('userProfiles',{userId:'owner'}))).length,0);
  await f.ok('owner','account.profile.update',{patch:{name:'本人确认的姓名',country:'中国',city:'上海',
    birthday:{calendar:'solar',month:5,day:16}}});
  assert.equal((await f.ok('owner','account.profile.get')).profile.name,'本人确认的姓名');
  assert.equal((await f.ok('owner','person.get',{circleId:classmates.id,personId:second.id})).person.name,'本人确认的姓名');
  assert.equal((await f.ok('owner','account.profile.get')).profile.phone,undefined);
});

test('新建另一份记录的本人资料不会恢复已主动清空的字段', async () => {
  const f = fixture();
  const first = await f.create('owner');
  await f.ok('owner','person.create',{circleId:first.id,name:'本人',nickname:'旧昵称',claimSelf:true});
  await f.ok('owner','account.profile.update',{patch:{nickname:null,province:null,latitude:null,longitude:null}});
  const second = await f.create('owner');
  const card = (await f.ok('owner','person.create',{circleId:second.id,name:'旧姓名',nickname:'旧昵称',claimSelf:true})).person;
  const profile = (await f.ok('owner','account.profile.get')).profile;
  assert.equal(profile.nickname,undefined);
  assert.equal(profile.province,undefined);
  assert.equal(profile.latitude,undefined);
  assert.equal(profile.longitude,undefined);
  assert.equal(card.name,'本人');
  assert.equal(card.nickname,undefined);
  assert.equal(card.province,undefined);
});

test('加入申请只采用账号资料，客户端重复提交的姓名城市生日无效', async () => {
  const f = fixture();
  const circle = await f.create('owner');
  const invite = (await f.ok('owner','invite.create',{circleId:circle.id})).invite;
  const forged = {token:invite.token,name:'冒名',profile:{country:'中国',city:'假城市',birthday:{calendar:'solar',month:1,day:1}}};
  const before = await f.api.invoke({action:'invite.apply',payload:forged},'applicant');
  assert.equal(before.ok,false);
  assert.equal(before.error.code,'PROFILE_INCOMPLETE');
  await f.ok('applicant','account.profile.update',{patch:{name:'真实姓名',country:'中国',city:'南京',
    birthday:{calendar:'lunar',month:8,day:15}}});
  const response = await f.api.invoke({action:'invite.apply',payload:forged},'applicant');
  assert.equal(response.ok,true,JSON.stringify(response));
  assert.equal(response.data.application.name,'真实姓名');
  assert.equal(response.data.application.profile.city,'南京');
  assert.deepEqual(response.data.application.profile.birthday,{calendar:'lunar',month:8,day:15});
});

test('申请后修改唯一资料，管理员看到当前资料，旧审核版本不能误绑预录卡', async () => {
  const f = fixture();
  const circle = await f.create('owner');
  const card = (await f.ok('owner','person.create',{circleId:circle.id,name:'预录申请人'})).person;
  const invite = (await f.ok('owner','invite.create',{circleId:circle.id})).invite;
  const application = (await f.ok('applicant','invite.apply',{token:invite.token,name:'旧姓名'})).application;
  const oldReview = (await f.ok('owner','join.list',{circleId:circle.id})).applications[0];
  assert.equal(oldReview.profileChanged,false);
  assert.equal(oldReview.name,'旧姓名');
  await f.ok('applicant','account.profile.update',{patch:{name:'新姓名',country:'中国',city:'南京',
    birthday:{calendar:'lunar',month:8,day:15}}});
  await f.denied('owner','join.approve',{circleId:circle.id,applicationId:application.id,
    targetPersonId:card.id,reviewToken:oldReview.reviewToken},'PROFILE_CHANGED');
  assert.equal((await f.ok('owner','invite.list',{circleId:circle.id})).invites[0].status,'active');
  assert.equal((await f.ok('owner','person.get',{circleId:circle.id,personId:card.id})).person.isClaimed,false);
  const currentReview = (await f.ok('owner','join.list',{circleId:circle.id})).applications[0];
  assert.equal(currentReview.name,'新姓名');
  assert.equal(currentReview.profile.city,'南京');
  assert.deepEqual(currentReview.profile.birthday,{calendar:'lunar',month:8,day:15});
  assert.equal(currentReview.profileChanged,true);
  assert.notEqual(currentReview.reviewToken,oldReview.reviewToken);
  await f.denied('owner','join.approve',{circleId:circle.id,applicationId:application.id,targetPersonId:card.id},'PROFILE_CHANGED');
  await f.ok('owner','join.approve',{circleId:circle.id,applicationId:application.id,
    targetPersonId:card.id,reviewToken:currentReview.reviewToken});
  const linked = (await f.ok('owner','person.get',{circleId:circle.id,personId:card.id})).person;
  assert.equal(linked.name,'新姓名');
  assert.equal(linked.city,'南京');
  assert.deepEqual(linked.birthday,{calendar:'lunar',month:8,day:15});
  assert.equal((await f.ok('owner','member.list',{circleId:circle.id})).members.find(member=>!member.isSelf).name,'新姓名');
});

test('首次登录无人物卡也能填写资料上传头像，之后所有本人卡共用照片', async () => {
  const f = fixture();
  const before = await f.ok('newcomer','account.profile.get');
  assert.equal(before.profile,null);
  const reservation = await f.api.reservePhotoUpload({},'newcomer');
  assert.equal(reservation.ok,true,JSON.stringify(reservation));
  assert.equal(reservation.data.accountProfile,true);
  const fileID = `cloud://env.bucket/${reservation.data.cloudPath}`;
  const bound = await f.api.bindUploadedPhoto({fileID},'newcomer');
  assert.equal(bound.ok,true,JSON.stringify(bound));
  assert.equal(bound.data.profile.hasPhoto,true);
  await f.denied('newcomer','account.profile.update',{patch:{photoFileId:'cloud://bad'}},'INVALID_INPUT');
  await f.denied('newcomer','account.profile.update',{patch:{birthOrder:1}},'INVALID_INPUT');
  await f.ok('newcomer','account.profile.update',{patch:{name:'新人',country:'中国',city:'杭州',birthday:{calendar:'solar',month:6,day:1}}});
  const circle = await f.create('newcomer');
  const card = (await f.ok('newcomer','person.create',{circleId:circle.id,name:'新人',claimSelf:true})).person;
  const self = (await f.ok('newcomer','person.get',{circleId:circle.id,personId:card.id})).person;
  assert.equal(self.hasPhoto,true);
  const apiWithSigner = new ApiService(f.repo,()=>1_800_000_000_000,async path => `signed:${path}`);
  const ownUrl = await apiWithSigner.invoke({action:'photo.url',payload:{}},'newcomer');
  const circleUrl = await apiWithSigner.invoke({action:'photo.url',payload:{circleId:circle.id,personId:card.id}},'newcomer');
  assert.equal(ownUrl.ok,true,JSON.stringify(ownUrl));
  assert.equal(circleUrl.ok,true,JSON.stringify(circleUrl));
  assert.equal(ownUrl.data.url,`signed:${fileID}`);
  assert.equal(circleUrl.data.url,`signed:${fileID}`);
  assert.equal((await apiWithSigner.invoke({action:'photo.url',payload:{}},'outsider')).ok,false);
});

test('预录资料补齐账号空项时不把其他城市的坐标带进来', async () => {
  const f = fixture();
  const circle = await f.create('admin');
  await f.ok('user','account.profile.update',{patch:{name:'账号姓名',country:'中国',city:'上海',birthday:{calendar:'solar',month:3,day:3}}});
  await f.legacyMember(circle.id, 'user');
  const card = (await f.ok('admin','person.create',{circleId:circle.id,name:'本人',country:'中国',province:'北京',city:'北京',
    latitude:39.9,longitude:116.4,birthday:{calendar:'solar',month:4,day:2},matchPhone:'13800138008'})).person;
  const linked = await f.api.linkVerifiedPhone('user','13800138008');
  assert.equal(linked.ok,true,JSON.stringify(linked));
  assert.deepEqual(linked.data.linked.map(item=>item.personId),[card.id]);
  const profile = (await f.ok('user','account.profile.get')).profile;
  assert.equal(profile.matchPhone,undefined);
  assert.equal(profile.city,'上海');
  assert.equal(profile.latitude,undefined);
  assert.equal(profile.longitude,undefined);
  assert.equal(profile.name,'账号姓名');
  assert.deepEqual(profile.birthday,{calendar:'solar',month:3,day:3});
  assert.equal(profile.profileComplete,true);
});

test('管理员无需字段授权即可更正本录生日，撤销旧授权不影响管理员职责', async () => {
  const f = fixture();
  const circle = await f.create();
  const card = (await f.ok('owner','person.create',{circleId:circle.id,name:'长辈',country:'中国',city:'苏州',birthday:{calendar:'lunar',month:3,day:3},claimSelf:true})).person;
  const helper = await f.join('owner','helper',circle.id);
  await f.ok('owner','member.setRole',{circleId:circle.id,memberId:helper.id,role:'admin'});
  await f.ok('helper','person.update',{circleId:circle.id,personId:card.id,patch:{birthday:{calendar:'solar',month:3,day:3}}});
  const delegation = (await f.ok('owner','delegation.grant',{circleId:circle.id,personId:card.id,adminMemberId:helper.id,fields:['birthday']})).delegation;
  await f.ok('helper','person.update',{circleId:circle.id,personId:card.id,patch:{birthday:{calendar:'solar',month:3,day:3}}});
  assert.deepEqual((await f.ok('owner','person.get',{circleId:circle.id,personId:card.id})).person.birthday,{calendar:'solar',month:3,day:3});
  await f.ok('owner','delegation.revoke',{circleId:circle.id,delegationId:delegation.id});
  await f.ok('helper','person.update',{circleId:circle.id,personId:card.id,patch:{birthday:{calendar:'solar',month:4,day:3}}});
  assert.deepEqual((await f.ok('owner','account.profile.get')).profile.birthday,{calendar:'lunar',month:3,day:3});
});

test('管理员预录手机号只用于私下匹配，同圈重复号码被拒且可更正', async () => {
  const f = fixture();
  const circle = await f.create();
  await f.join('owner', 'member', circle.id);
  const card = (await f.ok('owner', 'person.create', {circleId:circle.id,name:'预录成员',matchPhone:'138 0013 8000'})).person;
  assert.equal(card.matchPhone, undefined);
  assert.equal(card.phone, undefined);
  assert.equal((await f.ok('member','person.get',{circleId:circle.id,personId:card.id})).person.matchPhone,undefined);
  assert.equal((await f.ok('member','person.list',{circleId:circle.id})).persons.find(row=>row.id===card.id).matchPhone,undefined);
  assert.equal((await f.ok('owner','person.matchPhone',{circleId:circle.id,personId:card.id})).matchPhone,'+8613800138000');
  await f.denied('member','person.matchPhone',{circleId:circle.id,personId:card.id},'FORBIDDEN');
  await f.denied('member','person.create',{circleId:circle.id,name:'假卡',claimSelf:true,matchPhone:'13800138001'},'FORBIDDEN');
  await f.denied('owner','person.create',{circleId:circle.id,name:'重复',matchPhone:'+8613800138000'},'PHONE_ALREADY_USED');
  await f.denied('owner','person.update',{circleId:circle.id,personId:card.id,patch:{matchPhone:'13800138002'}},'INVALID_INPUT');
  await f.ok('owner','person.update',{circleId:circle.id,personId:card.id,patch:{},matchPhone:'13800138001'});
  assert.equal((await f.ok('owner','person.matchPhone',{circleId:circle.id,personId:card.id})).matchPhone,'+8613800138001');
  await f.ok('owner','person.create',{circleId:circle.id,name:'旧号可重用',matchPhone:'13800138000'});
  await f.ok('owner','person.update',{circleId:circle.id,personId:card.id,patch:{},matchPhone:null});
  assert.equal((await f.ok('owner','person.matchPhone',{circleId:circle.id,personId:card.id})).matchPhone,undefined);
  const parallel = await Promise.all([
    f.call('owner','person.create',{circleId:circle.id,name:'并发甲',matchPhone:'13800138002'}),
    f.call('owner','person.create',{circleId:circle.id,name:'并发乙',matchPhone:'+8613800138002'})
  ]);
  assert.deepEqual(parallel.map(row=>row.ok).sort(),[false,true]);
  assert.equal(parallel.find(row=>!row.ok).error.code,'PHONE_ALREADY_USED');
});

test('微信验证手机号只关联已加入的记录，陌生记录与已退出记录仍不可见', async () => {
  const f = fixture();
  const family = await f.create('familyOwner');
  const classmates = await f.create('classOwner','classmate');
  const privateCircle = await f.create('privateOwner','family','private');
  const make = (owner, circle, name) => f.ok(owner,'person.create',{circleId:circle.id,name,matchPhone:'13800138000'});
  const familyCard = (await make('familyOwner',family,'家人')).person;
  const classCard = (await make('classOwner',classmates,'同学')).person;
  const privateCard = (await make('privateOwner',privateCircle,'私人圈')).person;
  await f.legacyMember(family.id, 'user');
  await f.legacyMember(classmates.id, 'user');
  assert.equal((await f.call('user','account.verifyPhone',{phone:'13800138000'})).error.code,'UNKNOWN_ACTION');
  assert.deepEqual((await f.ok('user','account.sync',{phone:'13800138000',verifiedPhone:'13800138000'})).linked,[]);
  const first = await f.api.linkVerifiedPhone('user','+8613800138000');
  assert.equal(first.ok,true,JSON.stringify(first));
  assert.deepEqual(first.data.linked.map(row=>row.personId).sort(),[familyCard.id,classCard.id].sort());
  assert.equal(first.data.skipped,1);
  assert.deepEqual((await f.ok('user','circle.list')).circles.map(row=>row.id).sort(),[family.id,classmates.id].sort());
  for (const [circle,card] of [[family,familyCard],[classmates,classCard]]) {
    assert.equal((await f.ok('user','person.get',{circleId:circle.id,personId:card.id})).person.isSelf,true);
    assert.equal((await f.ok(circle.id===family.id?'familyOwner':'classOwner','person.matchPhone',{circleId:circle.id,personId:card.id})).matchPhone,undefined);
  }
  assert.deepEqual((await f.ok('user','account.sync')).linked,[]);
  await f.ok('privateOwner','circle.upgrade',{circleId:privateCircle.id,privacyReviewed:true});
  assert.deepEqual((await f.ok('user','account.sync')).linked,[]);
  await f.legacyMember(privateCircle.id, 'user');
  assert.deepEqual((await f.ok('user','account.sync')).linked.map(row=>row.personId),[privateCard.id]);
  const future = await f.create('futureOwner');
  const futureCard = (await make('futureOwner',future,'后来预录')).person;
  assert.deepEqual((await f.ok('user','account.sync')).linked,[]);
  await f.legacyMember(future.id, 'user');
  assert.deepEqual((await f.ok('user','account.sync')).linked.map(row=>row.personId),[futureCard.id]);
  f.advance(91*24*60*60*1000);
  const later = await f.create('anotherOwner');
  await make('anotherOwner',later,'新资料');
  assert.equal((await f.ok('user','account.sync')).hasVerifiedPhone,false);
  assert.equal((await f.ok('user','circle.list')).circles.some(row=>row.id===later.id),false);
  assert.equal((await f.api.linkVerifiedPhone('user','13800138000')).ok,true);
  assert.equal((await f.ok('user','circle.list')).circles.some(row=>row.id===later.id),false);
});

test('管理员更正仅作用本录，照片城市生日不串录，本人重填和清空后旧覆盖不复活', async () => {
  const f = fixture();
  const a = await f.create('adminA');
  const b = await f.create('adminB');
  const aCard = (await f.ok('adminA','person.create',{circleId:a.id,name:'原卡'})).person;
  const bCard = (await f.ok('adminB','person.create',{circleId:b.id,name:'原卡'})).person;
  await f.join('adminA','person',a.id,aCard.id);
  await f.join('adminB','person',b.id,bCard.id);
  await f.ok('person','account.profile.update',{patch:{phone:'本人号码'}});
  const original = (await f.ok('person','account.profile.get')).profile;
  await f.ok('adminA','person.update',{circleId:a.id,personId:aCard.id,patch:{city:'苏州',
    birthday:{calendar:'solar',month:2,day:3},phone:'本录更正号码'}});
  assert.equal((await f.ok('adminA','person.get',{circleId:a.id,personId:aCard.id})).person.city,'苏州');
  assert.equal((await f.ok('adminA','person.list',{circleId:a.id})).persons[0].phone,'本录更正号码');
  assert.equal((await f.ok('adminB','person.get',{circleId:b.id,personId:bCard.id})).person.city,original.city);
  assert.equal((await f.ok('adminB','person.get',{circleId:b.id,personId:bCard.id})).person.phone,'本人号码');
  assert.equal((await f.ok('person','account.profile.get')).profile.city,original.city);
  assert.equal((await f.ok('person','account.profile.get')).profile.phone,'本人号码');
  const aBirthday = (await f.ok('adminA','birthday.upcoming',{circleId:a.id,days:366})).events.find(row=>row.personId===aCard.id);
  const bBirthday = (await f.ok('adminB','birthday.upcoming',{circleId:b.id,days:366})).events.find(row=>row.personId===bCard.id);
  assert.match(aBirthday.birthdayText,/2月3日/);
  assert.match(bBirthday.birthdayText,/5月16日/);
  await stagePhoto(f.api,'adminA',a.id,aCard.id);
  assert.equal((await f.ok('adminA','person.get',{circleId:a.id,personId:aCard.id})).person.hasPhoto,true);
  assert.equal((await f.ok('adminB','person.get',{circleId:b.id,personId:bCard.id})).person.hasPhoto,false);
  assert.equal((await f.ok('person','account.profile.get')).profile.hasPhoto,false);
  const signed = new ApiService(f.repo,Date.now,async fileId=>`signed:${fileId}`);
  assert.equal((await signed.invoke({action:'photo.url',payload:{circleId:a.id,personId:aCard.id}},'adminA')).ok,true);
  assert.equal((await signed.invoke({action:'photo.url',payload:{circleId:b.id,personId:bCard.id}},'adminB')).ok,false);
  await f.ok('person','account.profile.update',{patch:{city:'南京',phone:'新号码'}});
  await f.ok('person','account.profile.update',{patch:{city:original.city,phone:null}});
  const refreshed = (await f.ok('adminA','person.get',{circleId:a.id,personId:aCard.id})).person;
  assert.equal(refreshed.city,original.city,'A→B→A must not revive the old correction');
  assert.equal(refreshed.phone,undefined,'cleared account contact must not revive an older card value');
  await f.ok('adminA','person.unclaim',{circleId:a.id,personId:aCard.id,reasonCode:'wrong_person'});
  const raw = await f.repo.atomic(tx=>tx.get('persons',aCard.id));
  assert.equal(raw.profileOverrides,undefined);
});

test('仅知道手机号的管理员不能自动把陌生账号拉进记录或读取其账号资料', async () => {
  const f = fixture();
  const circle = await f.create('attacker');
  const card = (await f.ok('attacker','person.create',{circleId:circle.id,name:'预录人',
    matchPhone:'13800138000'})).person;
  await f.ok('attacker','person.update',{circleId:circle.id,personId:card.id,patch:{phone:'管理员猜的号码'}});
  await f.ok('victim','account.profile.update',{patch:{name:'本人',country:'中国',city:'南京',
    birthday:{calendar:'solar',month:4,day:8},phone:'真实私密号码'}});
  const verified = await f.api.linkVerifiedPhone('victim','13800138000');
  assert.equal(verified.ok,true);
  assert.deepEqual(verified.data.linked,[]);
  assert.deepEqual((await f.ok('victim','circle.list')).circles,[]);
  await f.denied('victim','person.list',{circleId:circle.id},'FORBIDDEN');
  assert.equal((await f.ok('victim','account.profile.get')).profile.phone,'真实私密号码');
  assert.equal((await f.ok('attacker','person.get',{circleId:circle.id,personId:card.id})).person.phone,'管理员猜的号码');
  const invite = (await f.ok('attacker','invite.create',{circleId:circle.id})).invite;
  const application = (await f.ok('victim','invite.apply',{token:invite.token,name:'本人'})).application;
  const snapshot = (await f.ok('attacker','person.get',{circleId:circle.id,personId:card.id})).person.updatedAt;
  const missingVersion = await f.api.invoke({action:'join.approve',payload:{circleId:circle.id,
    applicationId:application.id,targetPersonId:card.id}},'attacker');
  assert.equal(missingVersion.error.code,'TARGET_CHANGED');
  await f.ok('attacker','person.update',{circleId:circle.id,personId:card.id,patch:{city:'杭州'}});
  const stale = await f.api.invoke({action:'join.approve',payload:{circleId:circle.id,applicationId:application.id,
    targetPersonId:card.id,targetPersonUpdatedAt:snapshot}},'attacker');
  assert.equal(stale.error.code,'TARGET_CHANGED');
  const current = (await f.ok('attacker','person.get',{circleId:circle.id,personId:card.id})).person.updatedAt;
  await f.api.linkVerifiedPhone('victim','13800138001');
  await f.denied('attacker','join.approve',{circleId:circle.id,applicationId:application.id,
    targetPersonId:card.id,targetPersonUpdatedAt:current},'PHONE_MISMATCH');
  await f.api.linkVerifiedPhone('victim','13800138000');
  await f.ok('attacker','join.approve',{circleId:circle.id,applicationId:application.id,
    targetPersonId:card.id,targetPersonUpdatedAt:current});
  assert.equal((await f.ok('victim','account.profile.get')).profile.phone,'真实私密号码');
  assert.equal((await f.ok('attacker','person.get',{circleId:circle.id,personId:card.id})).person.phone,'真实私密号码');
});

test('解绑仅上级管理员可操作且不能自审认领，普通资料更正仍可直达', async () => {
  const f = fixture();
  const circle = await f.create('owner');
  const ownerCard = (await f.ok('owner','person.create',{circleId:circle.id,name:'创建者',claimSelf:true})).person;
  const aCard = (await f.ok('owner','person.create',{circleId:circle.id,name:'管理员甲'})).person;
  const bCard = (await f.ok('owner','person.create',{circleId:circle.id,name:'管理员乙'})).person;
  const aMember = await f.join('owner','adminA',circle.id,aCard.id);
  const bMember = await f.join('owner','adminB',circle.id,bCard.id);
  await f.ok('owner','member.setRole',{circleId:circle.id,memberId:aMember.id,role:'admin'});
  await f.ok('owner','member.setRole',{circleId:circle.id,memberId:bMember.id,role:'admin'});
  await f.denied('adminA','person.unclaim',{circleId:circle.id,personId:ownerCard.id},'FORBIDDEN');
  await f.denied('adminA','person.unclaim',{circleId:circle.id,personId:bCard.id},'FORBIDDEN');
  await f.denied('adminA','person.unclaim',{circleId:circle.id,personId:aCard.id},'FORBIDDEN');
  await f.ok('adminA','person.update',{circleId:circle.id,personId:ownerCard.id,patch:{nickname:'称呼更正'}});
  assert.equal((await f.ok('owner','account.profile.get')).profile.nickname,undefined);
  assert.equal((await f.ok('owner','person.get',{circleId:circle.id,personId:ownerCard.id})).person.nickname,'称呼更正');
  await f.ok('owner','person.unclaim',{circleId:circle.id,personId:bCard.id,reasonCode:'wrong_person'});
  const request = (await f.ok('adminB','person.claim',{circleId:circle.id,personId:bCard.id})).claimRequest;
  await f.denied('adminB','person.claimApprove',{circleId:circle.id,claimRequestId:request.id},'FORBIDDEN');
  await f.ok('owner','person.claimApprove',{circleId:circle.id,claimRequestId:request.id});
});

test('管理员明确批准的认领或入圈会清除旧手机号匹配，防止别人再关联', async () => {
  const f = fixture();
  const circle = await f.create();
  await f.join('owner','member',circle.id);
  await f.api.linkVerifiedPhone('member','13800138000');
  const card = (await f.ok('owner','person.create',{circleId:circle.id,name:'候选',matchPhone:'13800138000'})).person;
  const request = (await f.ok('member','person.claim',{circleId:circle.id,personId:card.id})).claimRequest;
  await f.ok('owner','person.claimApprove',{circleId:circle.id,claimRequestId:request.id});
  assert.equal((await f.ok('owner','person.matchPhone',{circleId:circle.id,personId:card.id})).matchPhone,undefined);
  assert.deepEqual((await f.api.linkVerifiedPhone('intruder','13800138000')).data.linked,[]);
  const otherCircle = await f.create('anotherOwner');
  const otherCard = (await f.ok('anotherOwner','person.create',{circleId:otherCircle.id,name:'另一候选',matchPhone:'13800138001'})).person;
  const invite = (await f.ok('anotherOwner','invite.create',{circleId:otherCircle.id})).invite;
  const application = (await f.ok('newMember','invite.apply',{token:invite.token,name:'新成员'})).application;
  await f.api.linkVerifiedPhone('newMember','13800138001');
  await f.ok('anotherOwner','join.approve',{circleId:otherCircle.id,applicationId:application.id,targetPersonId:otherCard.id});
  assert.equal((await f.ok('anotherOwner','person.matchPhone',{circleId:otherCircle.id,personId:otherCard.id})).matchPhone,undefined);
  assert.deepEqual((await f.api.linkVerifiedPhone('intruder','13800138001')).data.linked,[]);
});

test('已有本人卡、已移除成员和重复申请不会被手机号匹配绕过', async () => {
  const f = fixture();
  const activeCircle = await f.create('owner');
  const existing = await f.join('owner','existing',activeCircle.id);
  assert.equal(existing.personId,undefined);
  const card = (await f.ok('owner','person.create',{circleId:activeCircle.id,name:'已有成员',matchPhone:'13800138000'})).person;
  const wrongCard = (await f.ok('owner','person.create',{circleId:activeCircle.id,name:'误选的人'})).person;
  const pending = (await f.ok('existing','person.claim',{circleId:activeCircle.id,personId:wrongCard.id})).claimRequest;
  const linked = await f.api.linkVerifiedPhone('existing','13800138000');
  assert.equal(linked.ok,true);
  assert.deepEqual(linked.data.linked.map(row=>row.personId),[card.id]);
  assert.equal((await f.ok('owner','member.list',{circleId:activeCircle.id})).members.find(row=>row.id===existing.id).personId,card.id);
  assert.equal((await f.ok('existing','person.claimMine',{circleId:activeCircle.id})).claimRequests.find(row=>row.id===pending.id).status,'rejected');
  const conflictCircle = await f.create('otherOwner');
  await f.join('otherOwner','existing',conflictCircle.id);
  const self = (await f.ok('existing','person.create',{circleId:conflictCircle.id,name:'本人',claimSelf:true})).person;
  const conflicting = (await f.ok('otherOwner','person.create',{circleId:conflictCircle.id,name:'另一张卡',matchPhone:'13800138000'})).person;
  assert.deepEqual((await f.ok('existing','account.sync')).linked,[]);
  assert.equal((await f.ok('existing','person.get',{circleId:conflictCircle.id,personId:self.id})).person.isSelf,true);
  assert.equal((await f.ok('existing','person.get',{circleId:conflictCircle.id,personId:conflicting.id})).person.isClaimed,false);
  await f.ok('owner','member.remove',{circleId:activeCircle.id,memberId:existing.id});
  assert.deepEqual((await f.ok('existing','account.sync')).linked,[]);
  await f.denied('existing','person.get',{circleId:activeCircle.id,personId:card.id},'FORBIDDEN');
  assert.equal((await f.ok('owner','person.matchPhone',{circleId:activeCircle.id,personId:card.id})).matchPhone,undefined);
});

test('旧数据成员丢失 personId 但已有本人卡时，手机号匹配不会再认领第二张', async () => {
  const f = fixture();
  const circle = await f.create();
  const member = await f.join('owner','legacyMember',circle.id);
  const oldCard = (await f.ok('owner','person.create',{circleId:circle.id,name:'原本人卡'})).person;
  const matchingCard = (await f.ok('owner','person.create',{circleId:circle.id,name:'另一张预录卡',matchPhone:'13800138000'})).person;
  await f.repo.atomic(async tx => {
    const row = await tx.get('persons',oldCard.id);
    row.claimedBy = 'legacyMember';
    await tx.put('persons',row);
  });
  const response = await f.api.linkVerifiedPhone('legacyMember','13800138000');
  assert.equal(response.ok,true,JSON.stringify(response));
  assert.deepEqual(response.data.linked,[]);
  assert.equal((await f.ok('owner','member.list',{circleId:circle.id})).members.find(row=>row.id===member.id).personId,undefined);
  assert.equal((await f.ok('legacyMember','person.get',{circleId:circle.id,personId:oldCard.id})).person.isSelf,true);
  assert.equal((await f.ok('legacyMember','person.get',{circleId:circle.id,personId:matchingCard.id})).person.isClaimed,false);
});

test('云函数手机号换取只接受微信 code 和可信响应，不返回号码', async () => {
  const f = fixture();
  const circle = await f.create();
  const card = (await f.ok('owner','person.create',{circleId:circle.id,name:'张同学',matchPhone:'13800138000'})).person;
  const validCloud = {openapi:{phonenumber:{getPhoneNumber:async ({code}) => {
    assert.equal(code,'one-time-code');
    return {errCode:0,phoneInfo:{countryCode:'86',purePhoneNumber:'13800138000',watermark:{appid:'wx-test'}}};
  }}}};
  assert.equal((await handlePhoneVerify({payload:{code:'one-time-code'}},undefined,'wx-test',f.api,validCloud)).error.code,'UNAUTHENTICATED');
  assert.equal((await handlePhoneVerify({payload:{phone:'13800138000'}},'user','wx-test',f.api,validCloud)).error.code,'INVALID_INPUT');
  assert.equal((await handlePhoneVerify({payload:{code:'one-time-code'}},'user','wx-test',f.api,{})).error.code,'NOT_CONFIGURED');
  const forgedCloud = {openapi:{phonenumber:{getPhoneNumber:async () => ({errCode:0,phoneInfo:{countryCode:'86',purePhoneNumber:'13800138000',watermark:{appid:'other-app'}}})}}};
  assert.equal((await handlePhoneVerify({payload:{code:'one-time-code'}},'user','wx-test',f.api,forgedCloud)).error.code,'PHONE_VERIFY_FAILED');
  assert.equal((await f.ok('user','circle.list')).circles.length,0);
  const response = await handlePhoneVerify({payload:{code:'one-time-code'}},'user','wx-test',f.api,validCloud);
  assert.equal(response.ok,true,JSON.stringify(response));
  assert.deepEqual(response.data.linked,[]);
  assert.equal((await f.ok('user','circle.list')).circles.length,0);
  assert.equal(JSON.stringify(response).includes('13800138000'),false);
});
