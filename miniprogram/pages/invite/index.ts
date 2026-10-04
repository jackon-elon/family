import { Circle, Invite, InviteSummary, Person, invoke, isDemoMode, showApiError } from '../../services/api';
import { confirm, dateText, go, q, toast } from '../../utils/navigation';
function expiryText(at: number): string {
  const date = new Date(at);
  return `${dateText(at)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

Page({
  data: { circle: null as Circle | null, invite: null as Invite | null, expiryText: '', demoMode: true, sharedPeople: 0, visibleCities: 0, visiblePhones: 0, qrPath: '', qrError: '', qrLoading: false, creating: false, loading: true, loadError: '', busyInviteId: '', activeInvites: [] as Array<InviteSummary & { expiryText: string }>, olderInvites: [] as Array<InviteSummary & { expiryText: string }> },
  onLoad(this: any, options: any) {
    this.circleId = options.circleId;
    this.loadData();
    // A local demo token only exists on this device and must not be forwarded.
    if (isDemoMode()) wx.hideShareMenu();
    else wx.showShareMenu({ withShareTicket: false });
  },
  onShow(this: any) { if (this.circleId && !this.data.loading) this.loadData(); },
  onUnload(this: any) { this.unloaded = true; this.loadVersion = (this.loadVersion || 0) + 1; this.qrVersion = (this.qrVersion || 0) + 1; },
  clearInvite(this: any) {
    this.qrVersion = (this.qrVersion || 0) + 1;
    this.setData({invite: null, expiryText: '', qrPath: '', qrError: '', qrLoading: false});
  },
  usableInvite(this: any): Invite | null {
    const invite = this.data.invite as Invite | null;
    if (this.unloaded || this.data.loading || this.data.loadError || this.data.busyInviteId || !invite) return null;
    if (!Number.isFinite(invite.expiresAt) || invite.expiresAt <= Date.now() || invite.revokedAt || invite.usedAt) {
      this.clearInvite();
      toast('邀请已失效，请重新生成');
      return null;
    }
    return invite;
  },
  async loadData(this: any) {
    if (this.unloaded) return;
    if (!this.circleId) { this.setData({loading: false, loadError: '请从“我的 → 管理”重新打开邀请'}); return; }
    const version = (this.loadVersion || 0) + 1;
    this.loadVersion = version;
    this.setData({loading: true, loadError: ''});
    const [detail, people, invitations] = await Promise.all([
      invoke<{ circle: Circle; role: string }>({ action: 'circle.detail', payload: { circleId: this.circleId } }),
      invoke<{ persons: Person[] }>({ action: 'person.list', payload: { circleId: this.circleId } }),
      invoke<{ invites: InviteSummary[] }>({ action: 'invite.list', payload: { circleId: this.circleId } })
    ]);
    if (version !== this.loadVersion || this.unloaded) return;
    if (!detail.ok || !people.ok || !invitations.ok) {
      const failed = [detail, people, invitations].find(result => !result.ok);
      if (!failed || failed.ok || !['NETWORK', 'BAD_RESPONSE', 'SERVER_ERROR'].includes(failed.error.code)) this.clearInvite();
      this.qrVersion = (this.qrVersion || 0) + 1;
      this.setData({qrLoading: false});
      this.setData({loading: false, loadError: failed && !failed.ok ? failed.error.message : '加载失败，请重试'}); return;
    }
    if (detail.data.role !== 'owner' && detail.data.role !== 'admin') { this.clearInvite(); this.setData({loading: false, loadError: '只有管理员可以发送邀请'}); return; }
    const list = people.data.persons;
    const activeInvites = invitations.data.invites.filter(invite => invite.status === 'active' && invite.expiresAt > Date.now()).map(invite => ({...invite, expiryText: expiryText(invite.expiresAt)}));
    const current = this.data.invite && activeInvites.find(invite => invite.id === this.data.invite.id);
    if (!current) this.clearInvite();
    this.setData({ circle: detail.data.circle, invite: current ? this.data.invite : null, qrPath: current ? this.data.qrPath : '', activeInvites, olderInvites: activeInvites.filter(invite => invite.id !== current?.id), demoMode: isDemoMode(), sharedPeople: list.length, visibleCities: list.filter(p => !!p.city).length, visiblePhones: list.filter(p => !!p.phone && !p.isSelf).length, loading: false });
  },
  onRetry(this: any) { if (!this.data.loading) return this.loadData(); },
  onHome() { wx.reLaunch({url: '/pages/circles/index'}); },
  async onGenerate(this: any) {
    if (this.unloaded || this.data.creating || this.data.loading || this.data.loadError || this.data.busyInviteId || !this.data.circle) return;
    this.setData({ creating: true });
    if (this.data.circle.mode === 'private') {
      const upgraded = await invoke<{ circle: Circle }>({ action: 'circle.upgrade', payload: { circleId: this.circleId, privacyReviewed: true } });
      if (!upgraded.ok) { this.setData({ creating: false }); return showApiError(upgraded); }
      this.setData({ circle: upgraded.data.circle });
    }
    const result = await invoke<{ invite: Invite }>({ action: 'invite.create', payload: { circleId: this.circleId } });
    if (this.unloaded) return;
    this.setData({ creating: false });
    if (!result.ok) return showApiError(result);
    const invite = result.data.invite;
    this.setData({ invite, expiryText: expiryText(invite.expiresAt), qrPath: '', qrError: '', qrLoading: false });
    await this.loadData();
    if (!this.data.demoMode && this.data.invite?.id === invite.id && !this.data.loadError) await this.loadQr(invite);
  },
  async loadQr(this: any, invite: Invite) {
    if (this.unloaded || this.data.loadError || this.data.invite?.id !== invite.id || this.data.invite?.token !== invite.token) return;
    const version = (this.qrVersion || 0) + 1;
    this.qrVersion = version;
    this.setData({ qrLoading: true, qrError: '' });
    const result = await invoke<{ imageBase64: string }>({ action: 'invite.code', payload: { circleId: this.circleId, token: invite.token } });
    if (this.unloaded || version !== this.qrVersion || this.data.loadError || this.data.invite?.id !== invite.id || this.data.invite?.token !== invite.token) return;
    if (invite.expiresAt <= Date.now()) { this.clearInvite(); return; }
    if (!result.ok) {
      this.setData({ qrLoading: false, qrError: `暂时无法生成小程序码：${result.error.message}。仍可使用微信分享或复制口令。` });
      return;
    }
    try {
      const safeId = String(invite.id).replace(/[^a-zA-Z0-9_-]/g, '');
      const path = `${wx.env.USER_DATA_PATH}/invite-${safeId}.png`;
      const base64 = result.data.imageBase64.replace(/^data:image\/png;base64,/, '');
      wx.getFileSystemManager().writeFileSync(path, base64, 'base64');
      this.setData({ qrPath: path, qrError: '', qrLoading: false });
    } catch (_) {
      this.setData({ qrLoading: false, qrError: '小程序码保存失败，请使用微信分享或复制口令。' });
    }
  },
  async onRetryQr(this: any) {
    if (this.data.qrLoading || this.data.demoMode) return;
    const invite = this.usableInvite();
    if (invite) await this.loadQr(invite);
  },
  onCopy(this: any) {
    const invite = this.usableInvite();
    if (!invite) return;
    wx.setClipboardData({ data: invite.token, success: () => toast(this.data.demoMode ? '演示口令已复制，仅本机有效' : '邀请口令已复制') });
  },
  onPreview(this: any) { const invite = this.usableInvite(); if (invite) go(`/pages/apply/index?token=${q(invite.token)}${this.data.demoMode ? '&demoPreview=1' : ''}`); },
  async onRevoke(this: any) {
    if (this.data.invite) await this.revokeInvite(this.data.invite.id);
  },
  async onRevokeListed(this: any, event: any) { await this.revokeInvite(event.currentTarget.dataset.id); },
  async revokeInvite(this: any, inviteId: string) {
    if (!inviteId || this.data.busyInviteId || this.data.creating || this.data.loading) return;
    this.setData({busyInviteId: inviteId});
    if (!(await confirm('撤销邀请', '发出的微信邀请、二维码和口令都会失效。确定撤销吗？'))) { this.setData({busyInviteId: ''}); return; }
    const result = await invoke({ action: 'invite.revoke', payload: { circleId: this.circleId, inviteId } });
    this.setData({busyInviteId: ''});
    if (!result.ok) return showApiError(result);
    if (this.data.invite?.id === inviteId) this.clearInvite();
    await this.loadData(); toast('邀请已撤销');
  },
  onShareAppMessage(this: any) {
    const invite = isDemoMode() ? null : this.usableInvite();
    if (!invite) return { title: '看看我的亲友录', path: '/pages/circles/index' };
    return { title: `邀请你加入「${this.data.circle?.name || '亲友录'}」`, path: `/pages/apply/index?token=${encodeURIComponent(invite.token)}` };
  }
});
