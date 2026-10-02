/* Create the real WeChat Mini Program code for an active one-use invitation. */
async function handleInviteCode(event, actorId, api, cloud) {
  const payload = event && event.payload || {};
  const circleId = payload.circleId;
  const token = payload.token;
  if (typeof circleId !== 'string' || !circleId || typeof token !== 'string' || !token) {
    return {ok: false, error: {code: 'INVALID_INPUT', message: '缺少圈子或邀请口令'}};
  }
  // invite.list is administrator-only. The public invite.preview alone is not
  // sufficient to authorize generation of a code containing its secret token.
  const admin = await api.invoke({action: 'invite.list', payload: {circleId}}, actorId);
  if (!admin.ok) return admin;
  const preview = await api.invoke({action: 'invite.preview', payload: {token}}, actorId);
  if (!preview.ok) return preview;
  if (preview.data.circle.id !== circleId) {
    return {ok: false, error: {code: 'FORBIDDEN', message: '邀请不属于当前圈子'}};
  }
  if (preview.data.status !== 'active') {
    return {ok: false, error: {code: 'INVITE_INACTIVE', message: '邀请已失效，请重新生成'}};
  }
  if (!cloud.openapi || !cloud.openapi.wxacode || typeof cloud.openapi.wxacode.getUnlimited !== 'function') {
    return {ok: false, error: {code: 'NOT_CONFIGURED', message: '当前云环境尚未开通小程序码能力'}};
  }
  try {
    const requestedVersion = process.env.WX_CODE_ENV_VERSION;
    const envVersion = ['release', 'trial', 'develop'].includes(requestedVersion) ? requestedVersion : 'release';
    const response = await cloud.openapi.wxacode.getUnlimited({
      scene: token,
      page: 'pages/apply/index',
      width: 280,
      checkPath: false,
      envVersion
    });
    const raw = Buffer.isBuffer(response) ? response : response && (response.buffer || response.data);
    const bytes = Buffer.isBuffer(raw) ? raw : raw instanceof Uint8Array ? Buffer.from(raw) : raw && raw.data ? Buffer.from(raw.data) : null;
    if (!bytes || bytes.length < 8 || bytes.length > 700000 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      return {ok: false, error: {code: 'QR_UNAVAILABLE', message: '小程序码生成失败，请使用微信分享'}};
    }
    return {ok: true, data: {imageBase64: bytes.toString('base64')}};
  } catch (_) {
    return {ok: false, error: {code: 'QR_UNAVAILABLE', message: '小程序码生成失败，请检查云环境与小程序绑定'}};
  }
}

module.exports = {handleInviteCode};
