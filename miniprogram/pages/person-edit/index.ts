import { Circle, Person, invoke, isDemoMode, showApiError } from '../../services/api';
import { CITY_OPTIONS } from '../../utils/geography';
import { q, toast } from '../../utils/navigation';

const STATUS_OPTIONS = ['暂不填写', '读书中', '工作中', '待业中', '退休', '其他'];
const GENDER_OPTIONS = ['暂不填写', '男', '女'];
const GENDER_VALUES = ['unknown', 'male', 'female'];
const PROFILE_FIELDS = ['name','nickname','gender','birthOrder','country','province','city','status','industry','occupation','school','bio','phone','wechatId','photoFileId'];
const BARE_FIELDS = ['name','nickname','gender','birthOrder'];
function accessFor(fields: string[]): Record<string, boolean> {
  const access: Record<string, boolean> = {};
  PROFILE_FIELDS.forEach(field => { access[field] = fields.indexOf(field) >= 0; });
  return access;
}

Page({
  data: {
    circle: null as Circle | null, personId: '', isNew: true, isSelf: false, claimSelf: false, canPrivate: false,
    form: { name: '', nickname: '', gender: 'unknown', birthOrder: '', city: '', country: '', province: '', latitude: 0, longitude: 0, status: '', industry: '', occupation: '', school: '', bio: '', phone: '', wechatId: '', photoUrl: '', photoFileId: '' },
    cityLabels: ['暂不填写'].concat(CITY_OPTIONS.map(c => `${c.city}${c.country === '中国' ? '' : ' · ' + c.country}`)), cityIndex: 0,
    statusOptions: STATUS_OPTIONS, statusIndex: 0, genderOptions: GENDER_OPTIONS, genderIndex: 0,
    saving: false, showClaimSelf: false, initial: '人', editable: accessFor(BARE_FIELDS)
  },
  onLoad(this: any, options: any) { this.circleId = options.circleId; this.personId = options.personId || ''; this.loadData(); },
  async loadData(this: any) {
    const [detail, list] = await Promise.all([
      invoke<{ circle: Circle }>({ action: 'circle.detail', payload: { circleId: this.circleId } }),
      invoke<{ persons: Person[] }>({ action: 'person.list', payload: { circleId: this.circleId } })
    ]);
    if (!detail.ok) return showApiError(detail);
    const hasSelf = list.ok && list.data.persons.some(p => p.isSelf);
    if (!this.personId) {
      this.setData({ circle: detail.data.circle, isNew: true, claimSelf: !hasSelf, canPrivate: !hasSelf, showClaimSelf: !hasSelf, editable: accessFor(hasSelf ? BARE_FIELDS : PROFILE_FIELDS) });
      wx.setNavigationBarTitle({ title: '添加人物' });
      return;
    }
    const person = await invoke<{ person: Person }>({ action: 'person.get', payload: { circleId: this.circleId, personId: this.personId } });
    if (!person.ok) return showApiError(person);
    const p = person.data.person;
    const optionIndex = CITY_OPTIONS.findIndex(c => c.city === p.city && c.country === (p.country || '中国'));
    const delegatedFields: string[] = (p as any).myDelegatedFields || [];
    const editable = accessFor(p.isSelf ? PROFILE_FIELDS : p.isClaimed ? delegatedFields : BARE_FIELDS);
    this.setData({ circle: detail.data.circle, personId: p.id, isNew: false, isSelf: !!p.isSelf, canPrivate: !!p.isSelf || !!(p as any).myDelegatedFields?.length,
      editable,
      form: { name: p.name || '', nickname: p.nickname || '', gender: p.gender || 'unknown', birthOrder: p.birthOrder ? String(p.birthOrder) : '', city: p.city || '', country: p.country || '', province: p.province || '', latitude: p.latitude || 0, longitude: p.longitude || 0, status: p.status || '', industry: p.industry || '', occupation: p.occupation || '', school: p.school || '', bio: p.bio || '', phone: p.phone || '', wechatId: p.wechatId || '', photoUrl: p.photoUrl || '', photoFileId: p.photoFileId || '' },
      initial: p.name ? p.name.slice(-1) : '人',
      cityIndex: optionIndex + 1, statusIndex: Math.max(0, STATUS_OPTIONS.indexOf(p.status || '暂不填写')), genderIndex: Math.max(0, GENDER_VALUES.indexOf(p.gender || 'unknown')) });
    wx.setNavigationBarTitle({ title: p.isSelf ? '编辑我的资料' : '编辑人物卡' });
  },
  onInput(this: any, e: any) {
    const field = e.currentTarget.dataset.field;
    const geographic = field === 'city' || field === 'country' || field === 'province';
    this.setData({ [`form.${field}`]: e.detail.value, ...(field === 'name' ? { initial: e.detail.value ? e.detail.value.slice(-1) : '人' } : {}), ...(geographic ? { cityIndex: 0, 'form.latitude': 0, 'form.longitude': 0 } : {}) });
  },
  onGender(this: any, e: any) { const index = Number(e.detail.value); this.setData({ genderIndex: index, 'form.gender': GENDER_VALUES[index] }); },
  onStatus(this: any, e: any) { const index = Number(e.detail.value); this.setData({ statusIndex: index, 'form.status': index ? STATUS_OPTIONS[index] : '' }); },
  onCity(this: any, e: any) {
    const index = Number(e.detail.value);
    const city = CITY_OPTIONS[index - 1];
    this.setData({ cityIndex: index, 'form.city': city?.city || '', 'form.country': city?.country || '', 'form.province': city?.province || '', 'form.latitude': city?.latitude || 0, 'form.longitude': city?.longitude || 0 });
  },
  onClaimSelf(this: any, e: any) { const selected = !!e.detail.value; this.setData({ claimSelf: selected, canPrivate: selected, editable: accessFor(selected ? PROFILE_FIELDS : BARE_FIELDS) }); },
  onChoosePhoto(this: any) {
    wx.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'], success: (choice: any) => {
      const temp = choice.tempFilePaths && choice.tempFilePaths[0]; if (!temp) return;
      this.photoPath = temp;
      if (isDemoMode()) {
        wx.saveFile({ tempFilePath: temp, success: (saved: any) => { this.photoPath = saved.savedFilePath; this.setData({ 'form.photoUrl': saved.savedFilePath }); }, fail: () => this.setData({ 'form.photoUrl': temp }) });
      } else this.setData({ 'form.photoUrl': temp });
    } });
  },
  async uploadSelectedPhoto(this: any, personId: string): Promise<boolean> {
    if (!this.photoPath || isDemoMode()) return true;
    const info: any = await new Promise(resolve => wx.getImageInfo({ src: this.photoPath, success: resolve, fail: () => resolve(null) }));
    if (!info || (info.type !== 'jpeg' && info.type !== 'jpg')) { toast('目前请上传 JPG 照片'); return false; }
    const file: any = await new Promise(resolve => wx.getFileInfo({ filePath: this.photoPath, success: resolve, fail: () => resolve(null) }));
    if (!file || file.size > 1024 * 1024) { toast('照片需小于 1 MB，请选择较小的 JPG'); return false; }
    const base64: string = await new Promise(resolve => wx.getFileSystemManager().readFile({ filePath: this.photoPath, encoding: 'base64', success: (r: any) => resolve(r.data), fail: () => resolve('') }));
    if (!base64) { toast('照片读取失败，请重试'); return false; }
    const uploaded = await invoke({ action: 'photo.upload', payload: { circleId: this.circleId, personId, base64 } });
    if (!uploaded.ok) { showApiError(uploaded); return false; }
    return true;
  },
  async onSave(this: any) {
    const f = this.data.form;
    if (!f.name.trim()) return toast('请填写姓名');
    this.setData({ saving: true });
    let personId = this.personId;
    if (this.data.isNew) {
      const created = await invoke<{ person: Person }>({ action: 'person.create', payload: { circleId: this.circleId, name: f.name.trim(), gender: f.gender, birthOrder: f.birthOrder ? Number(f.birthOrder) : undefined, claimSelf: this.data.claimSelf } });
      if (!created.ok) { this.setData({ saving: false }); return showApiError(created); }
      personId = created.data.person.id;
    }
    const candidate: any = { name: f.name.trim(), nickname: f.nickname.trim(), gender: f.gender, birthOrder: f.birthOrder ? Number(f.birthOrder) : '', city: f.city, country: f.country, province: f.province, status: f.status, industry: f.industry.trim(), occupation: f.occupation.trim(), school: f.school.trim(), bio: f.bio.trim(), phone: f.phone.trim(), wechatId: f.wechatId.trim() };
    const patch: any = {};
    Object.keys(candidate).forEach(key => { if (this.data.editable[key]) patch[key] = candidate[key]; });
    if (isDemoMode() && this.data.editable.city) { patch.latitude = f.latitude; patch.longitude = f.longitude; }
    if (isDemoMode() && this.data.editable.photoFileId) patch.photoUrl = f.photoUrl;
    const updated = await invoke({ action: 'person.update', payload: { circleId: this.circleId, personId, patch } });
    this.setData({ saving: false });
    if (!updated.ok) return showApiError(updated);
    if (!(await this.uploadSelectedPhoto(personId))) { this.personId = personId; this.setData({ isNew: false }); return; }
    toast('人物卡已保存');
    wx.redirectTo({ url: `/pages/person/index?circleId=${q(this.circleId)}&personId=${q(personId)}` });
  }
});
