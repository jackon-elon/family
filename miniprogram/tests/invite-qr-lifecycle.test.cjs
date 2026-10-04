const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
function fixture(handler) {
  let definition; const calls = [], writes = [], copied = [], messages = [], routes = [];
  const modules = {
    '../../services/api': {invoke: request => {calls.push(request); return handler(request);}, isDemoMode: () => false, showApiError: result => messages.push(result.error.message)},
    '../../utils/navigation': {confirm: async () => true, dateText: () => '2026-10-03', go: url => routes.push(url), q: encodeURIComponent, toast: text => messages.push(text)}
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../pages/invite/index.ts'), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2018}}).outputText, {
    exports: {}, Page: value => {definition = value;}, require: name => modules[name], Date,
    wx: {env: {USER_DATA_PATH: '/local'}, getFileSystemManager: () => ({writeFileSync: (...args) => writes.push(args)}),
      setClipboardData: args => copied.push(args.data), hideShareMenu() {}, showShareMenu() {}}
  });
  const page = {...definition, circleId: 'family', data: structuredClone(definition.data), setData(patch) {Object.assign(this.data, patch);}};
  Object.assign(page.data, {circle: {id: 'family', name: '家人', type: 'family', mode: 'shared'}, loading: false, demoMode: false});
  return {page, calls, writes, copied, messages, routes};
}
const invite = id => ({id, token: `token-${id}`, status: 'active', expiresAt: Date.now() + 60000});
const goodQr = {ok: true, data: {imageBase64: 'cG5n'}};

test('late QR response for a revoked invitation cannot overwrite the current invitation QR', async () => {
  const old = deferred();
  const {page, writes} = fixture(request => request.payload.token === 'token-A' ? old.promise : Promise.resolve(goodQr));
  page.data.invite = invite('A');
  const first = page.loadQr(page.data.invite);
  page.data.invite = invite('B');
  await page.loadQr(page.data.invite);
  assert.match(page.data.qrPath, /invite-B\.png$/);
  old.resolve(goodQr); await first;
  assert.match(page.data.qrPath, /invite-B\.png$/);
  assert.equal(writes.length, 1, 'obsolete QR is not even written to disk');
});

test('revoked or expired invitation cannot return as a QR, clipboard token or share link', async () => {
  const result = deferred();
  const {page, copied, writes, routes} = fixture(() => result.promise);
  page.data.invite = invite('A');
  const qr = page.loadQr(page.data.invite);
  page.data.invite = null;
  result.resolve(goodQr); await qr;
  assert.equal(page.data.qrPath, ''); assert.equal(writes.length, 0);
  page.data.invite = {...invite('expired'), expiresAt: Date.now() - 1};
  page.onCopy(); page.onPreview();
  assert.deepEqual(copied, []); assert.deepEqual(routes, []);
  assert.equal(page.onShareAppMessage().path, '/pages/circles/index');
});

test('failed access refresh clears old invitation and does not share it from the native menu', async () => {
  const {page} = fixture(async () => ({ok: false, error: {code: 'FORBIDDEN', message: '已取消管理员'}}));
  page.data.invite = invite('old'); page.data.qrPath = '/local/old.png';
  await page.loadData();
  assert.equal(page.data.invite, null); assert.equal(page.data.qrPath, '');
  assert.equal(page.onShareAppMessage().path, '/pages/circles/index');
});

test('an older successful refresh cannot replace a newer access-denied result', async () => {
  const slow = deferred(); let delayed = true;
  const {page} = fixture(request => {
    if (!delayed) return Promise.resolve({ok: false, error: {code: 'FORBIDDEN', message: '已取消管理员'}});
    return slow.promise.then(() => ({ok: true, data: request.action === 'circle.detail' ? {circle: {id: 'family'}, role: 'owner'} : request.action === 'person.list' ? {persons: []} : {invites: [invite('old')]}}));
  });
  page.data.invite = invite('old');
  const before = page.loadData(); delayed = false;
  await page.loadData(); slow.resolve(); await before;
  assert.equal(page.data.loadError, '已取消管理员'); assert.equal(page.data.invite, null);
});

test('temporary refresh failure blocks sharing but keeps the invitation for recovery and QR retry', async () => {
  let offline = true;
  const current = invite('recover');
  const {page, writes} = fixture(async request => {
    if (offline) return {ok: false, error: {code: 'NETWORK', message: '网络中断'}};
    return {ok: true, data: request.action === 'circle.detail' ? {circle: {id: 'family'}, role: 'owner'} : request.action === 'person.list' ? {persons: []} : request.action === 'invite.list' ? {invites: [current]} : goodQr.data};
  });
  page.data.invite = current;
  await page.loadData();
  assert.equal(page.onShareAppMessage().path, '/pages/circles/index');
  assert.equal(page.data.invite.token, current.token, 'retry must not lose a successfully created token');
  offline = false; await page.loadData();
  assert.match(page.onShareAppMessage().path, /token=token-recover/);
  await page.onRetryQr();
  assert.match(page.data.qrPath, /invite-recover\.png$/); assert.equal(writes.length, 1);
});
