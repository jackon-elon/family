const assert = require('node:assert/strict');
const test = require('node:test');
const {handleInviteCode} = require('../../cloudfunctions/api/invite-code');

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('mini-code')]);
function fixture(adminAllowed = true, status = 'active', previewCircleId = 'family') {
  const calls = [];
  const api = {invoke: async request => {
    calls.push(request);
    if (request.action === 'invite.list') return adminAllowed ? {ok: true, data: {invites: []}} : {ok: false, error: {code: 'FORBIDDEN', message: '只有管理员可以查看邀请'}};
    if (request.action === 'invite.preview') return {ok: true, data: {circle: {id: previewCircleId}, status}};
    throw new Error('unexpected action');
  }};
  let openApiCalls = 0;
  const cloud = {openapi: {wxacode: {getUnlimited: async options => {openApiCalls++; calls.push(options); return {buffer: png};}}}};
  return {api, cloud, calls, get openApiCalls() {return openApiCalls;}};
}

test('mini program code requires administrator access before touching WeChat open API', async () => {
  const sample = fixture(false);
  const result = await handleInviteCode({payload: {circleId: 'family', token: 'token'}}, 'user', sample.api, sample.cloud);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'FORBIDDEN');
  assert.equal(sample.openApiCalls, 0);
  assert.deepEqual(sample.calls.map(call => call.action), ['invite.list']);
});

test('mini program code only represents an active invite in the same circle', async () => {
  for (const sample of [fixture(true, 'active', 'other'), fixture(true, 'revoked')]) {
    const result = await handleInviteCode({payload: {circleId: 'family', token: 'token'}}, 'admin', sample.api, sample.cloud);
    assert.equal(result.ok, false);
    assert.equal(sample.openApiCalls, 0);
  }
});

test('one-use invite token is carried as the scan scene for the apply page', async () => {
  const sample = fixture();
  const result = await handleInviteCode({payload: {circleId: 'family', token: 'A'.repeat(32)}}, 'admin', sample.api, sample.cloud);
  assert.equal(result.ok, true);
  assert.deepEqual(Buffer.from(result.data.imageBase64, 'base64'), png);
  assert.equal(sample.openApiCalls, 1);
  assert.equal(sample.calls[2].scene, 'A'.repeat(32));
  assert.equal(sample.calls[2].page, 'pages/apply/index');
});

test('unexpected open API response is never shown as a code', async () => {
  const sample = fixture();
  sample.cloud.openapi.wxacode.getUnlimited = async () => ({buffer: Buffer.from('error')});
  const result = await handleInviteCode({payload: {circleId: 'family', token: 'A'.repeat(32)}}, 'admin', sample.api, sample.cloud);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'QR_UNAVAILABLE');
});
