const MAX_BYTES = 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_BYTES / 3) * 4;

function invalid(message) {return {ok: false, error: {code: 'INVALID_IMAGE', message}};}

// Kept separate from the CloudBase entry point for local tests. The storage
// object has uploadFile/deleteFile methods matching wx-server-sdk.
async function handlePhotoUpload(event, actorId, api, storage) {
  const payload = event && event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalid('照片请求格式错误');
  const base64 = payload.base64;
  if (typeof base64 !== 'string' || !base64 || base64.length > MAX_BASE64_CHARS || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return invalid('请选择不超过 1 MB 的 JPEG 图片');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 4 || bytes.length > MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    return invalid('仅支持不超过 1 MB 的 JPEG 图片');
  }
  const allowed = await api.invoke({action: 'photo.uploadPath', payload: {circleId: payload.circleId, personId: payload.personId}}, actorId);
  if (!allowed.ok) return allowed;
  let fileID;
  try {
    const uploaded = await storage.uploadFile({cloudPath: allowed.data.cloudPath, fileContent: bytes});
    fileID = uploaded.fileID;
    if (!fileID) throw new Error('Cloud storage returned no file ID');
    const changed = await api.invoke({action: 'person.update', payload: {circleId: payload.circleId, personId: payload.personId, patch: {photoFileId: fileID}}}, actorId);
    if (!changed.ok) {
      await storage.deleteFile({fileList: [fileID]}).catch(() => undefined);
      return changed;
    }
    return {ok: true, data: {person: changed.data.person}};
  } catch {
    if (fileID) await storage.deleteFile({fileList: [fileID]}).catch(() => undefined);
    return {ok: false, error: {code: 'UPLOAD_FAILED', message: '照片上传失败，请重试'}};
  }
}

module.exports = {handlePhotoUpload};
