const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

// Load the same TypeScript modules used by WeChat without a second build tree.
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018 } }).outputText;
  module._compile(output, filename);
};

const storage = new Map();
global.wx = {
  getStorageSync: key => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  showToast: () => {}
};

const { groupCities } = require('../utils/geography.ts');
const { relationshipFor } = require('../utils/relationship.ts');
const { invoke, resetDemoData, setDemoMode, isDemoMode, resolvePhotoUrls, setDemoActor } = require('../services/api.ts');
const completeProfile = {country: '中国', province: '上海', city: '上海', birthday: {calendar: 'solar', month: 10, day: 8}};
async function loginDemoApplicant(actor, name, profile = completeProfile) {
  assert.equal(setDemoActor(actor), true);
  assert.equal((await invoke({action: 'account.verifyPhone', payload: {code: 'demo-verified-phone'}})).ok, true);
  assert.equal((await invoke({action: 'account.profile.update', payload: {patch: {name, ...profile}}})).ok, true);
}

test('selecting a star leaves a hand-scrolled graph at its current position', () => {
  const previousComponent = global.Component;
  let definition;
  try {
    global.Component = options => {definition = options;};
    delete require.cache[require.resolve('../components/star-network/index.ts')];
    require('../components/star-network/index.ts');
    const patches = [];
    const component = {
      properties: {persons: [{id: 'a', name: '甲'}, {id: 'b', name: '乙'}], relations: [], focusId: 'a', selfId: 'a', selectedId: '', relationLabels: {}},
      data: {},
      setData(patch) {patches.push(patch); Object.assign(this.data, patch);},
      ...definition.methods
    };
    component.relayout();
    assert.equal(typeof patches[0].scrollTop, 'number');
    component.properties.selectedId = 'b';
    component.relayout();
    assert.equal(patches[1].scrollTop, undefined);
    assert.equal(patches[1].scrollLeft, undefined);
    assert.equal(component.data.nodes.find(node => node.id === 'b').isSelected, true);
  } finally {global.Component = previousComponent;}
});

test('city grouping uses visible city data and keeps China/world totals aligned', () => {
  const people = [
    { id: 'a', name: '甲', city: '上海', country: '中国' },
    { id: 'b', name: '乙', city: '上海', country: '中国' },
    { id: 'c', name: '丙', city: '伦敦', country: '英国' },
    { id: 'd', name: '丁', city: '多伦多', country: '加拿大' },
    { id: 'e', name: '戊' },
    { id: 'f', name: '己', city: '奥斯陆', country: '挪威' }
  ];
  const china = groupCities(people, 'china');
  assert.equal(china.groups.length, 1);
  assert.equal(china.groups[0].city, '上海');
  assert.equal(china.groups[0].count, 2);
  assert.equal(china.overseas, 3);
  const world = groupCities(people, 'world');
  assert.equal(world.groups.reduce((sum, group) => sum + group.count, 0), 4);
  assert.equal(world.unmapped, 1);
  assert.ok(world.groups.every(group => !group.persons.some(person => person.id === 'e')));
});

test('demo API keeps family and class cards separate and shows circle member details', async () => {
  resetDemoData();
  const family = await invoke({ action: 'person.list', payload: { circleId: 'family_demo' } });
  const classmates = await invoke({ action: 'person.list', payload: { circleId: 'class_demo' } });
  assert.equal(family.ok, true); assert.equal(classmates.ok, true);
  assert.ok(family.data.persons.every(person => person.circleId === 'family_demo'));
  assert.ok(classmates.data.persons.every(person => person.circleId === 'class_demo'));
  assert.equal(family.data.persons.find(person => person.id === 'f_uncle').city, '广州');
  assert.equal(family.data.persons.find(person => person.id === 'f_aunt').city, '旧金山');
  assert.equal(family.data.persons.find(person => person.id === 'f_dad').phone, undefined);
  assert.equal(family.data.persons.find(person => person.id === 'f_me').phone, '13800000000');
  assert.deepEqual([classmates.data.persons.find(person => person.id === 'c_wang').latitude, classmates.data.persons.find(person => person.id === 'c_wang').longitude], [51.5, -0.1]);
});

test('demo phone verification cannot silently open an unfamiliar record', async () => {
  resetDemoData();
  assert.equal((await invoke({action: 'circle.list'})).data.circles.length, 2);
  const spoof = await invoke({action: 'account.verifyPhone', payload: {code: 'made-up', phone: '+8613800138000'}});
  assert.equal(spoof.ok, false);
  assert.equal((await invoke({action: 'circle.list'})).data.circles.length, 2);
  const verified = await invoke({action: 'account.verifyPhone', payload: {code: 'demo-verified-phone', phone: '+8613900000000'}});
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.data.linked, []);
  assert.equal(JSON.stringify(verified).includes('13800138000'), false);
  assert.equal((await invoke({action: 'circle.list'})).data.circles.length, 2);
  const person = await invoke({action: 'person.get', payload: {circleId: 'phone_demo', personId: 'phone_demo_me'}});
  assert.equal(person.ok, false);
  assert.equal(person.error.code, 'FORBIDDEN');
  assert.deepEqual((await invoke({action: 'account.sync'})).data.linked, []);
  resetDemoData();
});

test('a matching number stays private and never grants access to an unfamiliar record', async () => {
  resetDemoData();
  const createdCircle = await invoke({action: 'circle.create', payload: {type: 'family', name: '新家庭圈', mode: 'shared'}});
  const circleId = createdCircle.data.circle.id;
  const created = await invoke({action: 'person.create', payload: {circleId, name: '预先录入的人', ...completeProfile, matchPhone: '13700137000'}});
  assert.equal(created.ok, true);
  assert.equal(created.data.person.matchPhone, undefined);
  const number = await invoke({action: 'person.matchPhone', payload: {circleId, personId: created.data.person.id}});
  assert.equal(number.data.matchPhone, '+8613700137000');
  const duplicate = await invoke({action: 'person.create', payload: {circleId, name: '另一个人', ...completeProfile, matchPhone: '13700137000', initialRelation: {anchorPersonId: created.data.person.id, kind: 'sibling'}}});
  assert.equal(duplicate.error.code, 'PHONE_ALREADY_USED');
  const forgedPatch = await invoke({action: 'person.update', payload: {circleId, personId: created.data.person.id, patch: {matchPhone: '+8613900000000'}}});
  assert.equal(forgedPatch.error.code, 'INVALID_INPUT');
  assert.equal(setDemoActor('demo-guest'), true);
  const linked = await invoke({action: 'account.verifyPhone', payload: {code: 'demo-verified-phone'}});
  assert.equal(linked.data.linked.some(item => item.circleId === circleId), false);
  assert.equal((await invoke({action: 'circle.list'})).data.circles.some(circle => circle.id === circleId), false);
  assert.equal((await invoke({action: 'person.get', payload: {circleId, personId: created.data.person.id}})).error.code, 'FORBIDDEN');
  assert.deepEqual((await invoke({action: 'account.sync'})).data.linked, []);
  assert.equal(setDemoActor('demo-owner'), true);
  assert.equal((await invoke({action: 'person.matchPhone', payload: {circleId, personId: created.data.person.id}})).data.matchPhone, '+8613700137000');
  resetDemoData();
});

test('circle members can open a photo without receiving its storage ID or a delegation', async () => {
  resetDemoData();
  const key = 'kin-network-demo-db-v2';
  const db = storage.get(key);
  const person = db.persons.find(item => item.id === 'f_uncle');
  person.photoFileId = 'demo-photo-f_uncle';
  person.photoUrl = '/demo-files/mom.jpg';
  storage.set(key, db);
  const detail = await invoke({action: 'person.get', payload: {circleId: 'family_demo', personId: 'f_uncle'}});
  assert.equal(detail.ok, true);
  assert.equal(detail.data.person.hasPhoto, true);
  assert.equal(detail.data.person.photoFileId, undefined);
  assert.equal(detail.data.person.photoUrl, '/demo-files/mom.jpg');
  const urls = await invoke({action: 'photo.urls', payload: {circleId: 'family_demo', personIds: ['f_uncle']}});
  assert.equal(urls.data.urls.f_uncle, '/demo-files/mom.jpg');
  resetDemoData();
});

test('demo city points are coarse and paired, and removing a member clears their location', async () => {
  resetDemoData();
  const base = {circleId: 'family_demo', personId: 'f_me'};
  const invalid = await invoke({action: 'person.update', payload: {...base, patch: {city: '奥斯陆', latitude: 59.9}}});
  assert.equal(invalid.ok, false);
  const saved = await invoke({action: 'person.update', payload: {...base, patch: {city: '奥斯陆', country: '挪威', latitude: 59.9139, longitude: 10.7522}}});
  assert.equal(saved.ok, true);
  assert.deepEqual([saved.data.person.latitude, saved.data.person.longitude], [59.9, 10.8]);
  const changed = await invoke({action: 'person.update', payload: {...base, patch: {city: '卑尔根'}}});
  assert.equal(changed.ok, true);
  assert.equal(changed.data.person.latitude, undefined);
  assert.equal(changed.data.person.longitude, undefined);
  const key = 'kin-network-demo-db-v2';
  const db = storage.get(key);
  const stranger = db.persons.find(person => person.id === 'c_wang');
  stranger.visibility.city = 'self';
  storage.set(key, db);
  const visible = await invoke({action: 'person.get', payload: {circleId: 'class_demo', personId: 'c_wang'}});
  assert.equal(visible.data.person.city, '伦敦', 'legacy visibility flags no longer hide city from classmates');
  assert.equal(visible.data.person.latitude, 51.5);
  assert.equal(visible.data.person.longitude, -0.1);
  resetDemoData();
  const removed = await invoke({action: 'member.remove', payload: {circleId: 'class_demo', memberId: 'm_c_wang'}});
  assert.equal(removed.ok, true);
  assert.equal(storage.get(key).persons.find(person => person.id === 'c_wang').latitude, undefined);
  assert.equal(storage.get(key).persons.find(person => person.id === 'c_wang').longitude, undefined);
});

test('the shared kinship engine recalculates labels from each perspective', async () => {
  resetDemoData();
  const peopleResult = await invoke({ action: 'person.list', payload: { circleId: 'family_demo' } });
  const relationsResult = await invoke({ action: 'relation.list', payload: { circleId: 'family_demo' } });
  const people = peopleResult.data.persons;
  const relations = relationsResult.data.relations;
  const uncle = relationshipFor(people, relations, 'f_me', 'f_uncle');
  assert.equal(uncle.label, '伯父');
  assert.match(uncle.path, /爸爸.*哥哥/);
  const brother = relationshipFor(people, relations, 'f_dad', 'f_uncle');
  assert.equal(brother.label, '哥哥');
  const aunt = relationshipFor(people, relations, 'f_me', 'f_aunt');
  assert.ok(['姨妈', '大姨'].includes(aunt.label));
  const cousin = relationshipFor(people, relations, 'f_me', 'f_cousin');
  assert.equal(cousin.status, 'pending');
  assert.equal(cousin.label, '堂姐妹');
  assert.match(cousin.path, /爸爸.*哥哥.*女儿/);
  assert.match(cousin.missing, /双方的长幼/);
  const self = relationshipFor(people, relations, 'f_me', 'f_me');
  assert.equal(self.status, 'self');
});

