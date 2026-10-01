import { invoke, showApiError } from '../../services/api';
import { q, toast } from '../../utils/navigation';

Page({
  data: { type: 'family', mode: 'private', name: '', school: '', cohort: '', className: '', saving: false },
  chooseType(this: any, e: any) { this.setData({ type: e.currentTarget.dataset.type }); },
  chooseMode(this: any, e: any) { this.setData({ mode: e.currentTarget.dataset.mode }); },
  onInput(this: any, e: any) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }); },
  async onSubmit(this: any) {
    const d = this.data;
    if (!d.name.trim()) return toast('给圈子起个名字吧');
    if (d.type === 'classmate' && (!d.school.trim() || !d.cohort.trim() || !d.className.trim())) return toast('同学圈需填写学校、届别和班级');
    this.setData({ saving: true });
    const result = await invoke<{ circle: { id: string } }>({ action: 'circle.create', payload: { type: d.type, name: d.name.trim(), mode: d.mode, school: d.school.trim(), cohort: d.cohort.trim(), className: d.className.trim() } });
    this.setData({ saving: false });
    if (!result.ok) return showApiError(result);
    wx.setStorageSync('kin-current-circle', result.data.circle.id);
    wx.redirectTo({ url: `/pages/circle/index?circleId=${q(result.data.circle.id)}` });
  }
});
