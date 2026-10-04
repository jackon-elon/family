import { invoke, showApiError } from '../../services/api';
import { confirm, newRequestId, q, toast } from '../../utils/navigation';

Page({
  data: { type: 'family', mode: 'private', name: '', school: '', cohort: '', className: '', saving: false, createdCircleId: '' },
  onLoad(this: any) { this.requestId = newRequestId(); },
  chooseType(this: any, e: any) { if (!this.data.saving && !this.data.createdCircleId) this.setData({ type: e.currentTarget.dataset.type }); },
  onInput(this: any, e: any) { if (!this.data.saving && !this.data.createdCircleId) this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  openCreatedCircle(this: any) {
    wx.redirectTo({ url: `/pages/circle/index?circleId=${q(this.data.createdCircleId)}`,
      fail: () => toast('已创建成功，点击下方按钮重新打开') });
  },
  async onSubmit(this: any) {
    if (this.data.saving) return;
    if (this.data.createdCircleId) return this.openCreatedCircle();
    const d = this.data;
    if (!d.name.trim()) return toast(`给${d.type === 'family' ? '家人录' : '同窗录'}起个名字吧`);
    if (d.type === 'classmate' && (!d.school.trim() || !d.cohort.trim() || !d.className.trim())) return toast('同窗录需填写学校、届别和班级');
    this.setData({ saving: true });
    const current = { type: d.type, name: d.name.trim(), mode: d.mode, school: d.school.trim(), cohort: d.cohort.trim(), className: d.className.trim() };
    if (this.pendingCreatePayload && JSON.stringify(current) !== JSON.stringify(this.pendingCreatePayload) &&
      !(await confirm('先完成上次创建', '上次可能已经创建成功。这次先找回上次的结果，名称等修改暂不保存。'))) {
      this.setData({ saving: false }); return;
    }
    this.pendingCreatePayload = this.pendingCreatePayload || current;
    this.requestId = this.requestId || newRequestId();
    const result = await invoke<{ circle: { id: string } }>({ action: 'circle.create', payload: { ...this.pendingCreatePayload, requestId: this.requestId } });
    this.setData({ saving: false });
    if (!result.ok) {
      if (!['NETWORK', 'SERVER_ERROR', 'BAD_RESPONSE'].includes(result.error.code)) { this.pendingCreatePayload = null; this.requestId = newRequestId(); }
      return showApiError(result);
    }
    this.pendingCreatePayload = null; this.requestId = '';
    this.setData({createdCircleId: result.data.circle.id});
    try { wx.setStorageSync('kin-current-circle', result.data.circle.id); } catch (_) { /* The URL still opens the new circle. */ }
    this.openCreatedCircle();
  }
});