test('one invite can approve only one application, including in demo mode', async () => {
  resetDemoData();
  const created = await invoke({ action: 'invite.create', payload: { circleId: 'family_demo' } });
  assert.equal(created.ok, true);
  const token = created.data.invite.token;
  await loginDemoApplicant('demo-guest', '张晴');
  const prematureClaim = await invoke({ action: 'invite.apply', payload: { token, name: '张晴', profile: completeProfile, claimPersonId: 'f_uncle' } });
  assert.equal(prematureClaim.ok, false);
  const first = await invoke({ action: 'invite.apply', payload: { token, name: '张晴', profile: completeProfile } });
  await loginDemoApplicant('demo-guest-2', '刘安');
  const second = await invoke({ action: 'invite.apply', payload: { token, name: '刘安', profile: completeProfile } });
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  setDemoActor('demo-guest');
  const mine = await invoke({ action: 'join.mine' });
  assert.ok(mine.data.applications.some(application => application.id === first.data.application.id && application.status === 'pending' && application.circleName === '陈家亲友录'));
  const one = await invoke({action: 'join.mine', payload: {applicationId: first.data.application.id}});
  assert.deepEqual(one.data.applications.map(application => application.id), [first.data.application.id]);
  const personCount = storage.get('kin-network-demo-db-v2').persons.length;
  const withPendingClaim = storage.get('kin-network-demo-db-v2');
  withPendingClaim.claimRequests.push({id:'pending-uncle-claim', circleId:'family_demo', personId:'f_uncle', applicantName:'另一位成员', actorId:'someone-else', status:'pending', createdAt:Date.now()});
  storage.set('kin-network-demo-db-v2', withPendingClaim);
  setDemoActor('demo-owner');
  const targetPersonUpdatedAt = withPendingClaim.persons.find(person => person.id === 'f_uncle').updatedAt;
  const blocked = await invoke({ action: 'join.approve', payload: { circleId: 'family_demo', applicationId: first.data.application.id, targetPersonId: 'f_uncle', targetPersonUpdatedAt } });
  assert.equal(blocked.error.code, 'CLAIM_PENDING');
  assert.equal(storage.get('kin-network-demo-db-v2').invites.find(invite => invite.token === token).usedAt, undefined);
  withPendingClaim.claimRequests[0].status = 'rejected';
  storage.set('kin-network-demo-db-v2', withPendingClaim);
  const mixed = await invoke({action: 'join.approve', payload: {circleId: 'family_demo', applicationId: first.data.application.id,
    targetPersonId: 'f_uncle', targetPersonUpdatedAt, initialRelation: {anchorPersonId: 'f_dad', kind: 'newChild'}}});
  assert.equal(mixed.error.code, 'INVALID_INPUT');
  const approved = await invoke({ action: 'join.approve', payload: { circleId: 'family_demo', applicationId: first.data.application.id, targetPersonId: 'f_uncle', targetPersonUpdatedAt } });
  assert.equal(approved.ok, true);
  const db = storage.get('kin-network-demo-db-v2');
  assert.equal(db.persons.length, personCount, 'approval must not create a duplicate card');
  assert.equal(db.members.find(member => member.actorId === 'demo-guest').personId, 'f_uncle');
  assert.equal(db.persons.find(person => person.id === 'f_uncle').birthday.calendar, 'solar');
  assert.ok(db.relations.some(relation => relation.id === 'r5' && relation.from === 'f_uncle' && relation.to === 'f_dad'));
  const replay = await invoke({ action: 'join.approve', payload: { circleId: 'family_demo', applicationId: second.data.application.id } });
  assert.equal(replay.ok, false);
  const preview = await invoke({ action: 'invite.preview', payload: { token } });
  assert.equal(preview.data.status, 'used');
});

test('a rejected demo applicant needs a new invitation and an existing pending request is reused', async () => {
  resetDemoData();
  const created = await invoke({action: 'invite.create', payload: {circleId: 'family_demo'}});
  const token = created.data.invite.token;
  await loginDemoApplicant('demo-guest', '张晴');
  const first = await invoke({action: 'invite.apply', payload: {token, name: '张晴', profile: completeProfile}});
  const repeated = await invoke({action: 'invite.apply', payload: {token, name: '张晴', profile: completeProfile}});
  assert.equal(repeated.data.application.id, first.data.application.id);
  setDemoActor('demo-owner');
  await invoke({action: 'join.reject', payload: {circleId: 'family_demo', applicationId: first.data.application.id}});
  setDemoActor('demo-guest');
  const denied = await invoke({action: 'invite.apply', payload: {token, name: '张晴', profile: completeProfile}});
  assert.equal(denied.error.code, 'APPLICATION_REJECTED');
  setDemoActor('demo-owner');
  const another = await invoke({action: 'invite.create', payload: {circleId: 'family_demo'}});
  setDemoActor('demo-guest');
  assert.equal((await invoke({action: 'invite.apply', payload: {token: another.data.invite.token, name: '张晴', profile: completeProfile}})).ok, true);
  resetDemoData();
});

test('an invited person must provide city and birthday before approval imports a complete card', async () => {
  resetDemoData();
  const circleId = 'family_demo';
  const created = await invoke({action: 'invite.create', payload: {circleId}});
  const token = created.data.invite.token;
  setDemoActor('demo-guest');
  await invoke({action: 'account.verifyPhone', payload: {code: 'demo-verified-phone'}});
  await invoke({action: 'account.profile.update', payload: {patch: {name: '新朋友', country: '中国', city: '上海'}}});
  const missingBirthday = await invoke({action: 'invite.apply', payload: {token, name: '新朋友', profile: {country: '中国', city: '上海'}}});
  assert.equal(missingBirthday.error.code, 'PROFILE_INCOMPLETE');
  await invoke({action: 'account.profile.update', payload: {patch: {city: '', birthday: {calendar: 'lunar', month: 8, day: 15}}}});
  const missingCity = await invoke({action: 'invite.apply', payload: {token, name: '新朋友', profile: {birthday: {calendar: 'solar', month: 10, day: 8}}}});
  assert.equal(missingCity.error.code, 'PROFILE_INCOMPLETE');
  assert.equal(storage.get('kin-network-demo-db-v2').applications.length, 0);
  const before = storage.get('kin-network-demo-db-v2').persons.length;
  await invoke({action: 'account.profile.update', payload: {patch: {city: '上海'}}});
  const applied = await invoke({action: 'invite.apply', payload: {token, name: '伪造姓名', profile: {...completeProfile, birthday: {calendar: 'solar', month: 1, day: 1}}}});
  assert.equal(applied.ok, true);
  assert.equal(applied.data.application.applicantName, '新朋友');
  setDemoActor('demo-owner');
  const approved = await invoke({action: 'join.approve', payload: {circleId, applicationId: applied.data.application.id, initialRelation: {anchorPersonId: 'f_me', kind: 'sibling'}}});
  assert.equal(approved.ok, true);
  const db = storage.get('kin-network-demo-db-v2');
  assert.equal(db.persons.length, before + 1);
  const imported = db.persons.find(person => person.name === '新朋友');
  assert.equal(imported.profileComplete, true);
  assert.equal(imported.city, '上海');
  assert.equal(imported.birthday.calendar, 'lunar');
  assert.equal(db.members.find(member => member.personId === imported.id).status, 'joined');
  resetDemoData();
});

test('demo administrator and member cannot create incomplete person cards', async () => {
  resetDemoData();
  const key = 'kin-network-demo-db-v2';
  const before = storage.get(key).persons.length;
  for (const payload of [
    {circleId: 'family_demo', name: '只有姓名'},
    {circleId: 'family_demo', name: '缺少生日', country: '中国', city: '上海'},
    {circleId: 'family_demo', name: '缺少城市', country: '中国', birthday: completeProfile.birthday}
  ]) {
    const result = await invoke({action: 'person.create', payload});
    assert.equal(result.error.code, 'PROFILE_INCOMPLETE');
  }
  const invalid = await invoke({action: 'person.create', payload: {
    circleId: 'family_demo', name: '日期错误', ...completeProfile,
    birthday: {calendar: 'solar', month: 2, day: 30}
  }});
  assert.equal(invalid.error.code, 'INVALID_INPUT');
  assert.equal(storage.get(key).persons.length, before);
  const full = await invoke({action: 'person.create', payload: {circleId: 'family_demo', name: '资料齐全', ...completeProfile, initialRelation: {anchorPersonId: 'f_me', kind: 'sibling'}}});
  assert.equal(full.ok, true);
  assert.equal(full.data.person.profileComplete, true);
  resetDemoData();
});

test('demo suggestions have per-circle pending and rolling daily limits', async () => {
  resetDemoData();
  const created = [];
  for (let i = 0; i < 5; i++) {
    const result = await invoke({action: 'suggestion.create', payload: {circleId: 'family_demo', type: 'person', personId: 'f_me', message: `更正 ${i}`}});
    assert.equal(result.ok, true);
    created.push(result.data.suggestion.id);
  }
  assert.equal((await invoke({action: 'suggestion.create', payload: {circleId: 'family_demo', type: 'person', message: '再来一条'}})).error.code, 'SUGGESTION_PENDING_LIMIT');
  const otherCircle = await invoke({action: 'suggestion.create', payload: {circleId: 'class_demo', type: 'person', message: '另一圈'}});
  assert.equal(otherCircle.ok, true);
  for (const id of created) assert.equal((await invoke({action: 'suggestion.resolve', payload: {circleId: 'family_demo', suggestionId: id, status: 'rejected', resolutionNote: '核对后不采纳'}})).ok, true);
  for (let i = 5; i < 10; i++) {
    const result = await invoke({action: 'suggestion.create', payload: {circleId: 'family_demo', type: 'person', message: `更正 ${i}`}});
    assert.equal(result.ok, true);
    assert.equal((await invoke({action: 'suggestion.resolve', payload: {circleId: 'family_demo', suggestionId: result.data.suggestion.id, status: 'rejected', resolutionNote: '核对后不采纳'}})).ok, true);
  }
  assert.equal((await invoke({action: 'suggestion.create', payload: {circleId: 'family_demo', type: 'person', message: '第十一条'}})).error.code, 'SUGGESTION_DAILY_LIMIT');
  resetDemoData();
});

