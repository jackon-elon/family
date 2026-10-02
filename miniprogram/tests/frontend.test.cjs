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
const { invoke, resetDemoData, setDemoMode, isDemoMode, resolvePhotoUrls } = require('../services/api.ts');

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

test('delegated admin can preview a private photo without receiving its storage ID', async () => {
  resetDemoData();
  const key = 'kin-network-demo-db-v2';
  const db = storage.get(key);
  const person = db.persons.find(item => item.id === 'f_mom');
  person.photoFileId = 'demo-photo-f_mom';
  person.photoUrl = '/demo-files/mom.jpg';
  person.visibility.photoFileId = 'self';
  db.delegations.push({id: 'photo-delegation', circleId: 'family_demo', personId: 'f_mom', adminMemberId: 'm_f_self', fields: ['photoFileId'], active: true});
  storage.set(key, db);
  const detail = await invoke({action: 'person.get', payload: {circleId: 'family_demo', personId: 'f_mom'}});
  assert.equal(detail.ok, true);
  assert.equal(detail.data.person.hasPhoto, true);
  assert.equal(detail.data.person.photoFileId, undefined);
  assert.equal(detail.data.person.photoUrl, '/demo-files/mom.jpg');
  const urls = await invoke({action: 'photo.urls', payload: {circleId: 'family_demo', personIds: ['f_mom']}});
  assert.equal(urls.data.urls.f_mom, '/demo-files/mom.jpg');
  resetDemoData();
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
  const prematureClaim = await invoke({ action: 'invite.apply', payload: { token, name: '张晴', claimPersonId: 'f_uncle' } });
  assert.equal(prematureClaim.ok, false);
  const first = await invoke({ action: 'invite.apply', payload: { token, name: '张晴' } });
  const second = await invoke({ action: 'invite.apply', payload: { token, name: '刘安' } });
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  const mine = await invoke({ action: 'join.mine' });
  assert.ok(mine.data.applications.some(application => application.id === first.data.application.id && application.status === 'pending' && application.circleName === '陈家的小圈子'));
  const one = await invoke({action: 'join.mine', payload: {applicationId: first.data.application.id}});
  assert.deepEqual(one.data.applications.map(application => application.id), [first.data.application.id]);
  const personCount = storage.get('kin-network-demo-db-v2').persons.length;
  const approved = await invoke({ action: 'join.approve', payload: { circleId: 'family_demo', applicationId: first.data.application.id } });
  assert.equal(approved.ok, true);
  const db = storage.get('kin-network-demo-db-v2');
  assert.equal(db.persons.length, personCount, 'approval must not create a duplicate card');
  assert.equal(db.members.find(member => member.actorId === `guest_${first.data.application.id}`).personId, undefined);
  const replay = await invoke({ action: 'join.approve', payload: { circleId: 'family_demo', applicationId: second.data.application.id } });
  assert.equal(replay.ok, false);
  const preview = await invoke({ action: 'invite.preview', payload: { token } });
  assert.equal(preview.data.status, 'used');
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
  const accepted = await invoke({action: 'suggestion.resolve', payload: {circleId, suggestionId: suggestion.data.suggestion.id, status: 'accepted'}});
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
  const applied = await invoke({action: 'invite.apply', payload: {token: created.data.invite.token, name: '待核对家人'}});
  assert.equal(applied.ok, true);
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
  const missingPreview = page();
  await missingPreview.onLoad({token: 'missing-demo-invite', demoPreview: '1'});
  assert.ok(missingPreview.data.error);
  await missingPreview.onRetry();
  assert.equal(isDemoMode(), true, 'retrying a demo preview must stay in demo mode');
  assert.equal(cloudCalls, 2);
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
  const pending = await invoke({action: 'person.claim', payload: {circleId: 'class_demo', personId: 'c_sun'}});
  assert.equal(pending.ok, true);
  const prematureSelf = await invoke({ action: 'person.create', payload: { circleId: 'class_demo', name: '我的新卡', claimSelf: true } });
  assert.equal(prematureSelf.ok, false);
  assert.equal(prematureSelf.error.code, 'CLAIM_PENDING');
  const currentDb = storage.get(key);
  currentDb.claimRequests.find(request => request.id === pending.data.claimRequest.id).status = 'rejected';
  storage.set(key, currentDb);
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

test('personal PNG and small JPEG photos are re-encoded before upload, with chosen visibility', async () => {
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
    page.onChoosePhoto();
    await selectedPromise;
    assert.equal(page.photoPath, 'compressed.jpg');
    assert.equal(page.data.form.photoUrl, 'compressed.jpg');
    assert.equal(await page.preparePhoto('small-original.jpg'), 'compressed.jpg', 'small JPEG must also pass through the metadata-stripping canvas');
    assert.equal(canvasWrites, 2);
    page.onPhotoVisibility({currentTarget: {dataset: {index: 1}}});
    await page.onSavePhoto();
    assert.deepEqual(calls.map(call => call.action), ['photo.upload']);
    assert.equal(calls[0].payload.base64, '/9j/2Q==');
    assert.equal(calls[0].payload.visibility, 'circle');
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

test('existing photo visibility can be saved without choosing another image', async () => {
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
      ...definition, data: {...definition.data, isNew: false, isSelf: true, photoVisibilityIndex: 0, photoVisibilitySavedIndex: 0},
      circleId: 'family_demo', personId: 'f_me',
      setData(patch) { Object.assign(this.data, patch); }
    };
    page.onPhotoVisibility({currentTarget: {dataset: {index: 1}}});
    assert.equal(page.data.photoVisibilityDirty, true);
    await page.onSavePhoto();
    assert.deepEqual(calls.map(call => call.action), ['person.update']);
    assert.deepEqual(calls[0].payload.visibility, {photoFileId: 'circle'});
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
    page.data.form.name = '新人物';
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

test('person detail hides another claim action while an application is pending', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousTitle = wx.setNavigationBarTitle;
  let pending = true;
  try {
    api.invoke = async request => {
      const action = request.action;
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
    const person = await invoke({action: 'person.create', payload: {circleId: 'family_demo', name: '无法保存的人物'}});
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
  const cardPayload = {circleId: first.data.circle.id, name: '新成员', requestId: 'request-person-123456789'};
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

test('application status hides enter action when membership is gone and recovers on refresh', async () => {
  const api = require('../services/api.ts');
  const previousInvoke = api.invoke;
  const previousPage = global.Page;
  const previousRedirect = wx.redirectTo;
  let canEnter = false;
  let redirects = 0;
  try {
    api.invoke = async request => {
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
    assert.match(page.data.applicationMessage, /失去.*访问权/);
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
    const page = {...definition, token: 'token-1', data: {...definition.data, circle: {type: 'family'}, status: 'active', name: '甲'}, setData(patch) {Object.assign(this.data, patch);}};
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
