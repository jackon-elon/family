const MAX_BYTES = 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_BYTES / 3) * 4;

function invalid(message) {return {ok: false, error: {code: 'INVALID_IMAGE', message}};}

function deletionSucceeded(result, fileID) {
  if (!result || (result.code && result.code !== 'SUCCESS') ||
    (result.errCode !== undefined && result.errCode !== 0) || !Array.isArray(result.fileList)) return false;
  // wx-server-sdk reports a per-file numeric status; CloudBase's Node SDK
  // reports a per-file code. A resolved call alone does not mean deletion.
  return result.fileList.some(item => item.fileID === fileID &&
    (item.status === undefined || item.status === 0) &&
    (item.code === undefined || item.code === 'SUCCESS') &&
    (item.status === 0 || item.code === 'SUCCESS'));
}

function isStartOfFrame(marker) {
  return marker === 0xc0 || marker === 0xc1 || marker === 0xc2;
}

/** Remove EXIF, XMP, ICC, comments and other APP metadata from every JPEG scan. */
function stripJpegMetadata(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not JPEG');
  const chunks = [bytes.subarray(0, 2)];
  let cursor = 2;
  let inScan = false;
  let sawScan = false;
  let sawFrame = false;
  let sawQuantization = false;
  let sawHuffman = false;
  while (cursor < bytes.length) {
    if (inScan) {
      const scanStart = cursor;
      while (cursor < bytes.length) {
        if (bytes[cursor] !== 0xff) {cursor++; continue;}
        const markerStart = cursor;
        while (cursor < bytes.length && bytes[cursor] === 0xff) cursor++;
        if (cursor >= bytes.length) throw new Error('Truncated JPEG scan');
        const marker = bytes[cursor];
        if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {cursor++; continue;}
        if (markerStart === scanStart) throw new Error('Empty JPEG scan');
        chunks.push(bytes.subarray(scanStart, markerStart));
        cursor = markerStart;
        inScan = false;
        break;
      }
      if (inScan) throw new Error('Missing JPEG end marker');
      continue;
    }
    if (bytes[cursor] !== 0xff) throw new Error('Invalid JPEG marker');
    const start = cursor;
    while (cursor < bytes.length && bytes[cursor] === 0xff) cursor++;
    if (cursor >= bytes.length) throw new Error('Truncated JPEG marker');
    const marker = bytes[cursor++];
    if (marker === 0xd9) {
      if (!sawFrame || !sawQuantization || !sawHuffman || !sawScan || cursor !== bytes.length) throw new Error('Invalid JPEG end');
      chunks.push(bytes.subarray(start, cursor));
      return Buffer.concat(chunks);
    }
    if (marker === 0xd8 || marker === 0x00) throw new Error('Unexpected JPEG marker');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) throw new Error('Unexpected JPEG standalone marker');
    if (cursor + 2 > bytes.length) throw new Error('Truncated JPEG segment');
    const length = bytes.readUInt16BE(cursor);
    if (length < 2 || cursor + length > bytes.length) throw new Error('Invalid JPEG segment length');
    const end = cursor + length;
    if (marker === 0xdb) sawQuantization = true;
    if (marker === 0xc4) sawHuffman = true;
    if (isStartOfFrame(marker)) {
      if (sawFrame || length < 11) throw new Error('Invalid JPEG frame');
      const precision = bytes[cursor + 2];
      const height = bytes.readUInt16BE(cursor + 3);
      const width = bytes.readUInt16BE(cursor + 5);
      const components = bytes[cursor + 7];
      if (precision !== 8 || !height || !width || width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024 || components < 1 || components > 4 || length !== 8 + 3 * components) {
        throw new Error('Invalid JPEG dimensions or components');
      }
      sawFrame = true;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4) {
      throw new Error('Unsupported JPEG frame coding');
    }
    if (marker === 0xda && (!sawFrame || !sawQuantization || !sawHuffman || length < 6)) throw new Error('Invalid JPEG scan header');
    const metadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!metadata) chunks.push(bytes.subarray(start, end));
    if (marker === 0xda) {sawScan = true; inScan = true;}
    cursor = end;
  }
  throw new Error('Missing JPEG end');
}

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
  let cleanedBytes;
  try { cleanedBytes = stripJpegMetadata(bytes); }
  catch (_) { return invalid('照片 JPEG 内容无效，请重新选择'); }
  const allowed = await api.reservePhotoUpload({circleId: payload.circleId, personId: payload.personId}, actorId);
  if (!allowed.ok) return allowed;
  // Legacy visibility input is ignored. Every active member of this circle
  // can read a bound portrait; upload and access still require membership.
  let fileID;
  try {
    const uploaded = await storage.uploadFile({cloudPath: allowed.data.cloudPath, fileContent: cleanedBytes});
    fileID = uploaded.fileID;
    if (!fileID) throw new Error('Cloud storage returned no file ID');
    const changed = await api.bindUploadedPhoto({circleId: payload.circleId, personId: payload.personId, fileID}, actorId);
    if (!changed.ok) {
      const cleaned = await storage.deleteFile({fileList: [fileID]}).then(result => deletionSucceeded(result, fileID), () => false);
      if (cleaned) await api.refundPhotoUpload(actorId, allowed.data.reservationId).catch(() => undefined);
      return changed;
    }
    return {ok: true, data: changed.data};
  } catch {
    if (fileID) {
      const cleaned = await storage.deleteFile({fileList: [fileID]}).then(result => deletionSucceeded(result, fileID), () => false);
      if (cleaned) await api.refundPhotoUpload(actorId, allowed.data.reservationId).catch(() => undefined);
    }
    return {ok: false, error: {code: 'UPLOAD_FAILED', message: '照片上传失败，请重试'}};
  }
}

module.exports = {handlePhotoUpload, stripJpegMetadata};