test('text suggestion can be closed as handled with an audit note without pretending data changed', async () => {
  resetDemoData();
  const circleId = 'family_demo';
  const created = await invoke({action: 'suggestion.create', payload: {circleId, type: 'person', personId: 'f_me', message: '请核对工作城市'}});
  const before = await invoke({action: 'person.get', payload: {circleId, personId: 'f_me'}});
  const missingNote = await invoke({action: 'suggestion.resolve', payload: {circleId, suggestionId: created.data.suggestion.id, status: 'handled'}});
  assert.equal(missingNote.ok, false);
  const handled = await invoke({action: 'suggestion.resolve', payload: {circleId, suggestionId: created.data.suggestion.id, status: 'handled', resolutionNote: '已联系本人核对，资料无需修改'}});
  assert.equal(handled.ok, true);
  assert.equal(handled.data.suggestion.status, 'handled');
  assert.equal(handled.data.suggestion.resolutionNote, '已联系本人核对，资料无需修改');
  const after = await invoke({action: 'person.get', payload: {circleId, personId: 'f_me'}});
  assert.equal(after.data.person.city, before.data.person.city);
  const audits = await invoke({action: 'audit.list', payload: {circleId}});
  assert.ok(audits.data.events.some(event => event.type === 'suggestion.resolve' && event.details?.resolutionNote === '已联系本人核对，资料无需修改'));
  resetDemoData();
});

test('demo relation correction previews impact, blocks conflicts, and applies accepted suggestion', async () => {
  resetDemoData();
  const circleId = 'family_demo';
  const conflict = await invoke({action: 'relation.create', payload: {circleId, from: 'f_dad', to: 'f_me', type: 'spouse'}});
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'RELATION_CONFLICT');
  const cycle = await invoke({action: 'relation.create', payload: {circleId, from: 'f_me', to: 'f_grandma', type: 'parent'}});
  assert.equal(cycle.ok, false);
  assert.equal(cycle.error.code, 'RELATION_CYCLE');

  const relationChange = {removeRelationId: 'r5', relation: {from: 'f_uncle', to: 'f_dad', type: 'sibling'}};
  const preview = await invoke({action: 'relation.preview', payload: {circleId, relationChange}});
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.data.impact.removedRelationIds, ['r5']);
  assert.ok(preview.data.impact.affectedPersonIds.includes('f_me'));
  const suggestion = await invoke({action: 'suggestion.create', payload: {circleId, type: 'relation', message: '长幼顺序待核实', relationChange}});
  assert.equal(suggestion.ok, true);
  const accepted = await invoke({action: 'suggestion.resolve', payload: {circleId, suggestionId: suggestion.data.suggestion.id, status: 'accepted', resolutionNote: '已核实并修正长幼关系'}});
  assert.equal(accepted.ok, true);
  const relations = await invoke({action: 'relation.list', payload: {circleId}});
  assert.ok(!relations.data.relations.some(relation => relation.id === 'r5'));
  assert.ok(relations.data.relations.some(relation => relation.from === 'f_uncle' && relation.to === 'f_dad' && relation.type === 'sibling' && !relation.olderId));
  resetDemoData();
});

test('admin join queue marks an expired invitation before approval', async () => {
  resetDemoData();
  const circleId = 'family_demo';
  const created = await invoke({action: 'invite.create', payload: {circleId}});
  await loginDemoApplicant('demo-guest', '待核对家人');
  const applied = await invoke({action: 'invite.apply', payload: {token: created.data.invite.token, name: '待核对家人', profile: completeProfile}});
  assert.equal(applied.ok, true);
  setDemoActor('demo-owner');
  const db = storage.get('kin-network-demo-db-v2');
  db.invites.find(invite => invite.id === created.data.invite.id).expiresAt = Date.now() - 1;
  storage.set('kin-network-demo-db-v2', db);
  const queue = await invoke({action: 'join.list', payload: {circleId}});
  assert.equal(queue.ok, true);
  assert.equal(queue.data.applications.find(application => application.id === applied.data.application.id).inviteStatus, 'expired');
  const result = await invoke({action: 'join.approve', payload: {circleId, applicationId: applied.data.application.id}});
  assert.equal(result.ok, false);
  resetDemoData();
});

test('new class circles require one specific school, cohort and class', async () => {
  resetDemoData();
  const missing = await invoke({ action: 'circle.create', payload: { type: 'classmate', name: '新班级', mode: 'private' } });
  assert.equal(missing.ok, false);
  const created = await invoke({ action: 'circle.create', payload: { type: 'classmate', name: '新班级', mode: 'private', school: '一中', cohort: '2020 届', className: '三班' } });
  assert.equal(created.ok, true);
  const listed = await invoke({ action: 'circle.list' });
  assert.equal(listed.data.circles.find(circle => circle.id === created.data.circle.id).className, '三班');
});

test('a shared invite opens in cloud mode while an admin demo preview stays local', async () => {
  const config = require('../config.ts');
  config.CLOUD_ENV_ID = 'test-env';
  let cloudCalls = 0;
  let initializedEnv = '';
  wx.cloud = {
    init: options => { initializedEnv = options.env; },
    callFunction: async request => {
      cloudCalls++;
      assert.equal(request.name, 'api');
      if (request.data.action === 'account.sync') return {result: {ok: true, data: {hasVerifiedPhone: false}}};
      assert.equal(request.data.action, 'invite.preview');
      return { result: { ok: true, data: { circle: { id: 'real-circle', name: '真实家人录', type: 'family' }, expiresAt: Date.now() + 10000, status: 'active' } } };
    }
  };
  let definition;
  global.Page = options => { definition = options; };
  require('../pages/apply/index.ts');
  const page = () => ({ ...definition, data: { ...definition.data }, setData(patch) { this.data = { ...this.data, ...patch }; } });
  setDemoMode(true);
  const guest = page();
  await guest.onLoad({ token: 'real-token' });
  assert.equal(isDemoMode(), false);
  assert.equal(initializedEnv, 'test-env');
  assert.equal(cloudCalls, 2);
  assert.equal(guest.data.circle.name, '真实家人录');

  setDemoMode(true);
  const scanned = page();
  await scanned.onLoad({ scene: encodeURIComponent('real-token') });
  assert.equal(scanned.token, 'real-token');
  assert.equal(isDemoMode(), false);
  assert.equal(cloudCalls, 4);

  setDemoMode(true);
  resetDemoData();
  const generated = await invoke({ action: 'invite.create', payload: { circleId: 'family_demo' } });
  const preview = page();
  await preview.onLoad({ token: generated.data.invite.token, demoPreview: '1' });
  assert.equal(isDemoMode(), true);
  assert.equal(cloudCalls, 4);
  assert.equal(preview.data.circle.name, '陈家亲友录');
  const missingPreview = page();
  await missingPreview.onLoad({token: 'missing-demo-invite', demoPreview: '1'});
  assert.ok(missingPreview.data.error);
  await missingPreview.onRetry();
  assert.equal(isDemoMode(), true, 'retrying a demo preview must stay in demo mode');
  assert.equal(cloudCalls, 4);
  config.CLOUD_ENV_ID = '';
  delete wx.cloud;
});

test('a joined non-admin without a card can create only their own card', async () => {
  resetDemoData();
  const key = 'kin-network-demo-db-v2';
  const db = storage.get(key);
  const member = db.members.find(item => item.circleId === 'class_demo' && item.actorId === 'demo-owner');
  member.role = 'member';
  member.personId = undefined;
  db.persons = db.persons.filter(item => item.id !== 'c_me');
  storage.set(key, db);
  const other = await invoke({ action: 'person.create', payload: { circleId: 'class_demo', name: '其他同学' } });
  assert.equal(other.ok, false);
  const incompleteSelf = await invoke({ action: 'person.create', payload: { circleId: 'class_demo', name: '我的新卡', claimSelf: true } });
  assert.equal(incompleteSelf.error.code, 'PROFILE_INCOMPLETE');
  const pending = await invoke({action: 'person.claim', payload: {circleId: 'class_demo', personId: 'c_sun'}});
  assert.equal(pending.ok, true);
  const prematureSelf = await invoke({ action: 'person.create', payload: { circleId: 'class_demo', name: '我的新卡', ...completeProfile, claimSelf: true } });
  assert.equal(prematureSelf.ok, false);
  assert.equal(prematureSelf.error.code, 'CLAIM_PENDING');
  const currentDb = storage.get(key);
  currentDb.claimRequests.find(request => request.id === pending.data.claimRequest.id).status = 'rejected';
  storage.set(key, currentDb);
  const self = await invoke({ action: 'person.create', payload: { circleId: 'class_demo', name: '我的新卡', ...completeProfile, claimSelf: true } });
  assert.equal(self.ok, true);
  assert.equal(self.data.person.isSelf, true);
  resetDemoData();
});

test('owner can appoint an admin and ownership changes only after recipient acceptance', async () => {
  resetDemoData();
  const promoted = await invoke({ action: 'member.setRole', payload: { circleId: 'family_demo', memberId: 'm_f_dad', role: 'admin' } });
  assert.equal(promoted.ok, true);
  const key = 'kin-network-demo-db-v2';
  const db = storage.get(key);
  db.delegations.push({ id: 'role_delegation', circleId: 'family_demo', personId: 'f_mom', adminMemberId: 'm_f_dad', fields: ['city'], active: true });
  storage.set(key, db);
  const demoted = await invoke({ action: 'member.setRole', payload: { circleId: 'family_demo', memberId: 'm_f_dad', role: 'member' } });
  assert.equal(demoted.ok, true);
  assert.equal(storage.get(key).delegations.find(d => d.id === 'role_delegation').active, false);
  const promotedAgain = await invoke({ action: 'member.setRole', payload: { circleId: 'family_demo', memberId: 'm_f_dad', role: 'admin' } });
  assert.equal(promotedAgain.ok, true);
  const audit = await invoke({ action: 'audit.list', payload: { circleId: 'family_demo' } });
  assert.equal(audit.ok, true);
  assert.ok(audit.data.events.some(e => e.type === 'member.setRole' && e.targetId === 'm_f_dad'));
  const transferred = await invoke({ action: 'circle.transferOwner', payload: { circleId: 'family_demo', memberId: 'm_f_dad' } });
  assert.equal(transferred.ok, true);
  const pending = await invoke({ action: 'circle.detail', payload: { circleId: 'family_demo' } });
  assert.equal(pending.data.role, 'owner');
  assert.equal(pending.data.ownerTransfer.targetMemberId, 'm_f_dad');
  const oldId = pending.data.ownerTransfer.id;
  const cancelled = await invoke({action: 'circle.cancelOwnerTransfer', payload: {circleId: 'family_demo', transferId: oldId}});
  assert.equal(cancelled.ok, true);
  const retried = await invoke({ action: 'circle.transferOwner', payload: { circleId: 'family_demo', memberId: 'm_f_dad' } });
  assert.equal(retried.ok, true);
  assert.equal((await invoke({action: 'circle.acceptOwnerTransfer', payload: {circleId: 'family_demo', transferId: oldId, demoAcceptAsTarget: true}})).ok, false);
  const accepted = await invoke({action: 'circle.acceptOwnerTransfer', payload: {circleId: 'family_demo', transferId: retried.data.ownerTransfer.id, demoAcceptAsTarget: true}});
  assert.equal(accepted.ok, true);
  const detail = await invoke({ action: 'circle.detail', payload: { circleId: 'family_demo' } });
  assert.equal(detail.data.role, 'admin');
  const cannotPromote = await invoke({ action: 'member.setRole', payload: { circleId: 'family_demo', memberId: 'm_f_mom', role: 'admin' } });
  assert.equal(cannotPromote.ok, false);
  const latest = await invoke({ action: 'audit.list', payload: { circleId: 'family_demo' } });
  assert.ok(latest.data.events.some(e => e.type === 'circle.transferRequested' && e.targetId === 'm_f_dad'));
  assert.ok(latest.data.events.some(e => e.type === 'circle.transferAccepted' && e.targetId === 'm_f_dad'));
  resetDemoData();
});

