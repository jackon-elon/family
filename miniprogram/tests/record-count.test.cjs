const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText;
  module._compile(output, filename);
};

const storage = new Map();
global.wx = {getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), showToast: () => {}};
const {invoke, resetDemoData, setDemoActor} = require('../services/api.ts');
const completeProfile = {country: '中国', province: '上海', city: '上海', birthday: {calendar: 'solar', month: 10, day: 8}};

test('record cards count every person in their list, regardless of account access', async () => {
  resetDemoData();
  const listed = await invoke({action: 'circle.list'});
  for (const record of listed.data.circles) {
    const people = await invoke({action: 'person.list', payload: {circleId: record.id}});
    const detail = await invoke({action: 'circle.detail', payload: {circleId: record.id}});
    assert.equal(record.personCount, people.data.persons.length);
    assert.equal(detail.data.circle.personCount, people.data.persons.length);
  }
  const family = listed.data.circles.find(record => record.id === 'family_demo');
  assert.equal(family.personCount, 7);
  assert.equal(family.memberCount, 4, 'access accounts do not define the visible person count');
  const created = await invoke({action: 'person.create', payload: {circleId: family.id, name: '陈明', ...completeProfile,
    initialRelation: {anchorPersonId: 'f_uncle', kind: 'newChild'}}});
  assert.equal(created.ok, true);
  assert.equal((await invoke({action: 'circle.list'})).data.circles.find(record => record.id === family.id).personCount, 8);
});

test('adding a relative and relation is atomic in the local demo', async () => {
  resetDemoData();
  const before = (await invoke({action: 'person.list', payload: {circleId: 'family_demo'}})).data.persons.length;
  const missing = await invoke({action: 'person.create', payload: {circleId: 'family_demo', name: '未说明关系', ...completeProfile}});
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'RELATION_REQUIRED');
  const invalid = await invoke({action: 'person.create', payload: {circleId: 'family_demo', name: '无效关系', ...completeProfile, initialRelation: {anchorPersonId: 'missing', kind: 'newChild'}}});
  assert.equal(invalid.ok, false);
  assert.equal((await invoke({action: 'person.list', payload: {circleId: 'family_demo'}})).data.persons.length, before);
  const created = await invoke({action: 'person.create', payload: {circleId: 'family_demo', name: '陈晓', ...completeProfile, initialRelation: {anchorPersonId: 'f_uncle', kind: 'newChild'}}});
  assert.equal(created.ok, true);
  assert.equal(created.data.relation.from, 'f_uncle');
  assert.equal(created.data.relation.to, created.data.person.id);
  assert.equal(created.data.relation.type, 'parent');
  assert.equal((await invoke({action: 'relation.list', payload: {circleId: 'family_demo'}})).data.relations.some(relation => relation.to === created.data.person.id), true);
});

test('a regular member cannot turn a truthy claim flag into permission to add a relative', async () => {
  resetDemoData();
  assert.equal(setDemoActor('demo-dad'), true);
  const attempted = await invoke({action: 'person.create', payload: {circleId: 'family_demo', name: '额外人物', ...completeProfile,
    claimSelf: 'yes', initialRelation: {anchorPersonId: 'f_dad', kind: 'newChild'}}});
  assert.equal(attempted.ok, false);
  assert.equal(attempted.error.code, 'FORBIDDEN');
  assert.equal((await invoke({action: 'person.list', payload: {circleId: 'family_demo'}})).data.persons.length, 7);
});

