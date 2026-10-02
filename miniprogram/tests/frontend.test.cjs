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
const { invoke, resetDemoData, setDemoMode, isDemoMode } = require('../services/api.ts');

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

test('demo API keeps family and class cards separate and redacts private fields', async () => {
  resetDemoData();
  const family = await invoke({ action: 'person.list', payload: { circleId: 'family_demo' } });
  const classmates = await invoke({ action: 'person.list', payload: { circleId: 'class_demo' } });
  assert.equal(family.ok, true); assert.equal(classmates.ok, true);
  assert.ok(family.data.persons.every(person => person.circleId === 'family_demo'));
  assert.ok(classmates.data.persons.every(person => person.circleId === 'class_demo'));
  assert.equal(family.data.persons.find(person => person.id === 'f_uncle').city, undefined);
  assert.equal(family.data.persons.find(person => person.id === 'f_aunt').city, '旧金山');
  assert.equal(family.data.persons.find(person => person.id === 'f_dad').phone, undefined);
  assert.equal(family.data.persons.find(person => person.id === 'f_me').phone, '13800000000');
  assert.deepEqual([classmates.data.persons.find(person => person.id === 'c_wang').latitude, classmates.data.persons.find(person => person.id === 'c_wang').longitude], [51.5, -0.1]);
});

test('demo city points are coarse, paired, and removed with private location data', async () => {
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
  const hidden = await invoke({action: 'person.get', payload: {circleId: 'class_demo', personId: 'c_wang'}});
  assert.equal(hidden.data.person.city, undefined);
  assert.equal(hidden.data.person.latitude, undefined);
  assert.equal(hidden.data.person.longitude, undefined);
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
  const first = await invoke({ action: 'invite.apply', payload: { token, name: '张晴' } });
  const second = await invoke({ action: 'invite.apply', payload: { token, name: '刘安' } });
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  const approved = await invoke({ action: 'join.approve', payload: { circleId: 'family_demo', applicationId: first.data.application.id } });
  assert.equal(approved.ok, true);
  const replay = await invoke({ action: 'join.approve', payload: { circleId: 'family_demo', applicationId: second.data.application.id } });
  assert.equal(replay.ok, false);
  const preview = await invoke({ action: 'invite.preview', payload: { token } });
  assert.equal(preview.data.status, 'used');
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
      assert.equal(request.data.action, 'invite.preview');
      return { result: { ok: true, data: { circle: { id: 'real-circle', name: '真实家庭圈', type: 'family' }, expiresAt: Date.now() + 10000, status: 'active' } } };
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
  assert.equal(cloudCalls, 1);
  assert.equal(guest.data.circle.name, '真实家庭圈');

  setDemoMode(true);
  const scanned = page();
  await scanned.onLoad({ scene: encodeURIComponent('real-token') });
  assert.equal(scanned.token, 'real-token');
  assert.equal(isDemoMode(), false);
  assert.equal(cloudCalls, 2);

  setDemoMode(true);
  resetDemoData();
  const generated = await invoke({ action: 'invite.create', payload: { circleId: 'family_demo' } });
  const preview = page();
  await preview.onLoad({ token: generated.data.invite.token, demoPreview: '1' });
  assert.equal(isDemoMode(), true);
  assert.equal(cloudCalls, 2);
  assert.equal(preview.data.circle.name, '陈家的小圈子');
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
  const self = await invoke({ action: 'person.create', payload: { circleId: 'class_demo', name: '我的新卡', claimSelf: true } });
  assert.equal(self.ok, true);
  assert.equal(self.data.person.isSelf, true);
  resetDemoData();
});

test('owner can appoint an admin, hand over ownership, and audit records the changes', async () => {
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
  const detail = await invoke({ action: 'circle.detail', payload: { circleId: 'family_demo' } });
  assert.equal(detail.data.role, 'admin');
  const cannotPromote = await invoke({ action: 'member.setRole', payload: { circleId: 'family_demo', memberId: 'm_f_mom', role: 'admin' } });
  assert.equal(cannotPromote.ok, false);
  const latest = await invoke({ action: 'audit.list', payload: { circleId: 'family_demo' } });
  assert.ok(latest.data.events.some(e => e.type === 'circle.transferOwner' && e.targetId === 'm_f_dad'));
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