test('removing an invited successor clears the pending demo ownership transfer', async () => {
  resetDemoData();
  const circleId = 'family_demo';
  const requested = await invoke({action: 'circle.transferOwner', payload: {circleId, memberId: 'm_f_dad'}});
  assert.equal(requested.ok, true);
  const removed = await invoke({action: 'member.remove', payload: {circleId, memberId: 'm_f_dad'}});
  assert.equal(removed.ok, true);
  const detail = await invoke({action: 'circle.detail', payload: {circleId}});
  assert.equal(detail.data.ownerTransfer, null);
  const next = await invoke({action: 'circle.transferOwner', payload: {circleId, memberId: 'm_f_mom'}});
  assert.equal(next.ok, true);
  resetDemoData();
});

test('member leave revokes access and private data while retaining family links', async () => {
  resetDemoData();
  const key = 'kin-network-demo-db-v2';
  const db = storage.get(key);
  const self = db.members.find(m => m.id === 'm_f_self');
  self.role = 'member';
  db.delegations.push({ id: 'leave_delegation', circleId: 'family_demo', personId: 'f_me', adminMemberId: 'm_f_dad', fields: ['city'], active: true });
  storage.set(key, db);
  const left = await invoke({ action: 'member.leave', payload: { circleId: 'family_demo' } });
  assert.equal(left.ok, true);
  const denied = await invoke({ action: 'person.list', payload: { circleId: 'family_demo' } });
  assert.equal(denied.ok, false);
  const circles = await invoke({ action: 'circle.list' });
  assert.ok(!circles.data.circles.some(c => c.id === 'family_demo'));
  assert.ok(circles.data.circles.some(c => c.id === 'class_demo'));
  const saved = storage.get(key);
  assert.equal(saved.persons.find(p => p.id === 'f_me').city, undefined);
  assert.equal(saved.persons.find(p => p.id === 'f_me').phone, undefined);
  assert.equal(saved.members.find(m => m.id === 'm_f_self').personId, undefined);
  assert.equal(saved.delegations.find(d => d.id === 'leave_delegation').active, false);
  assert.ok(saved.relations.some(r => r.from === 'f_dad' && r.to === 'f_me'));
  resetDemoData();
});

test('removing a member also revokes their active delegations', async () => {
  resetDemoData();
  const key = 'kin-network-demo-db-v2';
  const db = storage.get(key);
  db.delegations.push({ id: 'removed_delegation', circleId: 'family_demo', personId: 'f_mom', adminMemberId: 'm_f_dad', fields: ['city'], active: true });
  storage.set(key, db);
  const removed = await invoke({ action: 'member.remove', payload: { circleId: 'family_demo', memberId: 'm_f_dad' } });
  assert.equal(removed.ok, true);
  const saved = storage.get(key);
  assert.equal(saved.members.find(m => m.id === 'm_f_dad').personId, undefined);
  assert.equal(saved.persons.find(p => p.id === 'f_dad').city, undefined);
  assert.equal(saved.delegations.find(d => d.id === 'removed_delegation').active, false);
  resetDemoData();
});

test('personal PNG and small JPEG photos are re-encoded before upload to their circle', async () => {
  const config = require('../config.ts');
  const previousEnv = config.CLOUD_ENV_ID;
  const previousPage = global.Page;
  const previousCloud = wx.cloud;
  const previousWx = {};
  const changedWx = ['chooseImage','getImageInfo','getFileInfo','createSelectorQuery','canvasToTempFilePath','getFileSystemManager','redirectTo'];
  changedWx.forEach(key => { previousWx[key] = wx[key]; });
  const calls = [];
  let route = '';
  let canvasWrites = 0;
  let selectionTimer;
  const canvas = {
    width: 0, height: 0,
    createImage() {
      const picture = {};
      Object.defineProperty(picture, 'src', {set() { queueMicrotask(() => picture.onload()); }});
      return picture;
    },
    getContext() { return {fillRect() {}, drawImage() {}, fillStyle: ''}; }
  };
  try {
    config.CLOUD_ENV_ID = 'test-env';
    wx.cloud = {init() {}, callFunction: async request => {
      calls.push(request.data);
      return {result: {ok: true, data: {person: {id: 'f_me', name: '我'}}}};
    }};
    assert.equal(setDemoMode(false), true);
    wx.chooseImage = options => options.success({tempFilePaths: ['album.png']});
    wx.getImageInfo = options => options.success(options.src === 'album.png'
      ? {type: 'png', width: 1800, height: 1200}
      : {type: 'jpeg', width: 1280, height: 853});
    wx.getFileInfo = options => options.success({size: options.filePath === 'album.png' ? 2200000 : 510000});
    wx.createSelectorQuery = () => ({
      in() { return this; }, select() { return this; }, fields() { return this; },
      exec(callback) { callback([{node: canvas}]); }
    });
    wx.canvasToTempFilePath = options => {
      canvasWrites++;
      assert.equal(options.fileType, 'jpg');
      assert.ok(options.width <= 1280 && options.height <= 1280);
      options.success({tempFilePath: 'compressed.jpg'});
    };
    wx.getFileSystemManager = () => ({readFile: options => options.success({data: '/9j/2Q=='})});
    wx.redirectTo = options => { route = options.url; };
    let definition;
    global.Page = options => { definition = options; };
    require('../pages/person-edit/index.ts');
    let selected;
    const selectedPromise = new Promise((resolve, reject) => {
      selected = () => { clearTimeout(selectionTimer); resolve(); };
      selectionTimer = setTimeout(() => reject(new Error('photo selection did not complete')), 2000);
    });
    const page = {
      ...definition, data: structuredClone(definition.data), circleId: 'family_demo', personId: 'f_me',
      setData(patch) {
        for (const [key, value] of Object.entries(patch)) {
          if (key.includes('.')) {
            const [parent, child] = key.split('.');
            this.data[parent][child] = value;
          } else this.data[key] = value;
        }
        if (patch.photoSelected) selected();
      }
    };
    page.data.isNew = false;
    page.data.isSelf = true;
    page.data.loading = false;
    page.onChoosePhoto();
    await selectedPromise;
    assert.equal(page.photoPath, 'compressed.jpg');
    assert.equal(page.data.form.photoUrl, 'compressed.jpg');
    assert.equal(await page.preparePhoto('small-original.jpg'), 'compressed.jpg', 'small JPEG must also pass through the metadata-stripping canvas');
    assert.equal(canvasWrites, 2);
    await page.onSavePhoto();
    assert.deepEqual(calls.map(call => call.action), ['photo.upload']);
    assert.equal(calls[0].payload.base64, '/9j/2Q==');
    assert.equal(Object.hasOwn(calls[0].payload, 'visibility'), false);
    assert.match(route, /pages\/person\/index/);
  } finally {
    clearTimeout(selectionTimer);
    config.CLOUD_ENV_ID = previousEnv;
    setDemoMode(true);
    global.Page = previousPage;
    wx.cloud = previousCloud;
    changedWx.forEach(key => { if (previousWx[key] === undefined) delete wx[key]; else wx[key] = previousWx[key]; });
  }
});

test('saving a photo without selecting a new image sends no upload', async () => {
  const config = require('../config.ts');
  const previousEnv = config.CLOUD_ENV_ID;
  const previousCloud = wx.cloud;
  const previousPage = global.Page;
  const previousRedirect = wx.redirectTo;
  const calls = [];
  try {
    config.CLOUD_ENV_ID = 'test-env';
    wx.cloud = {init() {}, callFunction: async request => {
      calls.push(request.data);
      return {result: {ok: true, data: {person: {id: 'f_me'}}}};
    }};
    wx.redirectTo = () => {};
    assert.equal(setDemoMode(false), true);
    let definition;
    global.Page = options => { definition = options; };
    delete require.cache[require.resolve('../pages/person-edit/index.ts')];
    require('../pages/person-edit/index.ts');
    const page = {
      ...definition, data: {...definition.data, isNew: false, isSelf: true},
      circleId: 'family_demo', personId: 'f_me',
      setData(patch) { Object.assign(this.data, patch); }
    };
    await page.onSavePhoto();
    assert.deepEqual(calls, []);
  } finally {
    config.CLOUD_ENV_ID = previousEnv;
    setDemoMode(true);
    wx.cloud = previousCloud;
    global.Page = previousPage;
    if (previousRedirect === undefined) delete wx.redirectTo; else wx.redirectTo = previousRedirect;
  }
});

test('photo URLs after the first 20 load progressively and include the late self card', async () => {
  const config = require('../config.ts');
  const previousEnv = config.CLOUD_ENV_ID;
  const previousCloud = wx.cloud;
  let calls = 0;
  try {
    config.CLOUD_ENV_ID = 'test-env';
    wx.cloud = {init() {}, callFunction: async request => {
      assert.equal(request.data.action, 'photo.urls');
      assert.ok(request.data.payload.personIds.length <= 20);
      calls++;
      const urls = Object.fromEntries(request.data.payload.personIds.map(id => [id, `https://photos.example/${id}.jpg`]));
      return {result: {ok: true, data: {urls}}};
    }};
    assert.equal(setDemoMode(false), true);
    const people = Array.from({length: 27}, (_, index) => ({id: `p${index}`, name: `人${index}`, hasPhoto: true, isSelf: index === 26}));
    let finish;
    const completed = new Promise(resolve => { finish = resolve; });
    const first = await resolvePhotoUrls('test-circle', people, updated => {
      if (updated.every(person => !!person.photoUrl)) finish(updated);
    });
    assert.equal(first.filter(person => person.photoUrl).length, 20);
    assert.match(first[26].photoUrl, /p26\.jpg$/, 'the member must be prioritized even when late in the list');
    const all = await completed;
    assert.equal(all.filter(person => person.photoUrl).length, 27);
    assert.equal(calls, 2, '27 public photos should use two batched cloud calls');
  } finally {
    config.CLOUD_ENV_ID = previousEnv;
    setDemoMode(true);
    wx.cloud = previousCloud;
  }
});