test('approving a new family person saves their first relation together with membership', async () => {
  resetDemoData();
  const invite = (await invoke({action: 'invite.create', payload: {circleId: 'family_demo'}})).data.invite;
  setDemoActor('demo-guest');
  await invoke({action: 'account.verifyPhone', payload: {code: 'demo-verified-phone'}});
  await invoke({action: 'account.profile.update', payload: {patch: {name: '新家人', ...completeProfile}}});
  const application = (await invoke({action: 'invite.apply', payload: {token: invite.token, name: '新家人'}})).data.application;
  setDemoActor('demo-owner');
  const before = storage.get('kin-network-demo-db-v2');
  const count = before.persons.length;
  const relations = before.relations.length;
  const invalid = await invoke({action: 'join.approve', payload: {circleId: 'family_demo', applicationId: application.id,
    initialRelation: {anchorPersonId: 'missing', kind: 'newChild'}}});
  assert.equal(invalid.ok, false);
  assert.equal(storage.get('kin-network-demo-db-v2').persons.length, count);
  assert.equal(storage.get('kin-network-demo-db-v2').relations.length, relations);
  assert.equal(storage.get('kin-network-demo-db-v2').invites.find(row => row.id === invite.id).usedAt, undefined);
  const approved = await invoke({action: 'join.approve', payload: {circleId: 'family_demo', applicationId: application.id,
    initialRelation: {anchorPersonId: 'f_dad', kind: 'newChild'}}});
  assert.equal(approved.ok, true);
  const db = storage.get('kin-network-demo-db-v2');
  const joined = db.members.find(row => row.actorId === 'demo-guest' && row.circleId === 'family_demo');
  assert.ok(joined?.personId);
  assert.equal(db.persons.length, count + 1);
  assert.equal(db.relations.length, relations + 1);
  assert.equal(db.relations.find(row => row.to === joined.personId)?.from, 'f_dad');
});

test('administrator sees one unified people list with only administrator roles labeled', async () => {
  resetDemoData();
  let definition;
  global.Page = options => {definition = options;};
  require('../pages/manage/index.ts');
  const page = {...definition, circleId: 'family_demo', data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
  await page.loadData();
  assert.equal(page.data.loadError, '');
  assert.equal(page.data.people.length, 7);
  assert.equal(page.data.personRows.length, 7);
  assert.equal(page.data.personRows.find(row => row.id === 'f_me').roleLabel, '管理员');
  assert.equal(page.data.personRows.find(row => row.id === 'f_dad').roleLabel, '');
  assert.equal(page.data.personRows.find(row => row.id === 'f_uncle').roleLabel, '');
  const markup = fs.readFileSync(require.resolve('../pages/manage/index.wxml'), 'utf8');
  assert.doesNotMatch(markup, /等待本人登录|待本人登录|已加入成员与权限|可管理自己的资料/);
  assert.match(markup, /visiblePersonRows/);
  assert.equal(page.data.visiblePersonRows.length, 7);
});

test('local demo administrator correction stays in the record and expires after the owner edits that field', async () => {
  resetDemoData();
  const before = (await invoke({action: 'person.get', payload: {circleId: 'family_demo', personId: 'f_dad'}})).data.person.city;
  const changed = await invoke({action: 'person.update', payload: {circleId: 'family_demo', personId: 'f_dad', patch: {city: '苏州', phone: '管理员填写'}}});
  assert.equal(changed.ok, true);
  assert.equal((await invoke({action: 'person.get', payload: {circleId: 'family_demo', personId: 'f_dad'}})).data.person.city, '苏州');
  setDemoActor('demo-dad');
  assert.equal((await invoke({action: 'account.profile.get'})).data.profile.city, before);
  assert.notEqual((await invoke({action: 'account.profile.get'})).data.profile.phone, '管理员填写');
  await invoke({action: 'account.profile.update', payload: {patch: {city: '南京', phone: '本人填写'}}});
  await invoke({action: 'account.profile.update', payload: {patch: {city: before, phone: null}}});
  setDemoActor('demo-owner');
  const current = (await invoke({action: 'person.get', payload: {circleId: 'family_demo', personId: 'f_dad'}})).data.person;
  assert.equal(current.city, before);
  assert.equal(current.phone, undefined);
});

test('local demo phone match does not grant access to a stranger record', async () => {
  resetDemoData();
  const circle = (await invoke({action: 'circle.create', payload: {name: '新家庭', type: 'family', mode: 'shared'}})).data.circle;
  const card = await invoke({action: 'person.create', payload: {circleId: circle.id, name: '被预录者', ...completeProfile, matchPhone: '13700137000'}});
  assert.equal(card.ok, true);
  setDemoActor('demo-guest');
  const linked = await invoke({action: 'account.verifyPhone', payload: {code: 'demo-verified-phone'}});
  assert.equal(linked.ok, true);
  assert.deepEqual(linked.data.linked, []);
  assert.equal((await invoke({action: 'circle.list'})).data.circles.some(row => row.id === circle.id), false);
  assert.equal((await invoke({action: 'person.list', payload: {circleId: circle.id}})).ok, false);
});
