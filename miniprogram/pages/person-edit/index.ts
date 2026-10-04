import { Birthday, Circle, Person, Role, invoke, isDemoMode, resolvePhotoUrls, showApiError } from '../../services/api';
import { confirm, newRequestId, q, toast } from '../../utils/navigation';
import { birthdayDayIndex, birthdayDayOptions } from '../../utils/birthday-form';

const STATUS_OPTIONS = ['暂不填写', '读书中', '工作中', '待业中', '退休', '其他'];
const GENDER_OPTIONS = ['暂不填写', '男', '女'];
const GENDER_VALUES = ['unknown', 'male', 'female'];
const PROFILE_FIELDS = ['name','nickname','gender','birthOrder','country','province','city','birthday','status','industry','occupation','school','bio','phone','wechatId','photoFileId'];
const BARE_FIELDS = ['name','nickname','gender','birthOrder','country','province','city','birthday'];
const CALENDAR_OPTIONS = ['阳历', '农历'];
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => `${i + 1} 月`);
const RELATION_CHOICES = [
  { label: '请选择关系', kind: '', gender: '', older: '' },
  { label: '爸爸', kind: 'newParent', gender: 'male', older: '' },
  { label: '妈妈', kind: 'newParent', gender: 'female', older: '' },
  { label: '哥哥', kind: 'sibling', gender: 'male', older: 'new' },
  { label: '姐姐', kind: 'sibling', gender: 'female', older: 'new' },
  { label: '弟弟', kind: 'sibling', gender: 'male', older: 'anchor' },
  { label: '妹妹', kind: 'sibling', gender: 'female', older: 'anchor' },
  { label: '儿子', kind: 'newChild', gender: 'male', older: '' },
  { label: '女儿', kind: 'newChild', gender: 'female', older: '' },
  { label: '丈夫', kind: 'spouse', gender: 'male', older: '' },
  { label: '妻子', kind: 'spouse', gender: 'female', older: '' },
  { label: '父母（性别未填）', kind: 'newParent', gender: '', older: '' },
  { label: '子女（性别未填）', kind: 'newChild', gender: '', older: '' },
  { label: '配偶（性别未填）', kind: 'spouse', gender: '', older: '' },
  { label: '兄弟姐妹（按生日判断长幼）', kind: 'sibling', gender: '', older: 'unknown' }
];
function relationKindOptions(name: string, self = false): string[] {
  const person = name || '所选家人';
  const subject = self ? '我' : 'TA ';
  return RELATION_CHOICES.map((choice, index) => index ? `${subject}是${person}的${choice.label}` : choice.label);
}
const RELATION_OLDER_OPTIONS = ['长幼暂不确定', '新添加的 TA 年长', '已选的家人年长'];
const RELATION_OLDER = ['unknown', 'new', 'anchor'];
const MAX_PHOTO_BYTES = 1024 * 1024;
function imageInfo(path: string): Promise<any> {
  return new Promise(resolve => wx.getImageInfo({ src: path, success: resolve, fail: () => resolve(null) }));
}
function fileSize(path: string): Promise<number> {
  return new Promise(resolve => wx.getFileInfo({ filePath: path, success: (file: any) => resolve(file.size || 0), fail: () => resolve(0) }));
}
function removeDemoSavedPhoto(path: string): Promise<void> {
  if (!path || !wx.removeSavedFile) return Promise.resolve();
  return new Promise(resolve => wx.removeSavedFile({ filePath: path, success: () => resolve(), fail: () => resolve() }));
}
function accessFor(fields: string[]): Record<string, boolean> {
  const access: Record<string, boolean> = {};
  PROFILE_FIELDS.forEach(field => { access[field] = fields.indexOf(field) >= 0; });
  return access;
}