test('leaving a circle cancels later photo URL batches', async () => {
  const config = require('../config.ts');
  const previousEnv = config.CLOUD_ENV_ID;
  const previousCloud = wx.cloud;
  let calls = 0;
  try {
    config.CLOUD_ENV_ID = 'test-env';
    wx.cloud = {init() {}, callFunction: async request => {
      calls++;
      const urls = Object.fromEntries(request.data.payload.personIds.map(id => [id, `https://photos.example/${id}.jpg`]));
      return {result: {ok: true, data: {urls}}};
    }};
    assert.equal(setDemoMode(false), true);
    const people = Array.from({length: 50}, (_, index) => ({id: `p${index}`, name: `人${index}`, hasPhoto: true}));
    let stopped;
    const progressStopped = new Promise(resolve => {stopped = resolve;});
    await resolvePhotoUrls('test-circle', people, (_updated, checkOnly) => {
      if (checkOnly) return true;
      stopped();
      return false;
    });
    await progressStopped;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 2, 'only the first and in-flight second batch should run');
  } finally {
    config.CLOUD_ENV_ID = previousEnv;
    setDemoMode(true);
    wx.cloud = previousCloud;
  }
});

test('new card stays editable after its profile update fails and retry does not create a duplicate', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousModal = wx.showModal;
  const previousRedirect = wx.redirectTo;
  let createCount = 0;
  let updateCount = 0;
  let modalText = '';
  let route = '';
  try {
    api.invoke = async request => {
      if (request.action === 'person.create') { createCount++; return {ok: true, data: {person: {id: 'new-person', isSelf: false}}}; }
      if (request.action === 'person.update') {
        updateCount++;
        return updateCount === 1 ? {ok: false, error: {code: 'NETWORK', message: '网络暂时不可用'}} : {ok: true, data: {person: {id: 'new-person'}}};
      }
      throw new Error(`unexpected action ${request.action}`);
    };
    wx.showModal = options => { modalText = options.content; };
    wx.redirectTo = options => { route = options.url; };
    global.Page = options => { global.__personEditDefinition = options; };
    delete require.cache[require.resolve('../pages/person-edit/index.ts')];
    require('../pages/person-edit/index.ts');
    const definition = global.__personEditDefinition;
    const page = {
      ...definition, data: structuredClone(definition.data), circleId: 'family_demo', createMode: 'other', personId: '',
      setData(patch) { Object.assign(this.data, patch); }
    };
    page.data.loading = false;
    page.data.isAdmin = true;
    page.data.form.name = '新人物';
    page.data.form.country = '中国';
    page.data.form.province = '上海';
    page.data.form.city = '上海';
    page.data.monthIndex = 0;
    page.data.dayIndex = 0;
    await page.onSave();
    assert.equal(createCount, 1);
    assert.equal(page.personId, 'new-person');
    assert.equal(page.data.isNew, false);
    assert.match(modalText, /人物卡已创建|详细资料暂未保存/);
    await page.onSave();
    assert.equal(createCount, 1);
    assert.equal(updateCount, 2);
    assert.match(route, /personId=new-person/);
  } finally {
    api.invoke = previousInvoke;
    global.Page = previousPage;
    wx.showModal = previousModal;
    wx.redirectTo = previousRedirect;
    delete global.__personEditDefinition;
  }
});

test('adding a family person can set a relation to someone who has not logged in', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousTitle = wx.setNavigationBarTitle;
  const previousRedirect = wx.redirectTo;
  let created;
  try {
    api.invoke = async request => {
      if (request.action === 'circle.detail') return {ok: true, data: {circle: {id: 'family_demo', type: 'family'}, role: 'owner'}};
      if (request.action === 'person.list') return {ok: true, data: {persons: [{id: 'older-card', name: '妈妈', city: '成都', isSelf: false, isClaimed: false}]}};
      if (request.action === 'person.claimMine') return {ok: true, data: {claimRequests: []}};
      if (request.action === 'person.create') {created = request; return {ok: true, data: {person: {id: 'new-card', isSelf: false}}};}
      if (request.action === 'person.update') return {ok: true, data: {person: {id: 'new-card'}}};
      throw new Error(`unexpected action ${request.action}`);
    };
    wx.setNavigationBarTitle = () => {};
    wx.redirectTo = () => {};
    let definition;
    global.Page = options => {definition = options;};
    delete require.cache[require.resolve('../pages/person-edit/index.ts')];
    require('../pages/person-edit/index.ts');
    const page = {...definition, circleId: 'family_demo', createMode: 'other', data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
    await page.loadData();
    assert.equal(page.data.relationTargetIds[0], 'older-card');
    assert.equal(page.data.relationTargetIndex, 1, 'an existing person is selected so the new relation is prompted');
    page.onRelationTarget({detail: {value: '1'}});
    const childIndex = page.data.relationKindOptions.findIndex(label => label.endsWith('的子女（性别未填）'));
    assert.ok(childIndex > 0);
    page.data.form.name = '孩子'; page.data.form.country = '中国'; page.data.form.city = '成都'; page.data.form.province = '四川';
    page.data.monthIndex = 4; page.data.dayIndex = 15;
    await page.onSave();
    assert.equal(created, undefined, 'a second family person cannot be saved without a relation');
    page.onRelationKind({detail: {value: String(childIndex)}}); // new person is the existing person's child
    await page.onSave();
    assert.deepEqual(created.payload.initialRelation, {anchorPersonId: 'older-card', kind: 'newChild'});
  } finally {
    api.invoke = previousInvoke; global.Page = previousPage; wx.setNavigationBarTitle = previousTitle; wx.redirectTo = previousRedirect;
  }
});

test('a newly added self card in an existing family also needs a relationship', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousTitle = wx.setNavigationBarTitle;
  const previousRedirect = wx.redirectTo;
  let created;
  try {
    api.invoke = async request => {
      if (request.action === 'circle.detail') return {ok: true, data: {circle: {id: 'family_demo', type: 'family'}, role: 'member'}};
      if (request.action === 'person.list') return {ok: true, data: {persons: [{id: 'older-card', name: '妈妈', city: '成都', isSelf: false, isClaimed: false}]}};
      if (request.action === 'account.profile.get') return {ok: true, data: {profile: null}};
      if (request.action === 'person.claimMine') return {ok: true, data: {claimRequests: []}};
      if (request.action === 'person.create') {created = request; return {ok: true, data: {person: {id: 'self-card', isSelf: true}}};}
      if (request.action === 'person.update') return {ok: true, data: {person: {id: 'self-card'}}};
      throw new Error(`unexpected action ${request.action}`);
    };
    wx.setNavigationBarTitle = () => {};
    wx.redirectTo = () => {};
    let definition;
    global.Page = options => {definition = options;};
    delete require.cache[require.resolve('../pages/person-edit/index.ts')];
    require('../pages/person-edit/index.ts');
    const page = {...definition, circleId: 'family_demo', createMode: 'self', data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
    await page.loadData();
    assert.equal(page.data.relationTargetIndex, 1);
    const childIndex = page.data.relationKindOptions.findIndex(label => label.endsWith('的子女（性别未填）'));
    assert.ok(childIndex > 0);
    Object.assign(page.data.form, {name: '孩子', country: '中国', province: '四川', city: '成都'});
    page.data.monthIndex = 4; page.data.dayIndex = 15;
    await page.onSave();
    assert.equal(created, undefined);
    page.onRelationKind({detail: {value: String(childIndex)}});
    await page.onSave();
    assert.equal(created.payload.claimSelf, true);
    assert.deepEqual(created.payload.initialRelation, {anchorPersonId: 'older-card', kind: 'newChild'});
  } finally {
    api.invoke = previousInvoke; global.Page = previousPage; wx.setNavigationBarTitle = previousTitle; wx.redirectTo = previousRedirect;
  }
});

test('administrator opens direct profile and relationship editing; member access has separate actions', () => {
  const previousPage = global.Page;
  const previousNavigate = wx.navigateTo;
  const previousScroll = wx.pageScrollTo;
  const previousSheet = wx.showActionSheet;
  let route = '';
  let selector = '';
  let actionLabels = [];
  try {
    wx.navigateTo = options => {route = options.url;};
    wx.pageScrollTo = options => {selector = options.selector;};
    wx.showActionSheet = options => {actionLabels = options.itemList;};
    let definition;
    global.Page = options => {definition = options;};
    delete require.cache[require.resolve('../pages/manage/index.ts')];
    require('../pages/manage/index.ts');
    const page = {...definition, circleId: 'family_demo', data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
    page.data.people = [{id: 'p1', name: '李航'}, {id: 'p2', name: '李明'}];
    page.data.relations = [{id: 'r1', from: 'p1', to: 'p2', type: 'sibling'}];
    page.data.members = [{id: 'm1', name: '李航', role: 'member', personId: 'p1', isSelf: false, canManage: true}];
    page.data.isOwner = true;
    page.onEditPerson({currentTarget: {dataset: {id: 'p1'}}});
    assert.match(route, /person-edit\/index\?circleId=family_demo&personId=p1/);
    page.onManagePersonRelation({currentTarget: {dataset: {id: 'p1'}}});
    assert.equal(page.data.activeTab, 'relations');
    assert.equal(page.data.showRelationEditor, false, 'show existing relationships before opening a form');
    assert.equal(page.data.relationFocusName, '李航');
    assert.equal(page.data.relationRows.length, 1);
    assert.equal(page.data.fromIndex, 1);
    page.onMemberMenu({currentTarget: {dataset: {id: 'm1'}}});
    assert.deepEqual(actionLabels, ['设为管理员', '移出成员']);
    assert.equal(page.onUnclaim, undefined);
    const markup = fs.readFileSync(require.resolve('../pages/manage/index.wxml'), 'utf8');
    assert.match(markup, /bindtap="onEditPerson"/);
    assert.match(markup, /bindtap="onManagePersonRelation"/);
    assert.match(markup, /成员管理/);
    assert.match(markup, /bindtap="onRequestOwnerTransfer"/);
    assert.doesNotMatch(markup, /onConfirmUnclaim|onDemoAcceptOwnerTransfer/);
    assert.doesNotMatch(fs.readFileSync(require.resolve('../pages/person/index.wxml'), 'utf8'), /授权管理员代维护/);
  } finally {
    global.Page = previousPage; wx.navigateTo = previousNavigate; wx.pageScrollTo = previousScroll; wx.showActionSheet = previousSheet;
  }
});

test('administrator may edit a claimed person within this record without a delegation', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousTitle = wx.setNavigationBarTitle;
  try {
    api.invoke = async request => {
      const data = {
        'circle.detail': {circle: {id: 'family_demo', type: 'family'}, role: 'admin'},
        'person.list': {persons: [{id: 'claimed', name: '李航', isClaimed: true, isSelf: false}]},
        'person.claimMine': {claimRequests: []},
        'person.get': {person: {id: 'claimed', name: '李航', isClaimed: true, isSelf: false, city: '上海', country: '中国', birthday: {calendar: 'solar', month: 1, day: 2}, myDelegatedFields: []}}
      }[request.action];
      if (!data) throw new Error(`unexpected ${request.action}`);
      return {ok: true, data};
    };
    wx.setNavigationBarTitle = () => {};
    let definition;
    global.Page = options => {definition = options;};
    delete require.cache[require.resolve('../pages/person-edit/index.ts')];
    require('../pages/person-edit/index.ts');
    const page = {...definition, circleId: 'family_demo', personId: 'claimed', createMode: 'other', data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
    await page.loadData();
    assert.equal(page.data.isAdmin, true);
    assert.equal(page.data.canPrivate, true);
    for (const field of ['name', 'city', 'birthday', 'phone', 'wechatId', 'photoFileId']) assert.equal(page.data.editable[field], true, field);
    assert.equal(page.data.editable.matchPhone, false, 'the private matching number is only for an unclaimed card');
    assert.match(fs.readFileSync(require.resolve('../pages/person-edit/index.wxml'), 'utf8'), /只修改这份.*中的资料/);
  } finally {
    api.invoke = previousInvoke; global.Page = previousPage; wx.setNavigationBarTitle = previousTitle;
  }
});

test('person detail hides another claim action while an application is pending', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousTitle = wx.setNavigationBarTitle;
  let pending = true;
  try {
    api.invoke = async request => {
      const action = request.action;
      if (action === 'person.remark.get') return {ok: true, data: {remark: ''}};
      if (action === 'account.sync') return {ok: true, data: {hasVerifiedPhone: true}};
      if (action === 'circle.detail') return {ok: true, data: {circle: {id: 'c', type: 'family'}, role: 'member'}};
      if (action === 'person.get') return {ok: true, data: {person: {id: 'p1', name: '甲', isClaimed: false}}};
      if (action === 'person.list') return {ok: true, data: {persons: [{id: 'p1', name: '甲', isClaimed: false}]}};
      if (action === 'relation.list') return {ok: true, data: {relations: []}};
      if (action === 'person.claimMine') return {ok: true, data: {claimRequests: pending ? [{status: 'pending'}] : []}};
      throw new Error(`unexpected action ${action}`);
    };
    wx.setNavigationBarTitle = () => {};
    global.Page = options => { global.__personDefinition = options; };
    delete require.cache[require.resolve('../pages/person/index.ts')];
    require('../pages/person/index.ts');
    const definition = global.__personDefinition;
    const page = {...definition, circleId: 'c', personId: 'p1', data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); }};
    await page.loadData();
    assert.equal(page.data.claimPending, true);
    assert.equal(page.data.canClaim, false);
    pending = false;
    await page.loadData();
    assert.equal(page.data.canClaim, true);
  } finally {
    api.invoke = previousInvoke;
    global.Page = previousPage;
    wx.setNavigationBarTitle = previousTitle;
    delete global.__personDefinition;
  }
});

