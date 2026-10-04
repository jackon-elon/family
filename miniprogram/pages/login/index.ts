import { invoke, isDemoMode, showApiError } from '../../services/api';

Page({
  data: { loading: true, busy: false, error: '', demo: isDemoMode() },
  onLoad(this: any, options: any) {
    let next = String(options?.next || '');
    // 微信会先解码页面参数；再次解码会把人物 ID 中的 %26 变成查询分隔符。
    if (!next.startsWith('/')) {
      try { next = decodeURIComponent(next); } catch (_) { next = ''; }
    }
    this.nextPage = next.startsWith('/pages/apply/index?') || next.startsWith('/pages/circle/index?circleId=') || next.startsWith('/pages/person/index?circleId=') || next === '/pages/profile/index' || next.startsWith('/pages/profile/index?circleId=') || next === '/pages/events/index' ? next : '';
  },
  onShow(this: any) { return this.checkSession(); },
  async checkSession(this: any) {
    if (this.data.busy) return;
    this.setData({ loading: true, error: '', demo: isDemoMode() });
    const result = await invoke<{ hasVerifiedPhone: boolean }>({ action: 'account.sync' });
    if (!result.ok) { this.setData({ loading: false, error: result.error.message }); return; }
    if (result.data.hasVerifiedPhone) return this.enter();
    this.setData({ loading: false });
  },
  enter(this: any) {
    if (this.nextPage) return wx.reLaunch({url: this.nextPage});
    wx.switchTab({ url: '/pages/circles/index' });
  },
  async verify(this: any, code: string) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    const result = await invoke<{ hasVerifiedPhone: boolean }>({ action: 'account.verifyPhone', payload: { code } });
    this.setData({ busy: false });
    if (!result.ok) { this.setData({ error: result.error.message }); return showApiError(result); }
    this.enter();
  },
  onPhoneNumber(this: any, event: any) {
    const code = event?.detail?.code;
    if (!code) {
      this.setData({ error: '请允许微信提供手机号，才能进入亲友录。' });
      return;
    }
    this.verify(code);
  },
  onDemoLogin(this: any) { this.verify('demo-verified-phone'); },
  onRetry(this: any) { this.checkSession(); }
});
