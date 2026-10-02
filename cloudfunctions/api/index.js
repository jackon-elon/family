const cloud = require('wx-server-sdk');
const { ApiService } = require('./lib/service');
const { CloudBaseRepository } = require('./lib/cloudbase-repository');
const { handlePhotoUpload } = require('./photo-upload');
const { handleInviteCode } = require('./invite-code');

cloud.init({env: cloud.DYNAMIC_CURRENT_ENV});

// This function is intended only for wx.cloud.callFunction event calls from the
// bound Mini Program. Do not attach a public HTTP trigger to this entry point.
exports.main = async (event) => {
  const {OPENID} = cloud.getWXContext();
  // Explicit environment-scoped database client for server-side access. Every
  // operation still passes application-level role and visibility checks.
  const db = cloud.database({env: cloud.DYNAMIC_CURRENT_ENV});
  const signPhoto = async fileID => {
    const result = await cloud.getTempFileURL({fileList: [{fileID, maxAge: 60}]});
    const item = result.fileList && result.fileList[0];
    if (!item || !item.tempFileURL) throw new Error('Could not sign photo URL');
    return item.tempFileURL;
  };
  const api = new ApiService(new CloudBaseRepository(db), Date.now, signPhoto);
  if (event && event.action === 'photo.upload') return handlePhotoUpload(event, OPENID, api, cloud);
  if (event && event.action === 'invite.code') return handleInviteCode(event, OPENID, api, cloud);
  return api.invoke(event || {}, OPENID);
};