test('demo photo choices stay temporary and a failed save removes its new file', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousChoose = wx.chooseImage;
  const previousSave = wx.saveFile;
  const previousRemove = wx.removeSavedFile;
  const previousRedirect = wx.redirectTo;
  let saveCount = 0;
  let updateCount = 0;
  let redirect = '';
  const removed = [];
  const patches = [];
  try {
    assert.equal(setDemoMode(true), true);
    api.invoke = async request => {
      patches.push(request.payload.patch);
      updateCount++;
      return updateCount === 1
        ? {ok: false, error: {code: 'STORAGE_FULL', message: '本地存储空间不足'}}
        : {ok: true, data: {person: {id: 'f_me'}}};
    };
    wx.chooseImage = options => options.success({tempFilePaths: ['album.png']});
    wx.saveFile = options => options.success({savedFilePath: `/saved/${++saveCount}.jpg`});
    wx.removeSavedFile = options => { removed.push(options.filePath); options.success({}); };
    wx.redirectTo = options => { redirect = options.url; };
    let definition;
    global.Page = options => { definition = options; };
    delete require.cache[require.resolve('../pages/person-edit/index.ts')];
    require('../pages/person-edit/index.ts');
    const page = {
      ...definition, data: structuredClone(definition.data), circleId: 'family_demo', personId: 'f_me', originalPhotoPath: '/saved/old.jpg',
      setData(patch) {
        for (const [key, value] of Object.entries(patch)) {
          if (key.includes('.')) { const [parent, child] = key.split('.'); this.data[parent][child] = value; }
          else this.data[key] = value;
        }
      },
      preparePhoto: async () => 'converted.jpg'
    };
    page.data.isNew = false;
    page.data.isSelf = true;
    page.data.loading = false;
    page.onChoosePhoto();
    await new Promise(resolve => setImmediate(resolve));
    page.onChoosePhoto();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(page.photoPath, 'converted.jpg');
    assert.equal(saveCount, 0, 'choosing or replacing a preview must not persist a file');
    await page.onSavePhoto();
    assert.equal(saveCount, 1);
    assert.deepEqual(removed, ['/saved/1.jpg']);
    assert.equal(page.photoPath, 'converted.jpg', 'failed save must keep the preview for retry');
    await page.onSavePhoto();
    assert.equal(saveCount, 2);
    assert.deepEqual(patches.map(patch => patch.photoUrl), ['/saved/1.jpg', '/saved/2.jpg']);
    assert.deepEqual(removed, ['/saved/1.jpg', '/saved/old.jpg']);
    assert.match(redirect, /pages\/person\/index/);
  } finally {
    api.invoke = previousInvoke;
    global.Page = previousPage;
    for (const [key, value] of Object.entries({chooseImage: previousChoose, saveFile: previousSave, removeSavedFile: previousRemove, redirectTo: previousRedirect})) {
      if (value === undefined) delete wx[key]; else wx[key] = value;
    }
  }
});

test('demo photo stores a file path and reports storage failures without claiming success', async () => {
  resetDemoData();
  const previousEnv = wx.env;
  const previousFs = wx.getFileSystemManager;
  const previousSet = wx.setStorageSync;
  let failStorage = true;
  const written = [];
  try {
    wx.env = {USER_DATA_PATH: '/demo-files'};
    wx.getFileSystemManager = () => ({writeFileSync(path, value, encoding) { written.push({path, value, encoding}); }, unlinkSync() {}});
    wx.setStorageSync = (key, value) => {
      if (key === 'kin-network-demo-db-v2' && failStorage) throw new Error('storage full');
      storage.set(key, value);
    };
    const payload = {circleId: 'family_demo', personId: 'f_me', base64: '/9j/2Q==', visibility: 'circle'};
    const failed = await invoke({action: 'photo.upload', payload});
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'STORAGE_FULL');
    assert.equal(storage.get('kin-network-demo-db-v2').persons.find(person => person.id === 'f_me').photoUrl, undefined);
    failStorage = false;
    const saved = await invoke({action: 'photo.upload', payload});
    assert.equal(saved.ok, true);
    assert.equal(saved.data.person.hasPhoto, true);
    assert.equal(saved.data.person.photoFileId, undefined);
    assert.equal(written.length, 2);
    assert.equal(written[1].encoding, 'base64');
    assert.equal(storage.get('kin-network-demo-db-v2').persons.find(person => person.id === 'f_me').photoUrl, written[1].path);
    assert.ok(!JSON.stringify(storage.get('kin-network-demo-db-v2')).includes(payload.base64));
    failStorage = true;
    const profileFailed = await invoke({action: 'person.update', payload: {circleId: 'family_demo', personId: 'f_me', patch: {bio: '没有保存的内容'}}});
    assert.equal(profileFailed.ok, false);
    assert.equal(profileFailed.error.code, 'STORAGE_FULL');
    assert.notEqual(storage.get('kin-network-demo-db-v2').persons.find(person => person.id === 'f_me').bio, '没有保存的内容');
  } finally {
    wx.env = previousEnv;
    wx.getFileSystemManager = previousFs;
    wx.setStorageSync = previousSet;
    resetDemoData();
  }
});

test('demo owner can remove an admin as the cloud service allows', async () => {
  resetDemoData();
  const promoted = await invoke({action: 'member.setRole', payload: {circleId: 'family_demo', memberId: 'm_f_dad', role: 'admin'}});
  assert.equal(promoted.ok, true);
  const removed = await invoke({action: 'member.remove', payload: {circleId: 'family_demo', memberId: 'm_f_dad'}});
  assert.equal(removed.ok, true);
  assert.equal(storage.get('kin-network-demo-db-v2').members.find(member => member.id === 'm_f_dad').status, 'removed');
  resetDemoData();
});

test('demo writes report storage failure for people and relations without changing stored data', async () => {
  resetDemoData();
  const previousSet = wx.setStorageSync;
  const before = structuredClone(storage.get('kin-network-demo-db-v2'));
  try {
    wx.setStorageSync = key => {
      if (key === 'kin-network-demo-db-v2') throw new Error('storage full');
    };
    const person = await invoke({action: 'person.create', payload: {circleId: 'family_demo', name: '无法保存的人物', ...completeProfile, initialRelation: {anchorPersonId: 'f_me', kind: 'sibling'}}});
    assert.equal(person.ok, false);
    assert.equal(person.error.code, 'STORAGE_FULL');
    const relation = await invoke({action: 'relation.create', payload: {circleId: 'family_demo', from: 'f_me', to: 'f_cousin', type: 'sibling'}});
    assert.equal(relation.ok, false);
    assert.equal(relation.error.code, 'STORAGE_FULL');
    const after = storage.get('kin-network-demo-db-v2');
    assert.deepEqual(after.persons, before.persons);
    assert.deepEqual(after.relations, before.relations);
  } finally {
    wx.setStorageSync = previousSet;
    resetDemoData();
  }
});

test('demo creation request IDs replay the original circle and card without duplicates', async () => {
  resetDemoData();
  const circlePayload = {type: 'family', name: '新家庭', mode: 'private', requestId: 'request-circle-123456789'};
  const first = await invoke({action: 'circle.create', payload: circlePayload});
  const replay = await invoke({action: 'circle.create', payload: circlePayload});
  assert.equal(first.ok, true); assert.equal(replay.ok, true);
  assert.equal(replay.data.circle.id, first.data.circle.id);
  assert.equal(storage.get('kin-network-demo-db-v2').circles.filter(circle => circle.name === '新家庭').length, 1);
  const conflict = await invoke({action: 'circle.create', payload: {...circlePayload, name: '改名了'}});
  assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
  const cardPayload = {circleId: first.data.circle.id, name: '新成员', ...completeProfile, requestId: 'request-person-123456789'};
  const card = await invoke({action: 'person.create', payload: cardPayload});
  const cardReplay = await invoke({action: 'person.create', payload: cardPayload});
  assert.equal(cardReplay.data.person.id, card.data.person.id);
  assert.equal(storage.get('kin-network-demo-db-v2').persons.filter(person => person.name === '新成员').length, 1);
  resetDemoData();
});

