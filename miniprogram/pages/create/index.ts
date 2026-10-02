import { invoke, showApiError } from '../../services/api';
import { confirm, newRequestId, q, toast } from '../../utils/navigation';

Page({
  data: { type: 'family', mode: 'private', name: '', school: '', cohort: '', className: '', saving: false },
  onLoad(this: any) { this.requestId = newRequestId(); },
  chooseType(this: any, e: any) { this.setData({ type: e.currentTarget.dataset.type }); },
  chooseMode(this: any, e: any) { this.setData({ mode: e.currentTarget.dataset.mode }); },
  onInput(this: any, e: any) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  async onSubmit(this: any) {
    if (this.data.saving) return;
    const d = this.data;
    if (!d.name.trim()) return toast('给圈子起个名字吧');
    if (d.type === 'classmate' && (!d.school.trim() || !d.cohort.trim() || !d.className.trim())) return toast('同学圈需填写学校、届别和班级');
    this.setData({ saving: true });
    const current = { type: d.type, name: d.name.trim(), mode: d.mode, school: d.school.trim(), cohort: d.cohort.trim(), className: d.className.trim() };
    if (this.pendingCreatePayload && JSON.stringify(current) !== JSON.stringify(this.pendingCreatePayload) &&
      !(await confirm('先确认上次创建', '上次提交的结果还不确定。先按上次填写的内容确认，避免重复建圈；当前修改不会应用。'))) {
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
    try { wx.setStorageSync('kin-current-circle', result.data.circle.id); } catch (_) { /* The URL still opens the new circle. */ }
    wx.redirectTo({ url: `/pages/circle/index?circleId=${q(result.data.circle.id)}` });
  }
});
