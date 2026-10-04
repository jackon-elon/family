/* Exchange a user-consented one-time WeChat code inside the cloud function. */
async function handlePhoneVerify(event, actorId, appId, api, cloud) {
  if (!actorId) return {ok: false, error: {code: 'UNAUTHENTICATED', message: '请先登录微信'}};
  const code = event && event.payload && event.payload.code;
  if (typeof code !== 'string' || !code.trim() || code.length > 512) {
    return {ok: false, error: {code: 'INVALID_INPUT', message: '请重新授权微信手机号'}};
  }
  const getPhoneNumber = cloud.openapi && cloud.openapi.phonenumber && cloud.openapi.phonenumber.getPhoneNumber;
  if (typeof getPhoneNumber !== 'function') {
    return {ok: false, error: {code: 'NOT_CONFIGURED', message: '当前云环境尚未开通微信手机号能力'}};
  }
  try {
    const response = await cloud.openapi.phonenumber.getPhoneNumber({code: code.trim()});
    const errorCode = response && (response.errCode === undefined ? response.errcode : response.errCode);
    if (errorCode !== undefined && errorCode !== 0 && errorCode !== '0') throw new Error('Phone code rejected');
    // wx-server-sdk returns phoneInfo; the underlying HTTP API uses phone_info.
    const info = response && (response.phoneInfo || response.phone_info);
    const countryCode = info && String(info.countryCode || '');
    const purePhoneNumber = info && String(info.purePhoneNumber || '');
    if (!/^[1-9]\d{0,3}$/.test(countryCode) || !/^\d{4,14}$/.test(purePhoneNumber)) {
      throw new Error('Invalid verified phone response');
    }
    const watermarkAppId = info && info.watermark && (info.watermark.appid || info.watermark.appId);
    if (appId && watermarkAppId && watermarkAppId !== appId) throw new Error('Unexpected phone app ID');
    return await api.linkVerifiedPhone(actorId, `+${countryCode}${purePhoneNumber}`);
  } catch (_) {
    return {ok: false, error: {code: 'PHONE_VERIFY_FAILED', message: '微信手机号验证失败，请重新授权'}};
  }
}

module.exports = {handlePhoneVerify};
