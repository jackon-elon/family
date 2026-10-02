import { Circle, JoinApplication, invoke, setDemoMode, showApiError } from '../../services/api';
import { CLOUD_ENV_ID } from '../../config';
import { dateText, q, toast } from '../../utils/navigation';

type MyApplication = Omit<JoinApplication, 'status'> & { status: string; circleName?: string; circleType?: string };

Page({
  data: {
    circle: null as Circle | null, status: '', expiryText: '', name: '', note: '',
    application: null as MyApplication | null, applicationTitle: '', applicationMessage: '', applicationDate: '',
    submitting: false, submitted: false, checking: false, statusOnly: false, error: ''
  },
  async onLoad(this: any, options: any) {
    this.applicationId = options.applicationId || '';
    if (this.applicationId) {
      this.setData({ statusOnly: true });
      await this.loadMyStatus();
      return;
    }
    let sceneToken = '';
    if (!options.token && options.scene) {
      try { sceneToken = decodeURIComponent(options.scene); } catch (_) { sceneToken = options.scene; }
    }
    this.token = options.token || sceneToken;
    // A shared invite opens on a different device with no local mode setting.
    // The local admin preview opts into demo data explicitly via demoPreview=1.
    if (this.token && CLOUD_ENV_ID && options.demoPreview !== '1' && !setDemoMode(false)) {
      this.setData({ error: '当前设备无法连接云环境，请稍后重试' });
      return;
    }
    await this.loadPreview();
  },
  async onShow(this: any) {
    if (this.applicationId && !this.data.checking) await this.loadMyStatus();
  },
  async loadPreview(this: any) {
    if (!this.token) { this.setData({ error: '缺少邀请口令' }); return; }
    const result = await invoke<{ circle: Circle; expiresAt: number; status: string }>({ action: 'invite.preview', payload: { token: this.token } });
    if (!result.ok) { this.setData({ error: result.error.message }); return; }
    this.setData({ circle: result.data.circle, status: result.data.status, expiryText: dateText(result.data.expiresAt) });
  },
  async loadMyStatus(this: any) {
    if (!this.applicationId) return;
    this.setData({ checking: true });
    const result = await invoke<{ applications: MyApplication[] }>({ action: 'join.mine' });
    this.setData({ checking: false });
    if (!result.ok) { this.setData({ error: result.error.message }); return; }
    const application = result.data.applications.find(a => a.id === this.applicationId);
    if (!application) { this.setData({ error: '未找到这份申请，请返回首页查看最新状态' }); return; }
    const status = application.status;
    const title = status === 'approved' ? '申请已通过' : status === 'rejected' ? '申请未通过' : status === 'expired' || status === 'invalid' ? '邀请已失效' : '等待管理员核对';
    const message = status === 'approved'
      ? '你现在可以进入圈子，先确认哪张人物卡是你，再补充资料。'
      : status === 'rejected' ? '管理员没有通过这次申请。如有疑问，请联系邀请人核对身份。'
      : status === 'expired' || status === 'invalid' ? '这份邀请无法继续审核，请联系管理员重新发送邀请。'
      : '管理员核对你的身份后才会开放圈内资料。你可以稍后回来查看。';
    this.setData({ application, applicationTitle: title, applicationMessage: message, applicationDate: dateText(application.createdAt), submitted: true, error: '' });
  },
  onInput(this: any, e: any) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  async onSubmit(this: any) {
    if (!this.data.name.trim()) return toast('请填写姓名，方便管理员核对');
    if (this.data.circle?.type === 'classmate' && !this.data.note.trim()) return toast('请写下班级身份说明，方便管理员核对');
    this.setData({ submitting: true });
    const result = await invoke<{ application: MyApplication }>({ action: 'invite.apply', payload: { token: this.token, name: this.data.name.trim(), note: this.data.note.trim() } });
    this.setData({ submitting: false });
    if (!result.ok) return showApiError(result);
    this.applicationId = result.data.application.id;
    this.setData({ submitted: true, application: result.data.application, applicationTitle: '申请已送出', applicationMessage: '管理员核对后才能进入圈子。你可以返回首页查看审核状态。', applicationDate: dateText(result.data.application.createdAt) });
    await this.loadMyStatus();
  },
  onOpenCircle(this: any) {
    if (this.data.application?.status !== 'approved') return;
    wx.redirectTo({ url: `/pages/circle/index?circleId=${q(this.data.application.circleId)}` });
  },
  onHome() { wx.reLaunch({ url: '/pages/circles/index' }); }
});