Page({
  data: {
    circle: null as Circle | null, personId: '', isNew: true, isSelf: false, isAdmin: false, claimSelf: false, canPrivate: false, hasPhoto: false, createMode: 'other',
    form: { name: '', nickname: '', gender: 'unknown', birthOrder: '', city: '', country: '', province: '', latitude: null as number | null, longitude: null as number | null, birthYear: '', status: '', industry: '', occupation: '', school: '', bio: '', phone: '', matchPhone: '', wechatId: '', photoUrl: '', photoFileId: '' },
    calendarOptions: CALENDAR_OPTIONS, calendarIndex: 0, monthOptions: MONTH_OPTIONS, monthIndex: -1, dayOptions: birthdayDayOptions(0, -1, ''), dayIndex: -1, leapMonth: false,
    statusOptions: STATUS_OPTIONS, statusIndex: 0, genderOptions: GENDER_OPTIONS, genderIndex: 0,
    relationTargetIds: [] as string[], relationTargetNames: ['请选择已有家人'] as string[], relationTargetPersonNames: [] as string[], relationTargetIndex: 0,
    relationKindOptions: relationKindOptions(''), relationKindIndex: 0, relationNeedsOlder: false, relationOlderOptions: RELATION_OLDER_OPTIONS, relationOlderIndex: 0,
    optionalExpanded: false, selfProfileReady: false, deferRelation: false, relationHelpExpanded: false,
    saving: false, photoChecking: false, photoSelected: false, savedPersonId: '',
    initial: '人', editable: accessFor(BARE_FIELDS), similarCards: [] as Person[], pendingClaim: false, loading: true, loadError: ''
  },
  async onLoad(this: any, options: any) {
    this.circleId = options.circleId; this.personId = options.personId || ''; this.createMode = options.purpose === 'self' ? 'self' : 'other'; this.createRequestId = this.personId ? '' : newRequestId();
    this.setData({optionalExpanded: options.focus === 'photo'});
    await this.loadData();
    if (options.focus === 'photo' && !this.data.loadError) wx.pageScrollTo({selector: '#optional-section', duration: 0});
  },
  async loadData(this: any) {
    if (!this.circleId) { this.setData({loading: false, loadError: '请返回亲友录重新打开'}); return; }
    this.setData({loading: true, loadError: ''});
    const [detail, list, claims] = await Promise.all([
      invoke<{ circle: Circle }>({ action: 'circle.detail', payload: { circleId: this.circleId } }),
      invoke<{ persons: Person[] }>({ action: 'person.list', payload: { circleId: this.circleId } }),
      invoke<{ claimRequests: Array<{status: string}> }>({ action: 'person.claimMine', payload: { circleId: this.circleId } })
    ]);
    if (!detail.ok || !list.ok || !claims.ok) {
      const failed = [detail, list, claims].find(result => !result.ok);
      this.setData({loading: false, loadError: failed && !failed.ok ? failed.error.message : '加载失败，请重试'}); return;
    }
    const hasSelf = list.data.persons.some(p => p.isSelf);
    if (!this.personId) {
      if (this.createMode === 'self' && hasSelf) {
        const self = list.data.persons.find(p => p.isSelf)!;
        toast('这里已经有你的资料了');
        wx.redirectTo({ url: `/pages/person/index?circleId=${q(this.circleId)}&personId=${q(self.id)}` });
        return;
      }
      const createSelf = this.createMode === 'self' && !hasSelf;
      const pendingClaim = claims.data.claimRequests.some(request => request.status === 'pending');
      this.availableCards = list.data.persons.filter(p => !p.isClaimed && !p.isSelf);
      const role = (detail.data as any).role as Role | undefined;
      const admin = role === 'owner' || role === 'admin' || detail.data.circle.role === 'owner' || detail.data.circle.role === 'admin';
      if (!createSelf && !admin) { this.setData({loading: false, loadError: '只有管理员可以添加他人，请从「我的」进入管理页'}); return; }
      const targets = detail.data.circle.type === 'family' ? list.data.persons : [];
      const ownIndex = targets.findIndex(person => person.isSelf);
      let selfProfile: Partial<Person> = {};
      if (createSelf) {
        const profile = await invoke<{profile: Partial<Person> | null}>({action: 'account.profile.get'});
        if (!profile.ok) { this.setData({loading: false, loadError: profile.error.message}); return; }
        selfProfile = profile.data.profile || {};
      }
      const birthYear = selfProfile.birthday?.year ? String(selfProfile.birthday.year) : '';
      const calendarIndex = selfProfile.birthday?.calendar === 'lunar' ? 1 : 0;
      const monthIndex = selfProfile.birthday ? selfProfile.birthday.month - 1 : -1;
      this.setData({ circle: detail.data.circle, isNew: true, isAdmin: admin, createMode: createSelf ? 'self' : 'other', claimSelf: createSelf, canPrivate: true, editable: {...accessFor(createSelf || admin ? PROFILE_FIELDS : BARE_FIELDS), matchPhone: !createSelf && admin}, pendingClaim,
        relationTargetIds: targets.map(person => person.id), relationTargetNames: ['请选择已有家人', ...targets.map(person => `${person.isSelf ? '我 · ' : ''}${person.name}${person.city ? ' · ' + person.city : ''}`)],
        relationTargetPersonNames: targets.map(person => person.name),
        relationTargetIndex: ownIndex >= 0 ? ownIndex + 1 : targets.length ? 1 : 0,
        relationKindOptions: relationKindOptions(targets[ownIndex >= 0 ? ownIndex : 0]?.name || '', createSelf), relationKindIndex: 0, relationNeedsOlder: false, relationOlderIndex: 0, loading: false,
        ...(createSelf ? {
          form: {...this.data.form, name: selfProfile.name || '', nickname: selfProfile.nickname || '', gender: selfProfile.gender || 'unknown', country: selfProfile.country || '', province: selfProfile.province || '', city: selfProfile.city || '', latitude: selfProfile.latitude ?? null, longitude: selfProfile.longitude ?? null, birthYear, status: selfProfile.status || '', industry: selfProfile.industry || '', occupation: selfProfile.occupation || '', school: selfProfile.school || '', bio: selfProfile.bio || '', phone: selfProfile.phone || '', wechatId: selfProfile.wechatId || '', photoUrl: selfProfile.photoUrl || '', photoFileId: selfProfile.photoFileId || ''},
          initial: selfProfile.name ? selfProfile.name.slice(-1) : '我', hasPhoto: !!selfProfile.hasPhoto,
          calendarIndex, monthIndex, dayOptions: birthdayDayOptions(calendarIndex, monthIndex, birthYear), dayIndex: selfProfile.birthday ? selfProfile.birthday.day - 1 : -1, leapMonth: !!selfProfile.birthday?.leapMonth,
          statusIndex: Math.max(0, STATUS_OPTIONS.indexOf(selfProfile.status || '暂不填写')), genderIndex: Math.max(0, GENDER_VALUES.indexOf(selfProfile.gender || 'unknown')),
          selfProfileReady: !!(selfProfile.name && selfProfile.country && selfProfile.city && selfProfile.birthday)
        } : {}) });
      if (createSelf) this.updateSimilarCards(selfProfile.name || '');
      wx.setNavigationBarTitle({ title: createSelf ? '填写我的资料' : detail.data.circle.type === 'family' ? '添加家人' : '添加同学' });
      return;
    }
    const person = await invoke<{ person: Person }>({ action: 'person.get', payload: { circleId: this.circleId, personId: this.personId } });
    if (!person.ok) { this.setData({loading: false, loadError: person.error.message}); return; }
    const p = (await resolvePhotoUrls(this.circleId, [person.data.person]))[0];
    this.originalPhotoPath = isDemoMode() ? p.photoUrl || '' : '';
    const role = (detail.data as any).role as Role | undefined;
    const admin = role === 'owner' || role === 'admin' || detail.data.circle.role === 'owner' || detail.data.circle.role === 'admin';
    if (!admin && !p.isSelf) { this.setData({loading: false, loadError: '只有管理员可以修改他人资料'}); return; }
    const editable = {...accessFor(PROFILE_FIELDS), matchPhone: admin && !p.isClaimed};
    let matchPhone = '';
    if (editable.matchPhone) {
      const match = await invoke<{matchPhone?: string}>({action: 'person.matchPhone', payload: {circleId: this.circleId, personId: p.id}});
      if (!match.ok) { this.setData({loading: false, loadError: match.error.message}); return; }
      matchPhone = match.data.matchPhone || '';
    }
    this.setData({ circle: detail.data.circle, personId: p.id, isNew: false, isSelf: !!p.isSelf, isAdmin: admin, canPrivate: true, hasPhoto: !!p.hasPhoto,
      editable,
      form: { name: p.name || '', nickname: p.nickname || '', gender: p.gender || 'unknown', birthOrder: p.birthOrder ? String(p.birthOrder) : '', city: p.city || '', country: p.country || '', province: p.province || '', latitude: p.latitude ?? null, longitude: p.longitude ?? null, birthYear: p.birthday?.year ? String(p.birthday.year) : '', status: p.status || '', industry: p.industry || '', occupation: p.occupation || '', school: p.school || '', bio: p.bio || '', phone: p.phone || '', matchPhone, wechatId: p.wechatId || '', photoUrl: p.photoUrl || '', photoFileId: p.photoFileId || '' },
      initial: p.name ? p.name.slice(-1) : '人', calendarIndex: p.birthday?.calendar === 'lunar' ? 1 : 0, monthIndex: p.birthday ? p.birthday.month - 1 : -1, dayOptions: birthdayDayOptions(p.birthday?.calendar === 'lunar' ? 1 : 0, p.birthday ? p.birthday.month - 1 : -1, p.birthday?.year ? String(p.birthday.year) : ''), dayIndex: p.birthday ? p.birthday.day - 1 : -1, leapMonth: !!p.birthday?.leapMonth,
      statusIndex: Math.max(0, STATUS_OPTIONS.indexOf(p.status || '暂不填写')), genderIndex: Math.max(0, GENDER_VALUES.indexOf(p.gender || 'unknown')), loading: false });
    wx.setNavigationBarTitle({ title: p.isSelf ? '编辑我的资料' : '编辑资料' });
  },
  onRetry(this: any) { if (!this.data.loading) return this.loadData(); },
  onHome() { wx.reLaunch({url: '/pages/circles/index'}); },
  onInput(this: any, e: any) {
    if (this.data.saving || this.data.savedPersonId) return;
    const field = e.currentTarget.dataset.field;
    const value = e.detail.value;
    const extra = field === 'birthYear' ? (() => {
      const dayOptions = birthdayDayOptions(this.data.calendarIndex, this.data.monthIndex, value);
      return {dayOptions, dayIndex: birthdayDayIndex(this.data.dayIndex, dayOptions)};
    })() : {};
    this.setData({ [`form.${field}`]: value, ...(field === 'name' ? { initial: value ? value.slice(-1) : '人' } : {}), ...extra });
    if (field === 'phone' && this.data.isNew && this.data.editable.matchPhone) this.setData({'form.matchPhone': value});
    if (field === 'matchPhone') this.matchPhoneTouched = true;
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
  onReviewExisting(this: any) { if (!this.data.saving && !this.data.savedPersonId) wx.redirectTo({ url: `/pages/circle/index?circleId=${q(this.circleId)}&match=1` }); },
  onToggleOptional(this: any) { this.setData({optionalExpanded: !this.data.optionalExpanded}); },
  onGender(this: any, e: any) {
    if (this.data.saving || this.data.savedPersonId) return;
    const index = Number(e.detail.value);
    if (!Number.isInteger(index) || index < 0 || index >= GENDER_VALUES.length) return;
    const gender = GENDER_VALUES[index];
    const relation = RELATION_CHOICES[this.data.relationKindIndex];
    // An explicit title such as "爸爸" must never be saved with an incompatible gender.
    const resetRelation = !!relation?.gender && relation.gender !== gender;
    this.setData({genderIndex: index, 'form.gender': gender, ...(resetRelation ? {relationKindIndex: 0, relationNeedsOlder: false, relationOlderIndex: 0} : {})});
    if (resetRelation) toast('性别已更改，请重新选择关系');
  },
  onStatus(this: any, e: any) { if (this.data.saving || this.data.savedPersonId) return; const index = Number(e.detail.value); this.setData({ statusIndex: index, 'form.status': index ? STATUS_OPTIONS[index] : '' }); },
  onRelationTarget(this: any, e: any) {
    if (this.data.saving || this.data.savedPersonId) return;
    const index = Number(e.detail.value);
    if (!Number.isInteger(index) || index < 0 || index >= this.data.relationTargetNames.length) return;
    this.setData({relationTargetIndex: index, relationKindOptions: relationKindOptions(this.data.relationTargetPersonNames[index - 1] || '', this.data.createMode === 'self'), relationKindIndex: 0, relationNeedsOlder: false, relationOlderIndex: 0});
  },
  onRelationKind(this: any, e: any) {
    if (this.data.saving || this.data.savedPersonId) return;
    const index = Number(e.detail.value);
    if (!Number.isInteger(index) || index < 0 || index >= RELATION_CHOICES.length) return;
    const choice = RELATION_CHOICES[index];
    const gender = choice.gender || (choice.kind && choice.kind !== 'sibling' ? 'unknown' : '');
    this.setData({relationKindIndex: index, relationNeedsOlder: choice.kind === 'sibling' && choice.older === 'unknown', relationOlderIndex: 0,
      ...(gender ? {genderIndex: GENDER_VALUES.indexOf(gender), 'form.gender': gender} : {})});
  },
  onDeferRelation(this: any, e: any) {
    if (!this.data.isNew || this.data.circle?.type !== 'family' || this.data.saving) return;
    this.setData({deferRelation: !!e.detail.value});
  },
  onToggleRelationHelp(this: any) { this.setData({relationHelpExpanded: !this.data.relationHelpExpanded}); },
  onRelationOlder(this: any, e: any) {
    if (this.data.saving || this.data.savedPersonId) return;
    const index = Number(e.detail.value);
    if (Number.isInteger(index) && index >= 0 && index < RELATION_OLDER.length) this.setData({relationOlderIndex: index});
  },
  onCalendar(this: any, e: any) {
    if (this.data.saving || this.data.savedPersonId) return;
    const calendarIndex = Number(e.detail.value);
    if (calendarIndex !== 0 && calendarIndex !== 1) return;
    const dayOptions = birthdayDayOptions(calendarIndex, this.data.monthIndex, this.data.form.birthYear);
    this.setData({ calendarIndex, dayOptions, dayIndex: birthdayDayIndex(this.data.dayIndex, dayOptions), leapMonth: false });
  },
  onBirthMonth(this: any, e: any) {
    if (this.data.saving || this.data.savedPersonId) return;
    const monthIndex = Number(e.detail.value);
    if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex >= 12) return;
    const dayOptions = birthdayDayOptions(this.data.calendarIndex, monthIndex, this.data.form.birthYear);
    this.setData({monthIndex, dayOptions, dayIndex: birthdayDayIndex(this.data.dayIndex, dayOptions)});
  },
  onBirthDay(this: any, e: any) {
    if (this.data.saving || this.data.savedPersonId) return;
    const dayIndex = Number(e.detail.value);
    if (Number.isInteger(dayIndex) && dayIndex >= 0 && dayIndex < this.data.dayOptions.length) this.setData({dayIndex});
  },
  onLeapMonth(this: any, e: any) { if (!this.data.saving && !this.data.savedPersonId) this.setData({ leapMonth: !!e.detail.value }); },
  onChooseCityPoint(this: any) {
    if (this.data.saving || this.data.savedPersonId) return;
    wx.navigateTo({
      url: '/pages/location-picker/index',
      events: {
        cityLocationSelected: (selected: {city: string; country: string; province: string; latitude: number | null; longitude: number | null}) => {
          if (this.data.saving || this.data.savedPersonId) return;
          this.setData({
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
  async preparePhoto(this: any, source: string): Promise<string> {
    const info = await imageInfo(source);
    if (!info || !info.width || !info.height) throw new Error('无法读取这张照片，请选择 JPG 或 PNG 图片');
    // Always draw onto a fresh canvas so JPEG EXIF metadata (including GPS)
    // is not carried into the file saved locally or sent to the cloud.
    const canvas: any = await new Promise(resolve => wx.createSelectorQuery().in(this).select('#photoCanvas').fields({ node: true }).exec((nodes: any[]) => resolve(nodes?.[0]?.node || null)));
    if (!canvas) throw new Error('当前设备暂无法安全处理照片，请稍后重试或换一台设备');
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
    if (this.data.loading || this.data.loadError || !this.data.isAdmin && !this.data.isSelf && !(this.data.isNew && this.data.claimSelf)) return;
    if (this.data.photoChecking || this.data.saving || this.data.savedPersonId) return;
    wx.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'], success: async (choice: any) => {
      if (this.data.saving || this.data.savedPersonId) return;
      const temp = choice.tempFilePaths && choice.tempFilePaths[0]; if (!temp) return;
      this.setData({ photoChecking: true });
      try {
        const prepared = await this.preparePhoto(temp);
        this.photoPath = prepared;
        this.setData({ 'form.photoUrl': prepared, photoSelected: true });
      } catch (error: any) { toast(error?.message || '照片处理失败，请重试'); }
      finally { this.setData({ photoChecking: false }); }
    }, fail: (error: any) => { if (!/cancel/i.test(error?.errMsg || '')) toast('暂时无法打开相册或相机'); } });
  },
  async persistDemoPhoto(this: any): Promise<string> {
    const saved: any = await new Promise(resolve => wx.saveFile({ tempFilePath: this.photoPath, success: resolve, fail: () => resolve(null) }));
    if (!saved?.savedFilePath) throw new Error('本地照片保存失败，请重试');
    return saved.savedFilePath;
  },
  async uploadSelectedPhoto(this: any, personId: string): Promise<boolean> {
    if (!this.photoPath || isDemoMode()) return true;
    const info = await imageInfo(this.photoPath);
    if (!info || (info.type !== 'jpeg' && info.type !== 'jpg')) { toast('照片转换失败，请重新选择'); return false; }
    const size = await fileSize(this.photoPath);
    if (!size || size > MAX_PHOTO_BYTES) { toast('照片超过 1 MB，请重新选择'); return false; }
    const base64: string = await new Promise(resolve => wx.getFileSystemManager().readFile({ filePath: this.photoPath, encoding: 'base64', success: (r: any) => resolve(r.data), fail: () => resolve('') }));
    if (!base64) { toast('照片读取失败，请重试'); return false; }
    const uploaded = await invoke({ action: 'photo.upload', payload: { circleId: this.circleId, personId, base64 } });
    if (!uploaded.ok) { showApiError(uploaded); return false; }
    return true;
  },
  async onSavePhoto(this: any) {
    if (this.data.loading || this.data.loadError || !this.data.isAdmin && !this.data.isSelf) return;
    if (this.data.isNew || !this.photoPath || this.data.photoChecking || this.data.saving) return;
    this.setData({ saving: true });
    let uploaded = true;
    if (this.photoPath && isDemoMode()) {
      let savedPath = '';
      try { savedPath = await this.persistDemoPhoto(); }
      catch (error: any) { toast(error?.message || '本地照片保存失败，请重试'); uploaded = false; }
      if (uploaded) {
        const result = await invoke({ action: 'person.update', payload: { circleId: this.circleId, personId: this.personId, patch: { photoUrl: savedPath } } });
        if (!result.ok) { await removeDemoSavedPhoto(savedPath); showApiError(result); uploaded = false; }
        else if (this.originalPhotoPath && this.originalPhotoPath !== savedPath) await removeDemoSavedPhoto(this.originalPhotoPath);
      }
    } else if (this.photoPath) uploaded = await this.uploadSelectedPhoto(this.personId);
    this.setData({ saving: false });
    if (!uploaded) return;
    this.photoPath = '';
    toast('照片已保存');
    wx.redirectTo({ url: `/pages/person/index?circleId=${q(this.circleId)}&personId=${q(this.personId)}` });
  },
  async onSave(this: any) {
    if (this.data.loading || this.data.loadError) return toast('资料还没加载好，请重试');
    if (this.data.savedPersonId) return this.openSavedPerson();
    if (!this.data.isAdmin && !this.data.isSelf && !(this.data.isNew && this.data.claimSelf)) return toast('只有管理员可以修改他人资料');
    if (this.data.saving) return;
    if (this.data.photoChecking) return toast('请稍等照片处理完成');
    const f = this.data.form;
    if (!f.name.trim()) return toast('请填写姓名');
    if (this.data.isNew && this.createMode === 'self') {
      if (!this.data.claimSelf) return toast('这里已经有你的资料了');
      if (this.data.pendingClaim) return toast('已提交，等待管理员确认');
    }
    if (this.data.editable.city && !f.city.trim()) return toast('请逐级选择所在城市');
    if (this.data.editable.city && !f.country.trim()) return toast('请先选择国家或地区');
    if (this.data.editable.birthday && (this.data.monthIndex < 0 || this.data.dayIndex < 0 || this.data.dayIndex >= this.data.dayOptions.length)) return toast('请填写有效的生日月日并选择阳历或农历');
    const birthYear = f.birthYear.trim() ? Number(f.birthYear.trim()) : undefined;
    if (birthYear !== undefined && (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > 2100)) return toast('出生年份请填 1900 至 2100 年');
    const creatingFamily = this.data.isNew && this.data.circle?.type === 'family';
    const deferRelation = creatingFamily && !!this.data.deferRelation;
    const relationTargetId = creatingFamily && !deferRelation ? this.data.relationTargetIds[this.data.relationTargetIndex - 1] : undefined;
    if (creatingFamily && !deferRelation && this.data.relationTargetIds.length && !relationTargetId) return toast('请先选择一位已有家人，再填写两人的关系');
    if (relationTargetId && !this.data.relationKindIndex) return toast('请选择两人的关系');
    const relationChoice = RELATION_CHOICES[this.data.relationKindIndex];
    if (relationTargetId && !relationChoice?.kind) return toast('请选择两人的关系');
    if (relationTargetId && relationChoice.gender && relationChoice.gender !== f.gender) return toast('性别与所选关系不一致，请重新选择关系');
    const initialRelation = relationTargetId ? {anchorPersonId: relationTargetId, kind: relationChoice.kind,
      ...(relationChoice.kind === 'sibling' ? {older: relationChoice.older === 'unknown' ? RELATION_OLDER[this.data.relationOlderIndex] : relationChoice.older} : {})} : undefined;
    const birthday: Birthday | undefined = this.data.editable.birthday ? {
      calendar: this.data.calendarIndex === 1 ? 'lunar' : 'solar', month: this.data.monthIndex + 1, day: this.data.dayIndex + 1,
      ...(birthYear !== undefined ? { year: birthYear } : {}), ...(this.data.calendarIndex === 1 && this.data.leapMonth ? { leapMonth: true } : {})
    } : undefined;
    this.setData({ saving: true });
    if (this.data.isNew && this.createMode === 'self' && this.data.similarCards.length &&
      !(await confirm('这里可能已经有你', `已有「${this.data.similarCards.map((p: Person) => p.name).join('、')}」。如果都不是你，再继续添加。`))) {
      this.setData({saving: false}); return;
    }
    let personId = this.personId;
    let createdSelf = false;
    let keptPreviousRelation = false;
    if (this.data.isNew) {
      const matchPhone = this.data.editable.matchPhone ? f.phone.trim() || f.matchPhone.trim() : '';
      const currentCreatePayload = { circleId: this.circleId, name: f.name.trim(), gender: f.gender, birthOrder: f.birthOrder ? Number(f.birthOrder) : undefined, country: f.country.trim(), province: f.province.trim(), city: f.city.trim(), ...(typeof f.latitude === 'number' && typeof f.longitude === 'number' ? { latitude: f.latitude, longitude: f.longitude } : {}), birthday, claimSelf: this.data.claimSelf, ...(matchPhone ? {matchPhone} : {}), ...(initialRelation ? {initialRelation} : {}), ...(deferRelation ? {deferRelation: true} : {}) };
      if (this.pendingCreatePayload && JSON.stringify(currentCreatePayload) !== JSON.stringify(this.pendingCreatePayload) &&
        !(await confirm('先确认上次创建', '先确认上次添加是否成功，再保存这次改的资料。关系沿用上次选择；要更改关系，请保存后到“我的 → 管理 → 关系”调整。'))) {
        this.setData({saving: false}); return;
      }
      keptPreviousRelation = !!this.pendingCreatePayload && JSON.stringify({initial: this.pendingCreatePayload.initialRelation, defer: this.pendingCreatePayload.deferRelation}) !== JSON.stringify({initial: currentCreatePayload.initialRelation, defer: currentCreatePayload.deferRelation});
      this.pendingCreatePayload = this.pendingCreatePayload || currentCreatePayload;
      this.createRequestId = this.createRequestId || newRequestId();
      const created = await invoke<{ person: Person }>({ action: 'person.create', payload: { ...this.pendingCreatePayload, requestId: this.createRequestId } });
      if (!created.ok) {
        if (!['NETWORK', 'SERVER_ERROR', 'BAD_RESPONSE'].includes(created.error.code)) { this.pendingCreatePayload = null; this.createRequestId = newRequestId(); }
        this.setData({ saving: false }); return showApiError(created);
      }
      personId = created.data.person.id;
      createdSelf = !!created.data.person.isSelf;
      this.pendingCreatePayload = null; this.createRequestId = '';
    }
    const candidate: any = { name: f.name.trim(), nickname: f.nickname.trim(), gender: f.gender, birthOrder: f.birthOrder ? Number(f.birthOrder) : '', city: f.city, country: f.country, province: f.province, birthday, status: f.status, industry: f.industry.trim(), occupation: f.occupation.trim(), school: f.school.trim(), bio: f.bio.trim(), phone: f.phone.trim(), wechatId: f.wechatId.trim() };
    const patch: any = {};
    Object.keys(candidate).forEach(key => { if (this.data.editable[key]) patch[key] = candidate[key]; });
    if (this.data.editable.city) { patch.latitude = f.latitude; patch.longitude = f.longitude; }
    const preserveCreatedCard = () => {
      if (this.data.isNew) {
        this.personId = personId;
        this.setData({ isNew: false, personId, isSelf: createdSelf, claimSelf: false });
      }
    };
    let savedDemoPhoto = '';
    if (this.photoPath && isDemoMode() && this.data.editable.photoFileId) {
      try { savedDemoPhoto = await this.persistDemoPhoto(); }
      catch (error: any) { preserveCreatedCard(); this.setData({ saving: false }); toast(error?.message || '本地照片保存失败，请重试'); return; }
      patch.photoUrl = savedDemoPhoto;
    }
    const updated = await invoke({ action: 'person.update', payload: { circleId: this.circleId, personId, patch, ...(this.matchPhoneTouched && this.data.editable.matchPhone ? {matchPhone: f.matchPhone.trim() || null} : {}) } });
    if (!updated.ok) {
      await removeDemoSavedPhoto(savedDemoPhoto);
      const wasNew = this.data.isNew;
      preserveCreatedCard();
      this.setData({ saving: false });
      if (wasNew) return wx.showModal({ title: '资料已创建', content: `详细资料暂未保存：${updated.error.message}。请修改后再次保存。`, showCancel: false });
      return showApiError(updated);
    }
    if (savedDemoPhoto && this.originalPhotoPath && this.originalPhotoPath !== savedDemoPhoto) await removeDemoSavedPhoto(this.originalPhotoPath);
    if (!(await this.uploadSelectedPhoto(personId))) { preserveCreatedCard(); this.setData({ saving: false }); return; }
    preserveCreatedCard();
    this.setData({ saving: false, savedPersonId: personId, photoSelected: false });
    this.photoPath = '';
    toast(keptPreviousRelation ? '资料已保存，关系沿用上次选择' : '资料已保存');
    this.openSavedPerson();
  },
  openSavedPerson(this: any) {
    wx.redirectTo({ url: `/pages/person/index?circleId=${q(this.circleId)}&personId=${q(this.data.savedPersonId)}`,
      fail: () => toast('资料已保存，点击下方按钮重新打开') });
  }
});