test('create page reuses its request ID after a lost response', async () => {
  resetDemoData();
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousRedirect = wx.redirectTo;
  let calls = 0;
  const ids = [];
  try {
    api.invoke = async request => {
      if (request.action !== 'circle.create') return previousInvoke(request);
      calls++;
      ids.push(request.payload.requestId);
      const result = await previousInvoke(request);
      return calls === 1 ? {ok: false, error: {code: 'NETWORK', message: '连接中断'}} : result;
    };
    wx.redirectTo = () => {};
    let definition;
    global.Page = options => {definition = options;};
    delete require.cache[require.resolve('../pages/create/index.ts')];
    require('../pages/create/index.ts');
    const page = {...definition, data: {...definition.data, name: '重试家庭'}, setData(patch) {Object.assign(this.data, patch);}};
    page.onLoad();
    await page.onSubmit();
    await page.onSubmit();
    assert.equal(calls, 2);
    assert.equal(ids[0], ids[1]);
    assert.equal(storage.get('kin-network-demo-db-v2').circles.filter(circle => circle.name === '重试家庭').length, 1);
  } finally {
    api.invoke = previousInvoke; global.Page = previousPage; wx.redirectTo = previousRedirect;
    resetDemoData();
  }
});

test('invite page lists an older active invitation and can revoke it after reopening', async () => {
  resetDemoData();
  const created = await invoke({action: 'invite.create', payload: {circleId: 'family_demo'}});
  const api = require('../services/api.ts');
  const previousPage = global.Page;
  const previousModal = wx.showModal;
  try {
    wx.showModal = options => options.success({confirm: true});
    let definition;
    global.Page = options => {definition = options;};
    delete require.cache[require.resolve('../pages/invite/index.ts')];
    require('../pages/invite/index.ts');
    const page = {...definition, circleId: 'family_demo', data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
    await page.loadData();
    assert.equal(page.data.activeInvites.some(item => item.id === created.data.invite.id), true);
    assert.equal(page.data.invite, null, 'old token is never re-exposed by invite.list');
    await page.onRevokeListed({currentTarget: {dataset: {id: created.data.invite.id}}});
    assert.equal(page.data.activeInvites.length, 0);
    const listed = await api.invoke({action: 'invite.list', payload: {circleId: 'family_demo'}});
    assert.equal(listed.data.invites.find(item => item.id === created.data.invite.id).status, 'revoked');
  } finally {
    global.Page = previousPage; wx.showModal = previousModal; resetDemoData();
  }
});

test('demo invitation never exposes its local token through WeChat sharing', async () => {
  resetDemoData();
  const previousPage = global.Page;
  const previousHide = wx.hideShareMenu;
  const previousShow = wx.showShareMenu;
  let hidden = 0;
  let shown = 0;
  try {
    wx.hideShareMenu = () => { hidden++; };
    wx.showShareMenu = () => { shown++; };
    let definition;
    global.Page = options => { definition = options; };
    delete require.cache[require.resolve('../pages/invite/index.ts')];
    require('../pages/invite/index.ts');
    const page = {...definition, data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
    page.onLoad({circleId: 'family_demo'});
    assert.equal(hidden, 1);
    assert.equal(shown, 0);
    page.setData({invite: {token: 'local-only-token'}, circle: {name: '家庭'}});
    assert.equal(page.onShareAppMessage().path, '/pages/circles/index');
  } finally {
    global.Page = previousPage; wx.hideShareMenu = previousHide; wx.showShareMenu = previousShow;
    resetDemoData();
  }
});

test('editing my city and lunar birthday saves both details for the circle', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousRedirect = wx.redirectTo;
  const updates = [];
  try {
    api.invoke = async request => { updates.push(request); return {ok: true, data: {person: {id: 'f_me'}}}; };
    wx.redirectTo = () => {};
    let definition;
    global.Page = options => { definition = options; };
    delete require.cache[require.resolve('../pages/person-edit/index.ts')];
    require('../pages/person-edit/index.ts');
    const page = {
      ...definition, circleId: 'family_demo', personId: 'f_me',
      data: {...structuredClone(definition.data), isNew: false, isSelf: true, claimSelf: false, loading: false,
        editable: {name: true, city: true, country: true, province: true, birthday: true},
        form: {...definition.data.form, name: '陈小满', city: '上海', country: '中国', province: '上海', latitude: 31.2, longitude: 121.5}},
      setData(patch) { Object.assign(this.data, patch); },
      uploadSelectedPhoto: async () => true
    };
    page.data.calendarIndex = 1;
    page.data.monthIndex = 7;
    page.data.dayIndex = 14;
    page.data.leapMonth = true;
    await page.onSave();
    assert.equal(updates[0].payload.patch.city, '上海');
    assert.deepEqual(updates[0].payload.patch.birthday, {calendar: 'lunar', month: 8, day: 15, leapMonth: true});
    assert.equal(Object.hasOwn(updates[0].payload, 'visibility'), false);
  } finally {
    api.invoke = previousInvoke; global.Page = previousPage; wx.redirectTo = previousRedirect;
  }
});

test('manager can link an invited applicant to an existing unclaimed family card', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousModal = wx.showModal;
  let approval;
  let confirmation = '';
  try {
    api.invoke = async request => {
      if (request.action === 'join.approve') { approval = request; return {ok: true, data: {application: {id: 'join-1'}}}; }
      const data = {
        'circle.detail': {circle: {id: 'family_demo', name: '我家', type: 'family'}, role: 'owner'},
        'person.list': {persons: [{id: 'f_uncle', name: '陈志国', city: '广州', birthday: {calendar: 'solar', month: 2, day: 3}, updatedAt: 12345, isClaimed: false}, {id: 'f_me', name: '陈小满', isClaimed: true, isSelf: true}]},
        'member.list': {members: []},
        'join.list': {applications: [{id: 'join-1', circleId: 'family_demo', applicantName: '陈志国', status: 'pending', createdAt: Date.now(), inviteStatus: 'active', profile: completeProfile, profileChanged: false, profileIncomplete: false, reviewToken: 'review-v1'}]},
        'person.claimList': {claimRequests: []}, 'suggestion.list': {suggestions: []},
        'relation.list': {relations: []}, 'audit.list': {events: []}
      }[request.action];
      if (!data) throw new Error(`Unexpected action ${request.action}`);
      return {ok: true, data};
    };
    wx.showModal = options => { confirmation = options.content; options.success({confirm: true}); };
    let definition;
    global.Page = options => { definition = options; };
    delete require.cache[require.resolve('../pages/manage/index.ts')];
    require('../pages/manage/index.ts');
    const page = {...definition, circleId: 'family_demo', data: structuredClone(definition.data), setData(patch) {
      for (const [key, value] of Object.entries(patch)) {
        const indexed = /^applications\[(\d+)\]\.(\w+)$/.exec(key);
        if (indexed) this.data.applications[Number(indexed[1])][indexed[2]] = value;
        else this.data[key] = value;
      }
    }};
    await page.loadData();
    assert.equal(page.data.joinTargetIds[2], 'f_uncle');
    assert.match(page.data.joinTargetLabels[2], /陈志国/);
    assert.match(page.data.applications[0].relationKindOptions[2], /陈小满/);
    assert.equal(page.data.applications[0].sameNameInCircle, true);
    page.loadData = async () => {};
    await page.onJoin({currentTarget: {dataset: {id: 'join-1', decision: 'approve'}}});
    assert.equal(approval, undefined, 'approving without an explicit person choice must be blocked');
    page.onJoinTarget({currentTarget: {dataset: {id: 'join-1'}}, detail: {value: '2'}});
    assert.equal(page.data.applications[0].targetIndex, 2);
    assert.match(page.data.applications[0].targetProfileText, /广州.*阳历2月3日/);
    assert.equal(page.data.applications[0].targetDataMismatch, true);
    await page.onJoin({currentTarget: {dataset: {id: 'join-1', decision: 'approve'}}});
    assert.equal(approval.action, 'join.approve');
    assert.equal(approval.payload.targetPersonId, 'f_uncle');
    assert.equal(approval.payload.targetPersonUpdatedAt, 12345);
    assert.equal(Object.hasOwn(approval.payload, 'initialRelation'), false);
    assert.equal(approval.payload.reviewToken, 'review-v1');
    assert.match(confirmation, /就是已记录的「陈志国」.*保留原有关系/);
    assert.ok(confirmation.length < 90);
    assert.match(fs.readFileSync(require.resolve('../pages/manage/index.wxml'), 'utf8'), /已记录：\{\{item.targetProfileText\}\}/);
    approval = undefined;
    page.onJoinTarget({currentTarget: {dataset: {id: 'join-1'}}, detail: {value: '1'}});
    await page.onJoin({currentTarget: {dataset: {id: 'join-1', decision: 'approve'}}});
    assert.equal(approval, undefined, 'a selected family anchor needs an explicit relationship choice');
    page.onJoinRelationKind({currentTarget: {dataset: {id: 'join-1'}}, detail: {value: '2'}});
    await page.onJoin({currentTarget: {dataset: {id: 'join-1', decision: 'approve'}}});
    assert.equal(approval.action, 'join.approve');
    assert.equal(Object.hasOwn(approval.payload, 'targetPersonId'), false);
    assert.deepEqual(approval.payload.initialRelation, {anchorPersonId: 'f_me', kind: 'newChild'});
    assert.match(confirmation, /陈志国 是 陈小满 的子女/);
    assert.match(confirmation, /新增「陈志国」/);
    approval = undefined;
    page.onJoinRelationAnchor({currentTarget: {dataset: {id: 'join-1'}}, detail: {value: '0'}});
    await page.onJoin({currentTarget: {dataset: {id: 'join-1', decision: 'approve'}}});
    assert.equal(approval, undefined, 'an existing family requires a relation before creating the applicant card');
    page.onJoinRelationAnchor({currentTarget: {dataset: {id: 'join-1'}}, detail: {value: '1'}});
    assert.match(page.data.applications[0].relationKindOptions[4], /陈志国/);
    page.onJoinRelationKind({currentTarget: {dataset: {id: 'join-1'}}, detail: {value: '4'}});
    page.onJoinRelationOlder({currentTarget: {dataset: {id: 'join-1'}}, detail: {value: '2'}});
    await page.onJoin({currentTarget: {dataset: {id: 'join-1', decision: 'approve'}}});
    assert.deepEqual(approval.payload.initialRelation, {anchorPersonId: 'f_uncle', kind: 'sibling', older: 'anchor'});
  } finally {
    api.invoke = previousInvoke; global.Page = previousPage; wx.showModal = previousModal;
  }
});

