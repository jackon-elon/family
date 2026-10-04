const cloud = require('wx-server-sdk');
const { ApiService } = require('./lib/service');
const { CloudBaseRepository } = require('./lib/cloudbase-repository');
const { handlePhotoUpload } = require('./photo-upload');
const { handleInviteCode } = require('./invite-code');
const { handlePhoneVerify } = require('./phone-verify');

cloud.init({env: cloud.DYNAMIC_CURRENT_ENV});

// This function is intended only for wx.cloud.callFunction event calls from the
// bound Mini Program. Do not attach a public HTTP trigger to this entry point.
exports.main = async (event) => {
  const {OPENID, APPID} = cloud.getWXContext();
  // Explicit environment-scoped database client for server-side access. Every
  // operation still passes application-level role and visibility checks.
  const db = cloud.database({env: cloud.DYNAMIC_CURRENT_ENV});
  const signPhoto = async fileID => {
    const result = await cloud.getTempFileURL({fileList: [{fileID, maxAge: 60}]});
    const item = result.fileList && result.fileList[0];
    if (!item || !item.tempFileURL) throw new Error('Could not sign photo URL');
    return item.tempFileURL;
  };
  const signPhotos = async fileIDs => {
    const result = await cloud.getTempFileURL({fileList: fileIDs.map(fileID => ({fileID, maxAge: 60}))});
    const urls = {};
    for (const item of result.fileList || []) {
      if (fileIDs.includes(item.fileID) && item.tempFileURL) urls[item.fileID] = item.tempFileURL;
    }
    return urls;
  };
  const api = new ApiService(new CloudBaseRepository(db), Date.now, signPhoto, signPhotos);
  const action = event && event.action;
  // Every private call must originate from a phone-verified session, including
  // direct cloud-function calls that bypass the mini-program pages.
  if (!['account.sync', 'account.verifyPhone', 'invite.preview'].includes(action)) {
    const session = await api.invoke({action: 'account.sync'}, OPENID);
    if (!session.ok) return session;
    if (!session.data.hasVerifiedPhone) return {ok: false, error: {code: 'PHONE_LOGIN_REQUIRED', message: '请先用微信手机号登录'}};
  }
  if (event && event.action === 'photo.upload') return handlePhotoUpload(event, OPENID, api, cloud);
  if (event && event.action === 'invite.code') return handleInviteCode(event, OPENID, api, cloud);
  if (event && event.action === 'account.verifyPhone') return handlePhoneVerify(event, OPENID, APPID, api, cloud);
  return api.invoke(event || {}, OPENID);
};
