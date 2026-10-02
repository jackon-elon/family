import { Circle, Person, invoke, isDemoMode, resolvePhotoUrls, showApiError } from '../../services/api';
import { CITY_OPTIONS, cityOption } from '../../utils/geography';
import { confirm, q, toast } from '../../utils/navigation';

const STATUS_OPTIONS = ['暂不填写', '读书中', '工作中', '待业中', '退休', '其他'];
const GENDER_OPTIONS = ['暂不填写', '男', '女'];
const GENDER_VALUES = ['unknown', 'male', 'female'];
const PROFILE_FIELDS = ['name','nickname','gender','birthOrder','country','province','city','status','industry','occupation','school','bio','phone','wechatId','photoFileId'];
const BARE_FIELDS = ['name','nickname','gender','birthOrder'];
const MAX_PHOTO_BYTES = 1024 * 1024;
function imageInfo(path: string): Promise<any> {
  return new Promise(resolve => wx.getImageInfo({ src: path, success: resolve, fail: () => resolve(null) }));
}
function fileSize(path: string): Promise<number> {
  return new Promise(resolve => wx.getFileInfo({ filePath: path, success: (file: any) => resolve(file.size || 0), fail: () => resolve(0) }));
}
function accessFor(fields: string[]): Record<string, boolean> {
  const access: Record<string, boolean> = {};
  PROFILE_FIELDS.forEach(field => { access[field] = fields.indexOf(field) >= 0; });
  return access;
}

