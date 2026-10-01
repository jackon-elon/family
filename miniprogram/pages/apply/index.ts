import { Circle, invoke, setDemoMode, showApiError } from '../../services/api';
import { CLOUD_ENV_ID } from '../../config';
import { dateText, toast } from '../../utils/navigation';

Page({
  data: { circle: null as Circle | null, status: '', expiryText: '', name: '', note: '', submitting: false, submitted: false, error: '' },
  async onLoad(this: any, options: any) {
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
  async loadPreview(this: any) {
    if (!this.token) { this.setData({ error: '缺少邀请口令' }); return; }
    const result = await invoke<{ circle: Circle; expiresAt: number; status: string }>({ action: 'invite.preview', payload: { token: this.token } });
    if (!result.ok) { this.setData({ error: result.error.message }); return; }
    this.setData({ circle: result.data.circle, status: result.data.status, expiryText: dateText(result.data.expiresAt) });
  },
  onInput(this: any, e: any) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  async onSubmit(this: any) {
    if (!this.data.name.trim()) return toast('请填写姓名，方便管理员核对');
    if (this.data.circle?.type === 'classmate' && !this.data.note.trim()) return toast('请写下班级身份说明，方便管理员核对');
    this.setData({ submitting: true });
    const result = await invoke({ action: 'invite.apply', payload: { token: this.token, name: this.data.name.trim(), note: this.data.note.trim() } });
    this.setData({ submitting: false });
    if (!result.ok) return showApiError(result);
    this.setData({ submitted: true });
  }
});
