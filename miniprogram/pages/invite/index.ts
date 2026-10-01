import { Circle, Invite, Person, invoke, isDemoMode, showApiError } from '../../services/api';
import { confirm, dateText, go, q, toast } from '../../utils/navigation';

Page({
  data: { circle: null as Circle | null, invite: null as Invite | null, expiryText: '', demoMode: true, sharedPeople: 0, visibleCities: 0, visiblePhones: 0, qrCells: [] as { on: boolean; id: number }[], creating: false },
  onLoad(this: any, options: any) { this.circleId = options.circleId; this.loadData(); wx.showShareMenu({ withShareTicket: false }); },
  async loadData(this: any) {
    const [detail, people] = await Promise.all([
      invoke<{ circle: Circle; role: string }>({ action: 'circle.detail', payload: { circleId: this.circleId } }),
      invoke<{ persons: Person[] }>({ action: 'person.list', payload: { circleId: this.circleId } })
    ]);
    if (!detail.ok) return showApiError(detail);
    if (detail.data.role !== 'owner' && detail.data.role !== 'admin') { toast('只有管理员可以发送邀请'); wx.navigateBack(); return; }
    const list = people.ok ? people.data.persons : [];
    this.setData({ circle: detail.data.circle, demoMode: isDemoMode(), sharedPeople: list.length, visibleCities: list.filter(p => !!p.city).length, visiblePhones: list.filter(p => !!p.phone && !p.isSelf).length });
  },
  async onGenerate(this: any) {
    if (!(await confirm('分享前检查', `新成员获批准后可看到本圈人物和关系。当前有 ${this.data.sharedPeople} 张人物卡、${this.data.visibleCities} 个可见城市。请先确认历史填写的资料适合分享。`))) return;
    this.setData({ creating: true });
    if (this.data.circle.mode === 'private') {
      const upgraded = await invoke<{ circle: Circle }>({ action: 'circle.upgrade', payload: { circleId: this.circleId, privacyReviewed: true } });
      if (!upgraded.ok) { this.setData({ creating: false }); return showApiError(upgraded); }
      this.setData({ circle: upgraded.data.circle });
    }
    const result = await invoke<{ invite: Invite }>({ action: 'invite.create', payload: { circleId: this.circleId } });
    this.setData({ creating: false });
    if (!result.ok) return showApiError(result);
    const invite = result.data.invite;
    const cells = Array.from({ length: 121 }, (_, i) => ({ id: i, on: ((i * 17 + invite.token.charCodeAt(i % invite.token.length) * 7) % 11) < 5 || i < 13 || i > 107 }));
    this.setData({ invite, expiryText: dateText(invite.expiresAt), qrCells: cells });
  },
  onCopy(this: any) {
    if (!this.data.invite) return;
    wx.setClipboardData({ data: this.data.invite.token, success: () => toast('邀请口令已复制') });
  },
  onPreview(this: any) { if (this.data.invite) go(`/pages/apply/index?token=${q(this.data.invite.token)}${this.data.demoMode ? '&demoPreview=1' : ''}`); },
  async onRevoke(this: any) {
    if (!this.data.invite || !(await confirm('撤销邀请', '撤销后，微信分享卡片和此邀请口令都会失效。确定撤销吗？'))) return;
    const result = await invoke({ action: 'invite.revoke', payload: { circleId: this.circleId, inviteId: this.data.invite.id } });
    if (!result.ok) return showApiError(result);
    this.setData({ invite: null, qrCells: [] }); toast('邀请已撤销');
  },
  onShareAppMessage(this: any) {
    if (!this.data.invite) return { title: '加入我的亲友圈', path: '/pages/circles/index' };
    return { title: `邀请你加入「${this.data.circle?.name || '亲友圈'}」`, path: `/pages/apply/index?token=${encodeURIComponent(this.data.invite.token)}` };
  }
});