Page({
  data: {
    circle: null as Circle | null, personId: '', isNew: true, isSelf: false, claimSelf: false, canPrivate: false, hasPhoto: false, createMode: 'other',
    form: { name: '', nickname: '', gender: 'unknown', birthOrder: '', city: '', country: '', province: '', latitude: null as number | null, longitude: null as number | null, status: '', industry: '', occupation: '', school: '', bio: '', phone: '', wechatId: '', photoUrl: '', photoFileId: '' },
    cityLabels: ['暂不填写'].concat(CITY_OPTIONS.map(c => `${c.city}${c.country === '中国' ? '' : ' · ' + c.country}`)), cityIndex: 0,
    statusOptions: STATUS_OPTIONS, statusIndex: 0, genderOptions: GENDER_OPTIONS, genderIndex: 0,
    saving: false, photoChecking: false, photoSelected: false, photoVisibilityIndex: 0, photoVisibilitySavedIndex: 0, photoVisibilityDirty: false,
    initial: '人', editable: accessFor(BARE_FIELDS), similarCards: [] as Person[], pendingClaim: false
  },
  onLoad(this: any, options: any) { this.circleId = options.circleId; this.personId = options.personId || ''; this.createMode = options.purpose === 'self' ? 'self' : 'other'; this.loadData(); },
  async loadData(this: any) {
    const [detail, list, claims] = await Promise.all([
      invoke<{ circle: Circle }>({ action: 'circle.detail', payload: { circleId: this.circleId } }),
      invoke<{ persons: Person[] }>({ action: 'person.list', payload: { circleId: this.circleId } }),
      invoke<{ claimRequests: Array<{status: string}> }>({ action: 'person.claimMine', payload: { circleId: this.circleId } })
    ]);
    if (!detail.ok) return showApiError(detail);
    const hasSelf = list.ok && list.data.persons.some(p => p.isSelf);
    if (!this.personId) {
      if (this.createMode === 'self' && hasSelf && list.ok) {
        const self = list.data.persons.find(p => p.isSelf)!;
        toast('你在本圈已有本人卡，无需再创建');
        wx.redirectTo({ url: `/pages/person/index?circleId=${q(this.circleId)}&personId=${q(self.id)}` });
        return;
      }
      const createSelf = this.createMode === 'self' && !hasSelf;
      const pendingClaim = claims.ok && claims.data.claimRequests.some(request => request.status === 'pending');
      this.availableCards = list.ok ? list.data.persons.filter(p => !p.isClaimed && !p.isSelf) : [];
      this.setData({ circle: detail.data.circle, isNew: true, createMode: createSelf ? 'self' : 'other', claimSelf: createSelf, canPrivate: createSelf, editable: accessFor(createSelf ? PROFILE_FIELDS : BARE_FIELDS), pendingClaim });
      wx.setNavigationBarTitle({ title: createSelf ? '创建我的人物卡' : '添加未加入的人物卡' });
      return;
    }
    const person = await invoke<{ person: Person }>({ action: 'person.get', payload: { circleId: this.circleId, personId: this.personId } });
    if (!person.ok) return showApiError(person);
    const p = (await resolvePhotoUrls(this.circleId, [person.data.person]))[0];
    const optionIndex = CITY_OPTIONS.findIndex(c => c.city === p.city && c.country === (p.country || '中国'));
    const delegatedFields: string[] = (p as any).myDelegatedFields || [];
    const editable = accessFor(p.isSelf ? PROFILE_FIELDS : p.isClaimed ? delegatedFields : BARE_FIELDS);
    this.setData({ circle: detail.data.circle, personId: p.id, isNew: false, isSelf: !!p.isSelf, canPrivate: !!p.isSelf || !!(p as any).myDelegatedFields?.length, hasPhoto: !!p.hasPhoto,
      editable,
      form: { name: p.name || '', nickname: p.nickname || '', gender: p.gender || 'unknown', birthOrder: p.birthOrder ? String(p.birthOrder) : '', city: p.city || '', country: p.country || '', province: p.province || '', latitude: p.latitude ?? CITY_OPTIONS[optionIndex]?.latitude ?? null, longitude: p.longitude ?? CITY_OPTIONS[optionIndex]?.longitude ?? null, status: p.status || '', industry: p.industry || '', occupation: p.occupation || '', school: p.school || '', bio: p.bio || '', phone: p.phone || '', wechatId: p.wechatId || '', photoUrl: p.photoUrl || '', photoFileId: p.photoFileId || '' },
      initial: p.name ? p.name.slice(-1) : '人', photoVisibilityIndex: p.visibility?.photoFileId === 'circle' ? 1 : 0,
      photoVisibilitySavedIndex: p.visibility?.photoFileId === 'circle' ? 1 : 0, photoVisibilityDirty: false,
      cityIndex: optionIndex + 1, statusIndex: Math.max(0, STATUS_OPTIONS.indexOf(p.status || '暂不填写')), genderIndex: Math.max(0, GENDER_VALUES.indexOf(p.gender || 'unknown')) });
    wx.setNavigationBarTitle({ title: p.isSelf ? '编辑我的资料' : '编辑人物卡' });
  },
  onInput(this: any, e: any) {
    const field = e.currentTarget.dataset.field;
    const geographic = field === 'city' || field === 'country' || field === 'province';
    this.setData({ [`form.${field}`]: e.detail.value, ...(field === 'name' ? { initial: e.detail.value ? e.detail.value.slice(-1) : '人' } : {}), ...(geographic ? { cityIndex: 0, 'form.latitude': null, 'form.longitude': null } : {}) });
    if (field === 'name' && this.data.createMode === 'self') this.updateSimilarCards(e.detail.value);
  },
  updateSimilarCards(this: any, value: string) {
    const name = String(value || '').replace(/\s/g, '').toLowerCase();
    const similar = name.length >= 2 ? (this.availableCards || []).filter((person: Person) =>
      [person.name, person.nickname].filter(Boolean).some(candidate => {
        const other = String(candidate).replace(/\s/g, '').toLowerCase();
        return other.includes(name) || name.includes(other);
      })).slice(0, 5) : [];
    this.setData({ similarCards: similar });
  },
  onReviewExisting(this: any) { wx.redirectTo({ url: `/pages/circle/index?circleId=${q(this.circleId)}` }); },
  onGender(this: any, e: any) { const index = Number(e.detail.value); this.setData({ genderIndex: index, 'form.gender': GENDER_VALUES[index] }); },
  onStatus(this: any, e: any) { const index = Number(e.detail.value); this.setData({ statusIndex: index, 'form.status': index ? STATUS_OPTIONS[index] : '' }); },
  onCity(this: any, e: any) {
    const index = Number(e.detail.value);
    const city = CITY_OPTIONS[index - 1];
    this.setData({ cityIndex: index, 'form.city': city?.city || '', 'form.country': city?.country || '', 'form.province': city?.province || '', 'form.latitude': city?.latitude ?? null, 'form.longitude': city?.longitude ?? null });
  },
  onChooseCityPoint(this: any) {
    wx.navigateTo({
      url: '/pages/location-picker/index',
      events: {
        cityLocationSelected: (selected: {city: string; country: string; province: string; latitude: number; longitude: number}) => {
          const option = cityOption(selected.city, selected.country);
          this.setData({
            cityIndex: option ? CITY_OPTIONS.indexOf(option) + 1 : 0,
            'form.city': selected.city,
            'form.country': selected.country,
            'form.province': selected.province,
            'form.latitude': selected.latitude,
            'form.longitude': selected.longitude
          });
        }
      },
      success: (res: any) => res.eventChannel.emit('initialCityLocation', {
        city: this.data.form.city,
        country: this.data.form.country,
        province: this.data.form.province,
        latitude: this.data.form.latitude,
        longitude: this.data.form.longitude
      })
    });
  },
  onPhotoVisibility(this: any, e: any) {
    const index = Number(e.currentTarget?.dataset?.index ?? e.detail?.value);
    this.setData({ photoVisibilityIndex: index, photoVisibilityDirty: index !== this.data.photoVisibilitySavedIndex });
  },
  async preparePhoto(this: any, source: string): Promise<string> {
    const info = await imageInfo(source);
    if (!info || !info.width || !info.height) throw new Error('无法读取这张照片，请选择 JPG 或 PNG 图片');
    const inputSize = await fileSize(source);
    if ((info.type === 'jpeg' || info.type === 'jpg') && inputSize > 0 && inputSize <= MAX_PHOTO_BYTES) return source;
    const canvas: any = await new Promise(resolve => wx.createSelectorQuery().in(this).select('#photoCanvas').fields({ node: true }).exec((nodes: any[]) => resolve(nodes?.[0]?.node || null)));
    if (!canvas) throw new Error('照片处理暂不可用，请换一张较小的 JPG 照片');
    const picture: any = canvas.createImage();
    await new Promise<void>((resolve, reject) => {
      picture.onload = () => resolve();
      picture.onerror = () => reject(new Error('无法转换这张照片，请换一张 JPG 或 PNG 图片'));
      picture.src = source;
    });
    for (const longest of [1280, 1024, 800, 640]) {
      const scale = Math.min(1, longest / Math.max(info.width, info.height));
      const width = Math.max(1, Math.round(info.width * scale));
      const height = Math.max(1, Math.round(info.height * scale));
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      context.drawImage(picture, 0, 0, width, height);
      for (const quality of [0.82, 0.66, 0.5]) {
        const output: any = await new Promise(resolve => wx.canvasToTempFilePath({
          canvas, x: 0, y: 0, width, height, destWidth: width, destHeight: height,
          fileType: 'jpg', quality, success: resolve, fail: () => resolve(null)
        }));
        if (output?.tempFilePath) {
          const size = await fileSize(output.tempFilePath);
          if (size > 0 && size <= MAX_PHOTO_BYTES) {
            const converted = await imageInfo(output.tempFilePath);
            if (converted?.type === 'jpeg' || converted?.type === 'jpg') return output.tempFilePath;
          }
        }
      }
    }
    throw new Error('照片压缩后仍超过 1 MB，请换一张照片');
  },
  onChoosePhoto(this: any) {
    if (this.data.photoChecking || this.data.saving) return;
    wx.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'], success: async (choice: any) => {
      const temp = choice.tempFilePaths && choice.tempFilePaths[0]; if (!temp) return;
      this.setData({ photoChecking: true });
      try {
        let prepared = await this.preparePhoto(temp);
        if (isDemoMode()) {
          const saved: any = await new Promise(resolve => wx.saveFile({ tempFilePath: prepared, success: resolve, fail: () => resolve(null) }));
          if (!saved?.savedFilePath) throw new Error('本地照片保存失败，请重试');
          prepared = saved.savedFilePath;
        }
        this.photoPath = prepared;
        this.setData({ 'form.photoUrl': prepared, photoSelected: true });
      } catch (error: any) { toast(error?.message || '照片处理失败，请重试'); }
      finally { this.setData({ photoChecking: false }); }
    }, fail: (error: any) => { if (!/cancel/i.test(error?.errMsg || '')) toast('暂时无法打开相册或相机'); } });
  },
  async uploadSelectedPhoto(this: any, personId: string): Promise<boolean> {
    if (!this.photoPath || isDemoMode()) return true;
    const info = await imageInfo(this.photoPath);
    if (!info || (info.type !== 'jpeg' && info.type !== 'jpg')) { toast('照片转换失败，请重新选择'); return false; }
    const size = await fileSize(this.photoPath);
    if (!size || size > MAX_PHOTO_BYTES) { toast('照片超过 1 MB，请重新选择'); return false; }
    const base64: string = await new Promise(resolve => wx.getFileSystemManager().readFile({ filePath: this.photoPath, encoding: 'base64', success: (r: any) => resolve(r.data), fail: () => resolve('') }));
    if (!base64) { toast('照片读取失败，请重试'); return false; }
    const payload: any = { circleId: this.circleId, personId, base64 };
    if (this.data.isSelf || this.data.claimSelf) payload.visibility = this.data.photoVisibilityIndex === 1 ? 'circle' : 'self';
    const uploaded = await invoke({ action: 'photo.upload', payload });
    if (!uploaded.ok) { showApiError(uploaded); return false; }
    return true;
  },
  async savePhotoVisibility(this: any, personId: string): Promise<boolean> {
    if (!this.data.isSelf && !this.data.claimSelf) return true;
    const visibility = { photoFileId: this.data.photoVisibilityIndex === 1 ? 'circle' : 'self' };
    const result = await invoke({ action: 'person.update', payload: { circleId: this.circleId, personId, patch: {}, visibility } });
    if (!result.ok) { showApiError(result); return false; }
    return true;
  },
  async onSavePhoto(this: any) {
    if (this.data.isNew || (!this.photoPath && !this.data.photoVisibilityDirty) || this.data.photoChecking || this.data.saving) return;
    this.setData({ saving: true });
    let uploaded = true;
    if (this.photoPath && isDemoMode()) {
      const visibility = this.data.isSelf ? { photoFileId: this.data.photoVisibilityIndex === 1 ? 'circle' : 'self' } : undefined;
      const result = await invoke({ action: 'person.update', payload: { circleId: this.circleId, personId: this.personId, patch: { photoUrl: this.data.form.photoUrl }, ...(visibility ? { visibility } : {}) } });
      if (!result.ok) { showApiError(result); uploaded = false; }
    } else if (this.photoPath) uploaded = await this.uploadSelectedPhoto(this.personId);
    if (uploaded && !this.photoPath) uploaded = await this.savePhotoVisibility(this.personId);
    this.setData({ saving: false });
    if (!uploaded) return;
    this.photoPath = '';
    toast(this.data.photoSelected ? '照片已保存' : '照片可见范围已保存');
    wx.redirectTo({ url: `/pages/person/index?circleId=${q(this.circleId)}&personId=${q(this.personId)}` });
  },
  async onSave(this: any) {
    if (this.data.photoChecking || this.data.saving) return toast('请稍等照片处理完成');
    const f = this.data.form;
    if (!f.name.trim()) return toast('请填写姓名');
    if (this.data.isNew && this.createMode === 'self') {
      if (!this.data.claimSelf) return toast('你在本圈已有本人卡');
      if (this.data.pendingClaim) return toast('认领申请正在审核，请先等待管理员处理');
      if (this.data.similarCards.length && !(await confirm('可能已有你的卡', `找到 ${this.data.similarCards.map((p: Person) => p.name).join('、')}。请先核对；确认这些卡都不是你，才新建一张。`))) return;
    }
    if (this.data.editable.city && f.city.trim() &&
      (typeof f.latitude !== 'number' || typeof f.longitude !== 'number')) return toast('请在地图上选城市中心');
    this.setData({ saving: true });
    let personId = this.personId;
    let createdSelf = false;
    if (this.data.isNew) {
      const created = await invoke<{ person: Person }>({ action: 'person.create', payload: { circleId: this.circleId, name: f.name.trim(), gender: f.gender, birthOrder: f.birthOrder ? Number(f.birthOrder) : undefined, claimSelf: this.data.claimSelf } });
      if (!created.ok) { this.setData({ saving: false }); return showApiError(created); }
      personId = created.data.person.id;
      createdSelf = !!created.data.person.isSelf;
    }
    const candidate: any = { name: f.name.trim(), nickname: f.nickname.trim(), gender: f.gender, birthOrder: f.birthOrder ? Number(f.birthOrder) : '', city: f.city, country: f.country, province: f.province, status: f.status, industry: f.industry.trim(), occupation: f.occupation.trim(), school: f.school.trim(), bio: f.bio.trim(), phone: f.phone.trim(), wechatId: f.wechatId.trim() };
    const patch: any = {};
    Object.keys(candidate).forEach(key => { if (this.data.editable[key]) patch[key] = candidate[key]; });
    if (this.data.editable.city) { patch.latitude = f.latitude; patch.longitude = f.longitude; }
    if (isDemoMode() && this.data.editable.photoFileId) patch.photoUrl = f.photoUrl;
    const preserveCreatedCard = () => {
      if (this.data.isNew) {
        this.personId = personId;
        this.setData({ isNew: false, personId, isSelf: createdSelf, claimSelf: false });
      }
    };
    const visibility = this.photoPath && isDemoMode() && (this.data.isSelf || this.data.claimSelf)
      ? { photoFileId: this.data.photoVisibilityIndex === 1 ? 'circle' : 'self' } : undefined;
    const updated = await invoke({ action: 'person.update', payload: { circleId: this.circleId, personId, patch, ...(visibility ? { visibility } : {}) } });
    if (!updated.ok) {
      const wasNew = this.data.isNew;
      preserveCreatedCard();
      this.setData({ saving: false });
      if (wasNew) return wx.showModal({ title: '人物卡已创建', content: `详细资料暂未保存：${updated.error.message}。请修改后再次保存这张卡。`, showCancel: false });
      return showApiError(updated);
    }
    if (!(await this.uploadSelectedPhoto(personId))) { preserveCreatedCard(); this.setData({ saving: false }); return; }
    if (!this.photoPath && this.data.photoVisibilityDirty && !(await this.savePhotoVisibility(personId))) { preserveCreatedCard(); this.setData({ saving: false }); return; }
    this.setData({ saving: false });
    toast('人物卡已保存');
    wx.redirectTo({ url: `/pages/person/index?circleId=${q(this.circleId)}&personId=${q(personId)}` });
  }
});