test('My page has one profile entry and shows management only for records I administer', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousNavigate = wx.navigateTo;
  let definition;
  const visited = [];
  try {
    api.invoke = async request => {
      if (request.action === 'account.sync') return {ok: true, data: {hasVerifiedPhone: true, linked: [], alreadyLinked: [], skipped: 0}};
      if (request.action === 'circle.list') return {ok: true, data: {circles: [
        {id: 'family', name: '我家', type: 'family', role: 'owner', memberCount: 3},
        {id: 'class', name: '三班', type: 'classmate', role: 'member', memberCount: 20}
      ]}};
      throw new Error(`Unexpected ${request.action}`);
    };
    global.Page = options => {definition = options;};
    wx.navigateTo = ({url}) => visited.push(url);
    delete require.cache[require.resolve('../pages/my/index.ts')];
    require('../pages/my/index.ts');
    const page = {...definition, data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
    await page.loadData();
    assert.deepEqual(page.data.managedRecords.map(record => record.id), ['family']);
    assert.equal(page.data.managedRecords[0].typeLabel, '家人录');
    page.onOpenProfile();
    page.onOpenManage({currentTarget: {dataset: {id: 'class'}}});
    page.onOpenManage({currentTarget: {dataset: {id: 'family'}}});
    assert.deepEqual(visited, [
      '/pages/profile/index',
      '/pages/manage/index?circleId=family'
    ]);
    const markup = fs.readFileSync(require.resolve('../pages/my/index.wxml'), 'utf8');
    assert.equal((markup.match(/bindtap="onOpenProfile"/g) || []).length, 1);
    assert.doesNotMatch(markup, /我加入的圈子|体验手机号自动关联|myCircles/);
    assert.match(markup, /wx:if="\{\{managedRecords\.length\}\}"/);
  } finally {
    api.invoke = previousInvoke; global.Page = previousPage; wx.navigateTo = previousNavigate;
  }
});

test('a regular member sees one profile entry and cannot open administration', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousNavigate = wx.navigateTo;
  let definition;
  const visited = [];
  try {
    api.invoke = async request => {
      if (request.action === 'account.sync') return {ok: true, data: {hasVerifiedPhone: true}};
      if (request.action === 'circle.list') return {ok: true, data: {circles: [{id: 'class', name: '三班', type: 'classmate', role: 'member'}]}};
      throw new Error(`Unexpected ${request.action}`);
    };
    global.Page = options => {definition = options;};
    wx.navigateTo = ({url}) => visited.push(url);
    delete require.cache[require.resolve('../pages/my/index.ts')];
    require('../pages/my/index.ts');
    const page = {...definition, data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
    await page.loadData();
    assert.deepEqual(page.data.managedRecords, []);
    page.onOpenManage({currentTarget: {dataset: {id: 'class'}}});
    page.onOpenProfile();
    assert.deepEqual(visited, ['/pages/profile/index']);
    const markup = fs.readFileSync(require.resolve('../pages/my/index.wxml'), 'utf8');
    assert.match(markup, /class="settings" wx:if="\{\{demoMode && managedRecords\.length\}\}"/);
  } finally {
    api.invoke = previousInvoke; global.Page = previousPage; wx.navigateTo = previousNavigate;
  }
});

test('My page does not request private records before phone login', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousReLaunch = wx.reLaunch;
  let definition;
  const destinations = [];
  try {
    api.invoke = async request => {
      assert.equal(request.action, 'account.sync');
      return {ok: true, data: {hasVerifiedPhone: false}};
    };
    global.Page = options => {definition = options;};
    wx.reLaunch = ({url}) => destinations.push(url);
    delete require.cache[require.resolve('../pages/my/index.ts')];
    require('../pages/my/index.ts');
    const page = {...definition, data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
    await page.loadData();
    assert.deepEqual(destinations, ['/pages/login/index']);
    assert.deepEqual(page.data.managedRecords, []);
  } finally {
    api.invoke = previousInvoke; global.Page = previousPage; wx.reLaunch = previousReLaunch;
  }
});

test('removing a member uses a readable inline confirmation separate from profile editing', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  let removeCalls = 0;
  try {
    api.invoke = async request => { if (request.action === 'member.remove') removeCalls++; return {ok: true, data: {}}; };
    let definition;
    global.Page = options => { definition = options; };
    delete require.cache[require.resolve('../pages/manage/index.ts')];
    require('../pages/manage/index.ts');
    const page = {...definition, circleId: 'family_demo', data: {...definition.data, members: [{id: 'm1', name: '陈志远', canManage: true}]}, loadData() {}, setData(patch) {Object.assign(this.data, patch);}};
    page.onRemove({currentTarget: {dataset: {id: 'm1'}}});
    assert.equal(page.data.removeCandidateId, 'm1');
    assert.equal(removeCalls, 0);
    page.onCancelRemove();
    assert.equal(page.data.removeCandidateId, '');
    page.onRemove({currentTarget: {dataset: {id: 'm1'}}});
    await page.onConfirmRemove();
    assert.equal(removeCalls, 1);
    const markup = fs.readFileSync(require.resolve('../pages/manage/index.wxml'), 'utf8');
    assert.match(markup, /class="remove-confirm"/);
    assert.match(markup, /对方将不能再进入/);
    assert.match(markup, /照片、生日、所在地等资料删除且无法恢复/);
  } finally {
    api.invoke = previousInvoke; global.Page = previousPage;
  }
});

test('retired or unknown member menu commands cannot accidentally change a role', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const requests = [];
  try {
    api.invoke = async value => {requests.push(value); return {ok: true, data: {}};};
    let definition;
    global.Page = options => {definition = options;};
    delete require.cache[require.resolve('../pages/manage/index.ts')];
    require('../pages/manage/index.ts');
    const member = {id: 'm1', name: '李航', role: 'admin', personId: 'p1', canManage: true};
    const page = {...definition, circleId: 'family_demo', data: {...definition.data, isOwner: true, members: [member]}, loadData() {}, setData(patch) {Object.assign(this.data, patch);}};
    for (const command of ['unclaim', 'transfer', 'typo', undefined]) await page.performMemberAction(member, command);
    assert.deepEqual(requests, []);
    assert.equal(page.data.memberActionBusy, false);
  } finally {
    api.invoke = previousInvoke; global.Page = previousPage;
  }
});

test('manager closes a text correction with a written handling note', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousModal = wx.showModal;
  let request;
  try {
    api.invoke = async value => { request = value; return {ok: true, data: {suggestion: {status: 'handled'}}}; };
    wx.showModal = options => options.success({confirm: true, content: '已联系本人核对'});
    let definition;
    global.Page = options => { definition = options; };
    delete require.cache[require.resolve('../pages/manage/index.ts')];
    require('../pages/manage/index.ts');
    const page = {...definition, circleId: 'family_demo', data: {...definition.data, suggestions: [{id: 's1', type: 'person', message: '城市有误'}]}, loadData() {}, setData(patch) {Object.assign(this.data, patch);}};
    await page.onSuggestion({currentTarget: {dataset: {id: 's1', status: 'handled'}}});
    assert.equal(request.action, 'suggestion.resolve');
    assert.deepEqual(request.payload, {circleId: 'family_demo', suggestionId: 's1', status: 'handled', resolutionNote: '已联系本人核对'});
  } finally {
    api.invoke = previousInvoke; global.Page = previousPage; wx.showModal = previousModal;
  }
});

test('application status hides enter action when membership is gone and recovers on refresh', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousRedirect = wx.redirectTo;
  let canEnter = false;
  let redirects = 0;
  try {
    api.invoke = async request => {
      if (request.action === 'account.sync') return {ok: true, data: {hasVerifiedPhone: true}};
      assert.equal(request.action, 'join.mine');
      assert.equal(request.payload.applicationId, 'application-1');
      return {ok: true, data: {applications: [{id: 'application-1', circleId: 'family_demo', status: 'approved', createdAt: Date.now(), canEnter}]}};
    };
    wx.redirectTo = () => {redirects++;};
    let definition;
    global.Page = options => {definition = options;};
    delete require.cache[require.resolve('../pages/apply/index.ts')];
    require('../pages/apply/index.ts');
    const page = {...definition, data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
    await page.onLoad({applicationId: 'application-1'});
    assert.equal(page.data.application.canEnter, false);
    assert.match(page.data.applicationMessage, /已退出或被移出.*重新邀请/);
    page.onOpenCircle();
    assert.equal(redirects, 0);
    canEnter = true;
    await page.loadMyStatus();
    page.onOpenCircle();
    assert.equal(redirects, 1);
  } finally {
    api.invoke = previousInvoke; global.Page = previousPage; wx.redirectTo = previousRedirect;
  }
});

test('application submit ignores a second tap while the first request is pending', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  let finishSubmit;
  let submitCalls = 0;
  try {
    api.invoke = request => {
      if (request.action === 'account.sync') return Promise.resolve({ok: true, data: {hasVerifiedPhone: true}});
      if (request.action === 'account.profile.get') return Promise.resolve({ok: true, data: {profile: {name: '甲', country: '中国', province: '上海', city: '上海', birthday: {calendar: 'solar', month: 10, day: 8}}}});
      if (request.action === 'invite.apply') {
        submitCalls++;
        return new Promise(resolve => {finishSubmit = resolve;});
      }
      if (request.action === 'join.mine') return Promise.resolve({ok: true, data: {applications: [{id: 'a1', circleId: 'family_demo', status: 'pending', createdAt: Date.now()}]}});
      throw new Error(`unexpected ${request.action}`);
    };
    let definition;
    global.Page = options => {definition = options;};
    delete require.cache[require.resolve('../pages/apply/index.ts')];
    require('../pages/apply/index.ts');
    const page = {...definition, token: 'token-1', data: {...definition.data, circle: {type: 'family'}, status: 'active', profileReady: true}, setData(patch) {Object.assign(this.data, patch);}};
    const first = page.onSubmit();
    await page.onSubmit();
    assert.equal(submitCalls, 1);
    finishSubmit({ok: true, data: {application: {id: 'a1', circleId: 'family_demo', status: 'pending', createdAt: Date.now()}}});
    await first;
    assert.equal(page.data.submitted, true);
  } finally {
    api.invoke = previousInvoke; global.Page = previousPage;
  }
});

test('person detail shows a retry state after relation loading fails', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousTitle = wx.setNavigationBarTitle;
  let fail = true;
  try {
    api.invoke = async request => {
      if (request.action === 'person.remark.get') return {ok: true, data: {remark: ''}};
      if (request.action === 'account.sync') return {ok: true, data: {hasVerifiedPhone: true}};
      if (request.action === 'circle.detail') return {ok: true, data: {circle: {id: 'family_demo', type: 'family'}, role: 'member'}};
      if (request.action === 'person.get') return {ok: true, data: {person: {id: 'p1', name: '甲'}}};
      if (request.action === 'person.list') return {ok: true, data: {persons: [{id: 'p1', name: '甲', isSelf: true}]}};
      if (request.action === 'relation.list') return fail ? {ok: false, error: {code: 'NETWORK', message: '关系读取失败'}} : {ok: true, data: {relations: []}};
      if (request.action === 'person.claimMine') return {ok: true, data: {claimRequests: []}};
      throw new Error(`unexpected ${request.action}`);
    };
    wx.setNavigationBarTitle = () => {};
    let definition;
    global.Page = options => {definition = options;};
    delete require.cache[require.resolve('../pages/person/index.ts')];
    require('../pages/person/index.ts');
    const page = {...definition, circleId: 'family_demo', personId: 'p1', data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
    await page.loadData();
    assert.equal(page.data.loadError, '关系读取失败');
    fail = false;
    await page.onRetry();
    assert.equal(page.data.loadError, '');
    assert.equal(page.data.person.id, 'p1');
  } finally {
    api.invoke = previousInvoke; global.Page = previousPage; wx.setNavigationBarTitle = previousTitle;
  }
});
