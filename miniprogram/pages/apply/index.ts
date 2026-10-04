import { Birthday, Circle, JoinApplication, Person, invoke, setDemoMode, showApiError } from '../../services/api';
import { CLOUD_ENV_ID } from '../../config';
import { dateText, q, toast } from '../../utils/navigation';

type MyApplication = Omit<JoinApplication, 'status'> & {status: string; circleName?: string; circleType?: string};
interface AccountProfile extends Partial<Person> { profileComplete?: boolean }
function complete(profile: AccountProfile | null): boolean {
  return !!(profile?.name?.trim() && profile.country?.trim() && profile.city?.trim() && profile.birthday);
}
function birthdayText(birthday?: Birthday): string {
  if (!birthday) return '';
  return `${birthday.calendar === 'lunar' ? '农历' : '阳历'}${birthday.leapMonth ? '闰' : ''}${birthday.month}月${birthday.day}日`;
}

Page({
  data: {
    circle: null as Circle | null, status: '', expiryText: '', note: '',
    profile: null as AccountProfile | null, profileReady: false, profileLoading: true,
    loginRequired: false, profileError: '', profileBirthdayText: '',
    canOpenCircle: false, inviteStateLoading: false, inviteStateError: '',
    application: null as MyApplication | null, applicationTitle: '', applicationMessage: '', applicationDate: '',
    submitting: false, submitted: false, checking: false, previewLoading: false, statusOnly: false, error: ''
  },
  async onLoad(this: any, options: any) {
    this.applicationId = options.applicationId || '';
    this.demoPreview = options.demoPreview === '1';
    if (this.applicationId) { this.setData({statusOnly: true}); await this.loadMyStatus(); return; }
    let sceneToken = '';
    if (!options.token && options.scene) {
      try { sceneToken = decodeURIComponent(options.scene); } catch (_) { sceneToken = options.scene; }
    }
    this.token = options.token || sceneToken;
    // A shared invite opens on a different device with no local mode setting.
    // The local admin preview opts into demo data explicitly via demoPreview=1.
    if (this.token && CLOUD_ENV_ID && !this.demoPreview && !setDemoMode(false)) {
      this.setData({error: '当前设备无法连接云环境，请稍后重试'}); return;
    }
    await this.loadPreview();
    if (!this.data.error) await this.loadAccountProfile();
  },
  async onShow(this: any) {
    if (this.applicationId && !this.data.checking) await this.loadMyStatus();
    else if (this.token && this.data.circle && !this.data.previewLoading && !this.data.submitted) await this.loadAccountProfile();
  },
  async loadPreview(this: any) {
    if (!this.token) { this.setData({error: '缺少邀请口令'}); return; }
    this.setData({previewLoading: true, error: ''});
    const result = await invoke<{circle: Circle; expiresAt: number; status: string}>({action: 'invite.preview', payload: {token: this.token}});
    if (!result.ok) { this.setData({previewLoading: false, error: result.error.message}); return; }
    this.setData({circle: result.data.circle, status: result.data.status, expiryText: dateText(result.data.expiresAt), previewLoading: false});
  },
  async loadAccountProfile(this: any) {
    const version = (this.profileVersion || 0) + 1;
    this.profileVersion = version;
    this.setData({profileLoading: true, profileError: '', canOpenCircle: false, inviteStateLoading: !!this.token, inviteStateError: ''});
    const session = await invoke<{hasVerifiedPhone: boolean}>({action: 'account.sync'});
    if (this.profileVersion !== version) return;
    if (!session.ok) { this.setData({profileLoading: false, inviteStateLoading: false, profileError: session.error.message, inviteStateError: this.token ? session.error.message : ''}); return; }
    if (!session.data.hasVerifiedPhone) { this.setData({profileLoading: false, inviteStateLoading: false, loginRequired: true, profileReady: false, profile: null, submitted: false, application: null}); return; }
    if (this.token && this.data.circle) {
      // Public invite metadata never grants access. Only the signed-in user's
      // active memberships and own application may resume an existing journey.
      const [memberships, applications] = await Promise.all([
        invoke<{circles: Circle[]}>({action: 'circle.list'}),
        invoke<{applications: MyApplication[]}>({action: 'join.mine', payload: {inviteToken: this.token}})
      ]);
      if (this.profileVersion !== version) return;
      if (memberships.ok && memberships.data.circles.some(circle => circle.id === this.data.circle.id)) {
        this.setData({canOpenCircle: true, profileLoading: false, inviteStateLoading: false, loginRequired: false});
        return;
      }
      const failed = [memberships, applications].find(result => !result.ok);
      if (failed && !failed.ok) {
        this.setData({profileLoading: false, inviteStateLoading: false, loginRequired: false, inviteStateError: failed.error.message});
        return;
      }
      if (applications.ok) {
        const application = applications.data.applications.find(item => item.circleId === this.data.circle.id);
        if (application) {
          this.applicationId = application.id;
          this.showApplication(application);
          this.setData({profileLoading: false, inviteStateLoading: false, loginRequired: false});
          return;
        }
      }
      if (this.data.status !== 'active') {
        this.setData({profileLoading: false, inviteStateLoading: false, loginRequired: false});
        return;
      }
    }
    this.setData({inviteStateLoading: false});
    const result = await invoke<{profile: AccountProfile | null}>({action: 'account.profile.get'});
    if (this.profileVersion !== version) return;
    if (!result.ok) { this.setData({profileLoading: false, profileError: result.error.message}); return; }
    const profile = result.data.profile;
    this.setData({profile, profileReady: complete(profile), profileBirthdayText: birthdayText(profile?.birthday), loginRequired: false, profileLoading: false});
  },
  async loadMyStatus(this: any) {
    if (!this.applicationId || this.data.checking) return;
    this.setData({checking: true, error: ''});
    const session = await invoke<{hasVerifiedPhone: boolean}>({action: 'account.sync'});
    if (!session.ok) { this.setData({checking: false, error: session.error.message}); return; }
    if (!session.data.hasVerifiedPhone) { this.setData({checking: false}); return this.onLogin(); }
    const result = await invoke<{applications: MyApplication[]}>({action: 'join.mine', payload: {applicationId: this.applicationId}});
    this.setData({checking: false});
    if (!result.ok) {
      if (result.error.code === 'PHONE_LOGIN_REQUIRED') return this.onLogin();
      this.setData({error: result.error.message}); return;
    }
    const application = result.data.applications.find(item => item.id === this.applicationId);
    if (!application) { this.setData({error: '未找到这份申请，请返回首页查看最新状态'}); return; }
    this.showApplication(application);
  },
  showApplication(this: any, application: MyApplication) {
    const status = application.status;
    const title = status === 'approved' ? application.canEnter !== true ? '曾通过申请' : '申请已通过' : status === 'rejected' ? '申请未通过' : status === 'expired' || status === 'invalid' ? '邀请已失效' : '等待管理员核对';
    const message = status === 'approved'
      ? application.canEnter !== true ? '你已退出或被移出。如需再次加入，请联系管理员重新邀请。' : '现在可以查看大家的资料了。'
      : status === 'rejected' ? '管理员没有通过这次申请。如有疑问，请联系邀请人核对身份。'
      : status === 'expired' || status === 'invalid' ? '这份邀请无法继续审核，请联系管理员重新发送邀请。'
      : '管理员核对你的身份后才会开放这里的资料。你可以稍后回来查看。';
    this.setData({application, applicationTitle: title, applicationMessage: message, applicationDate: dateText(application.createdAt), submitted: true, error: ''});
  },
  onInput(this: any, event: any) { this.setData({note: event.detail.value}); },
  onLogin(this: any) {
    const target = this.applicationId ? `/pages/apply/index?applicationId=${q(this.applicationId)}` : `/pages/apply/index?token=${q(this.token)}${this.demoPreview ? '&demoPreview=1' : ''}`;
    wx.reLaunch({url: `/pages/login/index?next=${q(target)}`});
  },
  onEditProfile() { wx.navigateTo({url: '/pages/profile/index'}); },
  async onSubmit(this: any) {
    if (this.data.submitting || this.data.submitted || this.data.canOpenCircle || this.data.inviteStateLoading || this.data.inviteStateError || this.data.status !== 'active' || this.data.previewLoading || this.data.error) return;
    if (this.data.loginRequired) return this.onLogin();
    if (!this.data.profileReady) return toast('请先完善我的资料');
    if (this.data.circle?.type === 'classmate' && !this.data.note.trim()) return toast('请写下班级身份说明，方便管理员核对');
    this.setData({submitting: true});
    const refreshed = await invoke<{profile: AccountProfile | null}>({action: 'account.profile.get'});
    if (!refreshed.ok || !complete(refreshed.data.profile)) {
      this.setData({submitting: false});
      if (!refreshed.ok) return showApiError(refreshed);
      return toast('请先完善我的资料');
    }
    const person = refreshed.data.profile!;
    const profile = {country: person.country, province: person.province, city: person.city, latitude: person.latitude, longitude: person.longitude, birthday: person.birthday};
    const result = await invoke<{application: MyApplication}>({action: 'invite.apply', payload: {token: this.token, name: person.name, profile, note: this.data.note.trim()}});
    this.setData({submitting: false});
    if (!result.ok) return showApiError(result);
    this.applicationId = result.data.application.id;
    this.setData({submitted: true, application: result.data.application, applicationTitle: '申请已送出', applicationMessage: '等待管理员确认，可在首页查看申请进度。', applicationDate: dateText(result.data.application.createdAt)});
    await this.loadMyStatus();
  },
  onOpenCircle(this: any) {
    if (this.data.error || this.data.inviteStateLoading || this.data.inviteStateError) return;
    if (this.data.canOpenCircle && this.data.circle?.id) {
      wx.redirectTo({url: `/pages/circle/index?circleId=${q(this.data.circle.id)}`});
      return;
    }
    if (this.data.application?.status !== 'approved' || this.data.application?.canEnter !== true) return;
    wx.redirectTo({url: `/pages/circle/index?circleId=${q(this.data.application.circleId)}`});
  },
  async onRetry(this: any) {
    if (this.data.checking || this.data.previewLoading) return;
    if (this.applicationId) return this.loadMyStatus();
    if (CLOUD_ENV_ID && this.token && !this.demoPreview && !setDemoMode(false)) return this.setData({error: '暂时无法连接云端，请检查网络后重试'});
    await this.loadPreview();
    if (!this.data.error) await this.loadAccountProfile();
  },
  onHome() { wx.reLaunch({url: '/pages/circles/index'}); }
});
