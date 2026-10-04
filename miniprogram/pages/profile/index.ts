import { Birthday, Person, invoke, showApiError } from '../../services/api';
import { BirthdayCalendar } from '../../utils/birthday-calendar';
import { birthdayDayIndex, birthdayDayOptions } from '../../utils/birthday-form';
import { q, toast } from '../../utils/navigation';

const STATUS_OPTIONS = ['暂不填写', '读书中', '工作中', '待业中', '退休', '其他'];
const GENDER_OPTIONS = ['暂不填写', '男', '女'];
const GENDER_VALUES = ['unknown', 'male', 'female'];
const CALENDAR_OPTIONS = ['阳历', '农历'];
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => `${index + 1} 月`);
const MAX_PHOTO_BYTES = 1024 * 1024;

interface AccountProfile extends Partial<Person> { hasPhoto?: boolean }
function imageInfo(path: string): Promise<any> {
  return new Promise(resolve => wx.getImageInfo({src: path, success: resolve, fail: () => resolve(null)}));
}
function fileSize(path: string): Promise<number> {
  return new Promise(resolve => wx.getFileInfo({filePath: path, success: (file: any) => resolve(file.size || 0), fail: () => resolve(0)}));
}

Page({
  data: {
    loading: true, loadError: '', saving: false, photoChecking: false, photoSelected: false,
    form: {name: '', nickname: '', gender: 'unknown', country: '', province: '', city: '', latitude: null as number | null, longitude: null as number | null, birthYear: '', status: '', school: '', industry: '', occupation: '', bio: '', phone: '', wechatId: '', photoUrl: ''},
    hasPhoto: false, initial: '我', calendarOptions: CALENDAR_OPTIONS, calendarIndex: 0,
    monthOptions: MONTH_OPTIONS, monthIndex: -1, dayOptions: birthdayDayOptions(0, -1, ''), dayIndex: -1, leapMonth: false,
    statusOptions: STATUS_OPTIONS, statusIndex: 0, genderOptions: GENDER_OPTIONS, genderIndex: 0,
    nextBirthday: '', createSelf: false
  },
  onLoad(this: any, options: any) {
    this.circleId = options.circleId || '';
    this.createSelf = options.purpose === 'self' && !!this.circleId;
    this.setData({createSelf: this.createSelf});
    this.loadData();
  },
  async loadData(this: any) {
    this.setData({loading: true, loadError: ''});
    const session = await invoke<{hasVerifiedPhone: boolean}>({action: 'account.sync'});
    if (!session.ok) { this.setData({loading: false, loadError: session.error.message}); return; }
    if (!session.data.hasVerifiedPhone) {
      const destination = this.createSelf ? `/pages/profile/index?circleId=${q(this.circleId)}&purpose=self` : '/pages/profile/index';
      wx.reLaunch({url: `/pages/login/index?next=${q(destination)}`});
      return;
    }
    const result = await invoke<{profile: AccountProfile | null}>({action: 'account.profile.get'});
    if (!result.ok) { this.setData({loading: false, loadError: result.error.message}); return; }
    const p = result.data.profile || {};
    this.setData({
      loading: false, hasPhoto: !!p.hasPhoto, initial: p.name ? p.name.slice(-1) : '我',
      form: {name: p.name || '', nickname: p.nickname || '', gender: p.gender || 'unknown', country: p.country || '', province: p.province || '', city: p.city || '', latitude: p.latitude ?? null, longitude: p.longitude ?? null, birthYear: p.birthday?.year ? String(p.birthday.year) : '', status: p.status || '', school: p.school || '', industry: p.industry || '', occupation: p.occupation || '', bio: p.bio || '', phone: p.phone || '', wechatId: p.wechatId || '', photoUrl: p.photoUrl || ''},
      calendarIndex: p.birthday?.calendar === 'lunar' ? 1 : 0,
      monthIndex: p.birthday ? p.birthday.month - 1 : -1,
      dayOptions: birthdayDayOptions(p.birthday?.calendar === 'lunar' ? 1 : 0, p.birthday ? p.birthday.month - 1 : -1, p.birthday?.year ? String(p.birthday.year) : ''),
      dayIndex: p.birthday ? p.birthday.day - 1 : -1, leapMonth: !!p.birthday?.leapMonth,
      statusIndex: Math.max(0, STATUS_OPTIONS.indexOf(p.status || '暂不填写')),
      genderIndex: Math.max(0, GENDER_VALUES.indexOf(p.gender || 'unknown'))
    });
    this.updateBirthdayPreview();
    if (p.hasPhoto && !p.photoUrl) {
      const photo = await invoke<{url: string}>({action: 'photo.url'});
      if (photo.ok && photo.data.url && !this.data.photoSelected) this.setData({'form.photoUrl': photo.data.url});
    }
  },
  onRetry(this: any) { if (!this.data.loading) this.loadData(); },
  onHome() { wx.switchTab({url: '/pages/circles/index'}); },
  onInput(this: any, event: any) {
    if (this.data.saving) return;
    const field = event.currentTarget.dataset.field;
    const value = event.detail.value;
    const extra = field === 'birthYear' ? (() => {
      const dayOptions = birthdayDayOptions(this.data.calendarIndex, this.data.monthIndex, value);
      return {dayOptions, dayIndex: birthdayDayIndex(this.data.dayIndex, dayOptions)};
    })() : {};
    this.setData({[`form.${field}`]: value, ...(field === 'name' ? {initial: value ? value.slice(-1) : '我'} : {}), ...extra});
    if (field === 'birthYear') this.updateBirthdayPreview();
  },
  onGender(this: any, event: any) {
    if (this.data.saving) return;
    const index = Number(event.detail.value);
    this.setData({genderIndex: index, 'form.gender': GENDER_VALUES[index]});
  },
  onStatus(this: any, event: any) {
    if (this.data.saving) return;
    const index = Number(event.detail.value);
    this.setData({statusIndex: index, 'form.status': index ? STATUS_OPTIONS[index] : ''});
  },
  onCalendar(this: any, event: any) {
    if (this.data.saving) return;
    const calendarIndex = Number(event.detail.value);
    const dayOptions = birthdayDayOptions(calendarIndex, this.data.monthIndex, this.data.form.birthYear);
    this.setData({calendarIndex, dayOptions, dayIndex: birthdayDayIndex(this.data.dayIndex, dayOptions), leapMonth: false});
    this.updateBirthdayPreview();
  },
  onBirthMonth(this: any, event: any) {
    if (this.data.saving) return;
    const monthIndex = Number(event.detail.value);
    const dayOptions = birthdayDayOptions(this.data.calendarIndex, monthIndex, this.data.form.birthYear);
    this.setData({monthIndex, dayOptions, dayIndex: birthdayDayIndex(this.data.dayIndex, dayOptions)});
    this.updateBirthdayPreview();
  },
  onBirthDay(this: any, event: any) { if (this.data.saving) return; this.setData({dayIndex: Number(event.detail.value)}); this.updateBirthdayPreview(); },
  onLeapMonth(this: any, event: any) { if (this.data.saving) return; this.setData({leapMonth: !!event.detail.value}); this.updateBirthdayPreview(); },
  birthday(this: any): Birthday | null {
    if (this.data.monthIndex < 0 || this.data.dayIndex < 0 || this.data.dayIndex >= this.data.dayOptions.length) return null;
    const yearText = this.data.form.birthYear.trim();
    const year = yearText ? Number(yearText) : undefined;
    return {calendar: this.data.calendarIndex === 1 ? 'lunar' : 'solar', month: this.data.monthIndex + 1, day: this.data.dayIndex + 1,
      ...(year !== undefined ? {year} : {}), ...(this.data.calendarIndex === 1 && this.data.leapMonth ? {leapMonth: true} : {})};
  },
  updateBirthdayPreview(this: any) {
    const birthday = this.birthday();
    if (!birthday) { this.setData({nextBirthday: ''}); return; }
    try {
      const calendar = new BirthdayCalendar(Date.now(), 366, birthday.calendar === 'lunar');
      const next = calendar.next(birthday);
      this.setData({nextBirthday: next ? `下一次：${next.date}（${next.daysUntil === 0 ? '今天' : `还有 ${next.daysUntil} 天`}）` : '明年的对应日期会自动换算'});
    } catch (_) { this.setData({nextBirthday: '保存后会按每年的日历自动换算'}); }
  },
  onChooseCityPoint(this: any) {
    if (this.data.saving) return;
    wx.navigateTo({url: '/pages/location-picker/index',
      events: {cityLocationSelected: (selected: any) => {
        if (!this.data.saving) this.setData({'form.city': selected.city, 'form.country': selected.country, 'form.province': selected.province, 'form.latitude': selected.latitude, 'form.longitude': selected.longitude});
      }},
      success: (response: any) => response.eventChannel.emit('initialCityLocation', {city: this.data.form.city, country: this.data.form.country, province: this.data.form.province, latitude: this.data.form.latitude, longitude: this.data.form.longitude})});
  },
  async preparePhoto(this: any, source: string): Promise<string> {
    const info = await imageInfo(source);
    if (!info?.width || !info?.height) throw new Error('无法读取这张照片，请选择 JPG 或 PNG 图片');
    const canvas: any = await new Promise(resolve => wx.createSelectorQuery().in(this).select('#photoCanvas').fields({node: true}).exec((nodes: any[]) => resolve(nodes?.[0]?.node || null)));
    if (!canvas) throw new Error('当前设备暂无法安全处理照片，请稍后重试');
    const picture = canvas.createImage();
    await new Promise<void>((resolve, reject) => { picture.onload = () => resolve(); picture.onerror = () => reject(new Error('无法转换这张照片')); picture.src = source; });
    for (const longest of [1280, 1024, 800, 640]) {
      const scale = Math.min(1, longest / Math.max(info.width, info.height));
      const width = Math.max(1, Math.round(info.width * scale));
      const height = Math.max(1, Math.round(info.height * scale));
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff'; context.fillRect(0, 0, width, height); context.drawImage(picture, 0, 0, width, height);
      for (const quality of [0.82, 0.66, 0.5]) {
        const output: any = await new Promise(resolve => wx.canvasToTempFilePath({canvas, x: 0, y: 0, width, height, destWidth: width, destHeight: height, fileType: 'jpg', quality, success: resolve, fail: () => resolve(null)}));
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
    wx.chooseImage({count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'], success: async (choice: any) => {
      if (this.data.saving) return;
      const temp = choice.tempFilePaths?.[0]; if (!temp) return;
      this.setData({photoChecking: true});
      try { const prepared = await this.preparePhoto(temp); this.photoPath = prepared; this.setData({'form.photoUrl': prepared, photoSelected: true}); }
      catch (error: any) { toast(error?.message || '照片处理失败，请重试'); }
      finally { this.setData({photoChecking: false}); }
    }, fail: (error: any) => { if (!/cancel/i.test(error?.errMsg || '')) toast('暂时无法打开相册或相机'); }});
  },
  async uploadPhoto(this: any): Promise<boolean> {
    if (!this.photoPath) return true;
    const base64: string = await new Promise(resolve => wx.getFileSystemManager().readFile({filePath: this.photoPath, encoding: 'base64', success: (result: any) => resolve(result.data), fail: () => resolve('')}));
    if (!base64) { this.photoError = '照片读取失败，请重新选择照片'; return false; }
    const result = await invoke({action: 'photo.upload', payload: {base64}});
    if (!result.ok) { this.photoError = result.error.message; return false; }
    return true;
  },
  async onSave(this: any) {
    if (this.data.loading || this.data.saving || this.data.photoChecking) return;
    const f = this.data.form;
    if (!f.name.trim()) return toast('请填写姓名');
    if (!f.country.trim() || !f.city.trim()) return toast('请逐级选择所在城市');
    const birthday = this.birthday();
    if (!birthday) return toast('请填写生日，并选择阳历或农历');
    if (birthday.year !== undefined && (!Number.isInteger(birthday.year) || birthday.year < 1900 || birthday.year > 2100)) return toast('出生年份请填 1900 至 2100 年');
    this.setData({saving: true});
    const patch = {name: f.name.trim(), nickname: f.nickname.trim(), gender: f.gender, country: f.country.trim(), province: f.province.trim(), city: f.city.trim(), latitude: f.latitude, longitude: f.longitude, birthday, status: f.status, school: f.school.trim(), industry: f.industry.trim(), occupation: f.occupation.trim(), bio: f.bio.trim(), phone: f.phone.trim(), wechatId: f.wechatId.trim()};
    const updated = await invoke({action: 'account.profile.update', payload: {patch}});
    if (!updated.ok) { this.setData({saving: false}); return showApiError(updated); }
    if (!(await this.uploadPhoto())) {
      this.setData({saving: false});
      wx.showModal({title: '资料已保存，照片未上传', content: this.photoError || '请重新选择照片后重试', showCancel: false});
      return;
    }
    if (this.createSelf) {
      this.setData({saving: false, photoSelected: false});
      this.photoPath = '';
      wx.redirectTo({url: `/pages/person-edit/index?circleId=${q(this.circleId)}&purpose=self`});
      return;
    }
    this.setData({saving: false, photoSelected: false});
    this.photoPath = '';
    toast('资料已保存，家人录和同窗录会同步更新');
    if (typeof getCurrentPages === 'function' && getCurrentPages().length <= 1) wx.switchTab({url: '/pages/circles/index'});
    else wx.navigateBack();
  }
});
