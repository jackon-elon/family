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
global.wx = {
  getStorageSync: key => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  showToast: () => {}
};
const {invoke, resetDemoData, setDemoActor, getDemoActor, isDemoMode, setDemoMode} = require('../services/api.ts');

test('a configured cloud environment opens in cloud mode unless demo was explicitly chosen', () => {
  const config = require('../config.ts');
  const previousEnv = config.CLOUD_ENV_ID;
  const previousCloud = wx.cloud;
  const previousMode = storage.get('kin-network-demo-mode');
  try {
    config.CLOUD_ENV_ID = 'configured-env';
    wx.cloud = {init() {}, callFunction() {}};
    storage.delete('kin-network-demo-mode');
    assert.equal(isDemoMode(), false);
    assert.equal(setDemoMode(true), true);
    assert.equal(isDemoMode(), true);
    assert.equal(setDemoMode(false), true);
    assert.equal(isDemoMode(), false);
  } finally {
    config.CLOUD_ENV_ID = previousEnv;
    wx.cloud = previousCloud;
    if (previousMode === undefined) storage.delete('kin-network-demo-mode');
    else storage.set('kin-network-demo-mode', previousMode);
  }
});

test('application status deep link uses cloud on a new device when cloud is configured', async () => {
  const config = require('../config.ts');
  const previousEnv = config.CLOUD_ENV_ID;
  const previousCloud = wx.cloud;
  const previousPage = global.Page;
  const previousMode = storage.get('kin-network-demo-mode');
  const calls = [];
  try {
    config.CLOUD_ENV_ID = 'configured-env';
    storage.delete('kin-network-demo-mode');
    wx.cloud = {init() {}, callFunction: async request => {
      calls.push(request.data.action);
      if (request.data.action === 'account.sync') return {result: {ok: true, data: {hasVerifiedPhone: true}}};
      return {result: {ok: true, data: {applications: [{id: 'application-1', circleId: 'family-1', inviteId: 'invite-1', name: '李明', status: 'pending', createdAt: Date.now()}]}}};
    }};
    let definition;
    global.Page = page => {definition = page;};
    require('../pages/apply/index.ts');
    const page = {...definition, data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
    await page.onLoad({applicationId: 'application-1'});
    assert.deepEqual(calls, ['account.sync', 'join.mine']);
    assert.equal(page.data.application.id, 'application-1');
  } finally {
    config.CLOUD_ENV_ID = previousEnv;
    wx.cloud = previousCloud;
    global.Page = previousPage;
    if (previousMode === undefined) storage.delete('kin-network-demo-mode');
    else storage.set('kin-network-demo-mode', previousMode);
  }
});

test('one account profile appears in both family and class cards and own birthday stays out of events', async () => {
  resetDemoData();
  assert.equal(getDemoActor(), 'demo-owner');
  assert.equal((await invoke({action: 'account.sync'})).data.hasVerifiedPhone, false);
  const verified = await invoke({action: 'account.verifyPhone', payload: {code: 'demo-verified-phone'}});
  assert.equal(verified.ok, true);
  const original = await invoke({action: 'account.profile.get'});
  assert.equal(original.data.profile.name, '陈小满');
  assert.equal(original.data.profile.nickname, '满满');
  assert.deepEqual(original.data.photoUploadTarget, {circleId: 'family_demo', personId: 'f_me'});

  const updated = await invoke({action: 'account.profile.update', payload: {patch: {
    name: '陈小满', country: '中国', province: '江苏', city: '南京',
    birthday: {calendar: 'lunar', month: 3, day: 12}, industry: '设计'
  }}});
  assert.equal(updated.ok, true);
  for (const [circleId, personId] of [['family_demo', 'f_me'], ['class_demo', 'c_me']]) {
    const card = await invoke({action: 'person.get', payload: {circleId, personId}});
    assert.equal(card.data.person.city, '南京');
    assert.equal(card.data.person.industry, '设计');
    assert.deepEqual(card.data.person.birthday, {calendar: 'lunar', month: 3, day: 12});
  }
  const events = await invoke({action: 'birthday.upcoming', payload: {days: 366}});
  assert.equal(events.ok, true);
  assert.equal(events.data.events.some(event => ['f_me', 'c_me', 'phone_demo_me'].includes(event.personId)), false);
  assert.ok(events.data.events.some(event => event.birthdayCalendar === 'lunar' && /^\d{4}-\d{2}-\d{2}$/.test(event.date)));
  assert.equal((await invoke({action: 'account.profile.update', payload: {patch: {birthOrder: 1}}})).error.code, 'INVALID_INPUT');
  assert.equal((await invoke({action: 'account.profile.update', payload: {patch: {city: ''}}})).error.code, 'PROFILE_INCOMPLETE');
});

test('local non-admin identity needs its own phone login and has no management access', async () => {
  resetDemoData();
  await invoke({action: 'account.verifyPhone', payload: {code: 'demo-verified-phone'}});
  assert.equal(setDemoActor('demo-dad'), true);
  assert.equal(getDemoActor(), 'demo-dad');
  assert.equal((await invoke({action: 'account.sync'})).data.hasVerifiedPhone, false);
  assert.equal((await invoke({action: 'circle.list'})).data.circles.length, 1);
  const loggedIn = await invoke({action: 'account.verifyPhone', payload: {code: 'demo-verified-phone'}});
  assert.equal(loggedIn.data.hasVerifiedPhone, true);
  assert.equal((await invoke({action: 'account.sync'})).data.hasVerifiedPhone, true);
  const circles = (await invoke({action: 'circle.list'})).data.circles;
  assert.deepEqual(circles.map(circle => [circle.id, circle.role]), [['family_demo', 'member']]);
  assert.equal((await invoke({action: 'invite.create', payload: {circleId: 'family_demo'}})).error.code, 'FORBIDDEN');
  assert.equal((await invoke({action: 'member.list', payload: {circleId: 'family_demo'}})).data.members.find(member => member.isSelf).name, '陈志远');
  assert.equal((await invoke({action: 'account.profile.get'})).data.profile.name, '陈志远');
  const events = await invoke({action: 'birthday.upcoming', payload: {days: 366}});
  assert.equal(events.data.events.some(event => event.personId === 'f_dad'), false);
  assert.equal(events.data.events.some(event => event.personId === 'f_me'), true);
  resetDemoData();
});

test('one claimed person shared between two records has one upcoming birthday', async () => {
  resetDemoData();
  const db = storage.get('kin-network-demo-db-v2');
  db.persons.push({...db.persons.find(person => person.id === 'f_dad'), id: 'c_dad', circleId: 'class_demo'});
  db.members.push({id: 'm_c_dad', circleId: 'class_demo', name: '陈志远', role: 'member', personId: 'c_dad', status: 'joined', actorId: 'demo-dad'});
  storage.set('kin-network-demo-db-v2', db);
  const all = await invoke({action: 'birthday.upcoming', payload: {days: 366}});
  assert.equal(all.ok, true);
  assert.equal(all.data.events.filter(event => event.personName === '陈志远').length, 1);
});

test('account photo upload works before any person card is linked', async () => {
  resetDemoData();
  setDemoActor('demo-dad');
  const db = storage.get('kin-network-demo-db-v2');
  db.members.find(member => member.actorId === 'demo-dad').personId = undefined;
  db.persons.find(person => person.id === 'f_dad').claimedBy = undefined;
  storage.set('kin-network-demo-db-v2', db);
  assert.equal((await invoke({action: 'account.profile.get'})).data.photoUploadTarget, null);
  const oldEnv = wx.env;
  const oldFs = wx.getFileSystemManager;
  const writes = [];
  try {
    wx.env = {USER_DATA_PATH: '/demo-files'};
    wx.getFileSystemManager = () => ({writeFileSync(path, content, encoding) {writes.push({path, content, encoding});}, unlinkSync() {}});
    const result = await invoke({action: 'photo.upload', payload: {base64: '/9j/2Q=='}});
    assert.equal(result.ok, true);
    assert.equal(result.data.profile.hasPhoto, true);
    const photo = await invoke({action: 'photo.url'});
    assert.equal(photo.data.url, writes[0].path);
    assert.equal(writes[0].encoding, 'base64');
  } finally {
    wx.env = oldEnv;
    wx.getFileSystemManager = oldFs;
    resetDemoData();
  }
});

test('an invited guest needs phone login and the server-side profile supplies the application', async () => {
  resetDemoData();
  const invite = await invoke({action: 'invite.create', payload: {circleId: 'family_demo'}});
  setDemoActor('demo-guest');
  await invoke({action: 'account.profile.update', payload: {patch: {
    name: '张晴', country: '中国', city: '苏州', birthday: {calendar: 'lunar', month: 8, day: 15}
  }}});
  const forged = {token: invite.data.invite.token, name: '伪造姓名', profile: {country: '美国', city: '纽约', birthday: {calendar: 'solar', month: 1, day: 1}}};
  assert.equal((await invoke({action: 'invite.apply', payload: forged})).error.code, 'PHONE_LOGIN_REQUIRED');
  await invoke({action: 'account.verifyPhone', payload: {code: 'demo-verified-phone'}});
  const applied = await invoke({action: 'invite.apply', payload: forged});
  assert.equal(applied.ok, true);
  assert.equal(applied.data.application.applicantName, '张晴');
  assert.equal(applied.data.application.profile.city, '苏州');
  assert.equal(applied.data.application.profile.birthday.calendar, 'lunar');
  resetDemoData();
});

test('a changed applicant profile requires a fresh admin review token', async () => {
  resetDemoData();
  await invoke({action: 'account.verifyPhone', payload: {code: 'demo-verified-phone'}});
  const invite = await invoke({action: 'invite.create', payload: {circleId: 'family_demo'}});
  assert.equal(invite.ok, true);
  setDemoActor('demo-guest');
  await invoke({action: 'account.verifyPhone', payload: {code: 'demo-verified-phone'}});
  await invoke({action: 'account.profile.update', payload: {patch: {
    name: '张晴', country: '中国', city: '苏州', birthday: {calendar: 'solar', month: 8, day: 15}
  }}});
  const application = await invoke({action: 'invite.apply', payload: {token: invite.data.invite.token}});
  assert.equal(application.ok, true);
  setDemoActor('demo-owner');
  const firstReview = (await invoke({action: 'join.list', payload: {circleId: 'family_demo'}})).data.applications[0];
  assert.equal(firstReview.profileChanged, false);
  assert.equal(firstReview.profile.city, '苏州');
  setDemoActor('demo-guest');
  await invoke({action: 'account.profile.update', payload: {patch: {city: '杭州'}}});
  setDemoActor('demo-owner');
  const stale = await invoke({action: 'join.approve', payload: {circleId: 'family_demo', applicationId: application.data.application.id, reviewToken: firstReview.reviewToken}});
  assert.equal(stale.error.code, 'PROFILE_CHANGED');
  const unreviewed = await invoke({action: 'join.approve', payload: {circleId: 'family_demo', applicationId: application.data.application.id}});
  assert.equal(unreviewed.error.code, 'PROFILE_CHANGED');
  const refreshed = (await invoke({action: 'join.list', payload: {circleId: 'family_demo'}})).data.applications[0];
  assert.equal(refreshed.profileChanged, true);
  assert.equal(refreshed.profile.city, '杭州');
  assert.notEqual(refreshed.reviewToken, firstReview.reviewToken);
  const approved = await invoke({action: 'join.approve', payload: {circleId: 'family_demo', applicationId: application.data.application.id, reviewToken: refreshed.reviewToken,
    initialRelation: {anchorPersonId: 'f_me', kind: 'sibling'}}});
  assert.equal(approved.ok, true);
  const linked = (await invoke({action: 'person.list', payload: {circleId: 'family_demo'}})).data.persons.find(person => person.name === '张晴');
  assert.equal(linked.city, '杭州');
  resetDemoData();
});

test('an applicant with a damaged current profile cannot be approved from the old application snapshot', async () => {
  resetDemoData();
  await invoke({action: 'account.verifyPhone', payload: {code: 'demo-verified-phone'}});
  const invite = await invoke({action: 'invite.create', payload: {circleId: 'family_demo'}});
  setDemoActor('demo-guest');
  await invoke({action: 'account.verifyPhone', payload: {code: 'demo-verified-phone'}});
  await invoke({action: 'account.profile.update', payload: {patch: {
    name: '张晴', country: '中国', city: '苏州', birthday: {calendar: 'solar', month: 8, day: 15}
  }}});
  const application = await invoke({action: 'invite.apply', payload: {token: invite.data.invite.token}});
  const db = storage.get('kin-network-demo-db-v2');
  delete db.userProfiles['demo-guest'].city;
  storage.set('kin-network-demo-db-v2', db);
  setDemoActor('demo-owner');
  const review = (await invoke({action: 'join.list', payload: {circleId: 'family_demo'}})).data.applications[0];
  assert.equal(review.profileIncomplete, true);
  assert.equal(review.reviewToken, undefined);
  assert.equal(review.profile, null);
  const result = await invoke({action: 'join.approve', payload: {circleId: 'family_demo', applicationId: application.data.application.id}});
  assert.equal(result.error.code, 'PROFILE_INCOMPLETE');
  resetDemoData();
});

test('membership names follow current profile and this-record administrator corrections', async () => {
  resetDemoData();
  let result = await invoke({action: 'person.update', payload: {circleId: 'family_demo', personId: 'f_dad', patch: {name: '陈志明'}}});
  assert.equal(result.ok, true);
  const memberName = async () => (await invoke({action: 'member.list', payload: {circleId: 'family_demo'}})).data.members.find(member => member.personId === 'f_dad').name;
  assert.equal(await memberName(), '陈志明');
  setDemoActor('demo-dad');
  result = await invoke({action: 'account.profile.update', payload: {patch: {name: '陈志远新名'}}});
  assert.equal(result.ok, true);
  assert.equal(await memberName(), '陈志远新名');
  resetDemoData();
});

test('creating another self card keeps cleared location fields empty and returns the shared profile', async () => {
  resetDemoData();
  const cleared = await invoke({action: 'account.profile.update', payload: {patch: {province: null, latitude: null, longitude: null}}});
  assert.equal(cleared.ok, true);
  const created = await invoke({action: 'circle.create', payload: {name: '另一份家人录', type: 'family', mode: 'shared'}});
  assert.equal(created.ok, true);
  const card = await invoke({action: 'person.create', payload: {circleId: created.data.circle.id, name: '旧姓名', claimSelf: true,
    country: '中国', province: '上海', city: '上海', latitude: 31.2, longitude: 121.5,
    birthday: {calendar: 'solar', month: 10, day: 8}}});
  assert.equal(card.ok, true);
  const profile = (await invoke({action: 'account.profile.get'})).data.profile;
  assert.equal(profile.province, undefined);
  assert.equal(profile.latitude, undefined);
  assert.equal(profile.longitude, undefined);
  assert.equal(card.data.person.name, '陈小满');
  assert.equal(card.data.person.province, undefined);
  resetDemoData();
});
