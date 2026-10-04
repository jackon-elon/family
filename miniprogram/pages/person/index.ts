import { Circle, Person, Relation, invoke, resolvePhotoUrls, showApiError } from '../../services/api';
import { dateText, go, q, toast } from '../../utils/navigation';
import { relationshipFor } from '../../utils/relationship';

Page({
  data: {
    circle: null as Circle | null, person: null as Person | null, initial: '人', relationLabel: '', relationPath: '', relationMissing: '', relationStatus: '', alternatives: '',
    canEdit: false, canClaim: false, claimPending: false, claimBusy: false, rows: [] as { label: string; value: string }[], updated: '', updatedLabel: '', loading: true, loadError: '',
    displayName: '', remark: '', remarkDraft: '', remarkEditing: false, remarkLoading: false, remarkError: '', remarkSaving: false
  },
  onLoad(this: any, options: any) { this.circleId = options.circleId; this.personId = options.personId; this.loadData(); },
  onShow(this: any) { if (this.personId && !this.data.loading && !this.data.remarkEditing) this.loadData(); },
  onUnload(this: any) { this.loadVersion = (this.loadVersion || 0) + 1; this.remarkVersion = (this.remarkVersion || 0) + 1; },
  async loadData(this: any) {
    if (!this.circleId || !this.personId) { this.setData({ loading: false, loadError: '请返回亲友录重新打开这位家人或同学' }); return; }
    const loadVersion = (this.loadVersion || 0) + 1;
    this.loadVersion = loadVersion;
    this.remarkVersion = (this.remarkVersion || 0) + 1;
    this.setData({ loading: true, loadError: '', person: null, canEdit: false, canClaim: false,
      displayName: '', remark: '', remarkDraft: '', remarkLoading: false, remarkSaving: false, remarkEditing: false, remarkError: '' });
    const session = await invoke<{hasVerifiedPhone: boolean}>({action: 'account.sync'});
    if (this.loadVersion !== loadVersion) return;
    if (!session.ok) { this.setData({loading: false, loadError: session.error.message}); return; }
    if (!session.data.hasVerifiedPhone) {
      const destination = `/pages/person/index?circleId=${q(this.circleId)}&personId=${q(this.personId)}`;
      wx.reLaunch({url: `/pages/login/index?next=${q(destination)}`});
      return;
    }
    const [detail, current, people, relations, claims] = await Promise.all([
      invoke<{ circle: Circle; role: string }>({ action: 'circle.detail', payload: { circleId: this.circleId } }),
      invoke<{ person: Person }>({ action: 'person.get', payload: { circleId: this.circleId, personId: this.personId } }),
      invoke<{ persons: Person[] }>({ action: 'person.list', payload: { circleId: this.circleId } }),
      invoke<{ relations: Relation[] }>({ action: 'relation.list', payload: { circleId: this.circleId } }),
      invoke<{ claimRequests: Array<{status: string}> }>({ action: 'person.claimMine', payload: { circleId: this.circleId } })
    ]);
    if (this.loadVersion !== loadVersion) return;
    if (!detail.ok || !current.ok || !people.ok || !relations.ok || !claims.ok) {
      const failed = [detail, current, people, relations, claims].find(result => !result.ok);
      this.setData({ loading: false, loadError: failed && !failed.ok ? failed.error.message : '加载失败，请重试' }); return;
    }
    const person = (await resolvePhotoUrls(this.circleId, [current.data.person]))[0];
    if (this.loadVersion !== loadVersion) return;
    const circle = detail.data.circle;
    const all = people.data.persons;
    const selfId = all.find(p => p.isSelf)?.id || '';
    const relation = circle.type === 'family' && selfId ? relationshipFor(all, relations.data.relations, selfId, person.id) : null;
    const rows = [
      { label: '所在城市', value: [person.country && person.country !== '中国' ? person.country : '', person.city].filter(Boolean).join(' · ') },
      { label: '生日', value: person.birthday ? `${person.birthday.calendar === 'lunar' ? '农历' : '阳历'}${person.birthday.leapMonth ? '闰' : ''}${person.birthday.month}月${person.birthday.day}日${person.birthday.year ? ` · ${person.birthday.year}年出生` : ''}` : '' },
      { label: '目前状态', value: person.status }, { label: '学校', value: person.school },
      { label: '行业', value: person.industry }, { label: '职业', value: person.occupation },
      { label: '近况', value: person.bio }
    ].filter(x => !!x.value) as { label: string; value: string }[];
    const claimPending = claims.data.claimRequests.some(request => request.status === 'pending');
    wx.setNavigationBarTitle({ title: person.name });
    this.setData({ circle, person, displayName: person.name, remark: '', remarkDraft: '', remarkError: '', initial: person.name?.slice(-1) || '人', canEdit: !!person.isSelf, canClaim: !claimPending && !person.isClaimed && !all.some(p => p.isSelf), claimPending,
      relationLabel: relation?.label || (circle.type === 'classmate' ? '同班同学' : '关系待补充'), relationPath: relation?.path || '', relationMissing: relation?.missing || '', relationStatus: relation?.status || 'unrelated', alternatives: relation?.alternatives || '', rows,
      updated: person.lastConfirmedAt ? dateText(person.lastConfirmedAt) : person.updatedAt ? dateText(person.updatedAt) : '', updatedLabel: person.lastConfirmedAt ? '本人最近更新' : '资料最近更新', loading: false });
    if (!person.isSelf) await this.loadRemark();
  },
  async loadRemark(this: any) {
    if (!this.data.person || this.data.person.isSelf || this.data.remarkSaving || this.data.remarkEditing) return;
    const loadVersion = this.loadVersion;
    const remarkVersion = (this.remarkVersion || 0) + 1;
    this.remarkVersion = remarkVersion;
    const personId = this.data.person.id;
    const current = () => this.loadVersion === loadVersion && this.remarkVersion === remarkVersion && this.data.person?.id === personId;
    this.setData({remarkLoading: true, remarkError: ''});
    try {
      const result = await invoke<{remark: string}>({action: 'person.remark.get', payload: {circleId: this.circleId, personId: this.personId}});
      if (!current()) return;
      if (!result.ok) { this.setData({remarkLoading: false, remarkError: '备注暂时无法读取'}); return; }
      const remark = result.data.remark || '';
      this.setData({remark, remarkDraft: remark, displayName: remark || this.data.person.name, remarkLoading: false});
      wx.setNavigationBarTitle({title: remark || this.data.person.name});
    } catch (_) { if (current()) this.setData({remarkLoading: false, remarkError: '备注暂时无法读取'}); }
  },
  onRetry(this: any) { if (!this.data.loading) return this.loadData(); },
  onHome() { wx.reLaunch({ url: '/pages/circles/index' }); },
  onEdit(this: any) { if (this.data.person?.isSelf) go('/pages/profile/index'); },
  onPhoto(this: any) { if (this.data.person?.isSelf) go('/pages/profile/index'); },
  onCopyWechat(this: any) { if (this.data.person?.wechatId) wx.setClipboardData({ data: this.data.person.wechatId }); },
  onCall(this: any) { if (this.data.person?.phone) wx.makePhoneCall({ phoneNumber: this.data.person.phone }); },
  onEditRemark(this: any) {
    if (!this.data.person || this.data.person.isSelf || this.data.remarkLoading || this.data.remarkError || this.data.remarkSaving) return;
    this.setData({remarkEditing: true, remarkDraft: this.data.remark});
  },
  onRemarkInput(this: any, e: any) { this.setData({remarkDraft: String(e.detail.value || '').slice(0, 200)}); },
  onCancelRemark(this: any) { if (!this.data.remarkSaving) this.setData({remarkEditing: false, remarkDraft: this.data.remark}); },
  async onSaveRemark(this: any) {
    if (!this.data.person || this.data.person.isSelf || !this.data.remarkEditing || this.data.remarkSaving || this.data.remarkError) return;
    const remark = this.data.remarkDraft.trim();
    if (remark.length > 200) return toast('备注最多 200 字');
    const loadVersion = this.loadVersion;
    const remarkVersion = (this.remarkVersion || 0) + 1;
    this.remarkVersion = remarkVersion;
    const personId = this.data.person.id;
    const current = () => this.loadVersion === loadVersion && this.remarkVersion === remarkVersion && this.data.person?.id === personId;
    this.setData({remarkSaving: true});
    try {
      const result = await invoke<{remark: string}>({action: 'person.remark.update', payload: {circleId: this.circleId, personId: this.personId, remark}});
      if (!current()) return;
      if (!result.ok) { showApiError(result); return; }
      const savedRemark = result.data.remark || '';
      this.setData({remark: savedRemark, remarkDraft: savedRemark, displayName: savedRemark || this.data.person.name, remarkEditing: false});
      wx.setNavigationBarTitle({title: savedRemark || this.data.person.name});
      toast(remark ? '备注已保存' : '备注已清除');
    } catch (_) { if (current()) toast('备注保存失败，请重试'); }
    finally { if (current()) this.setData({remarkSaving: false}); }
  },
  async onClaim(this: any) {
    if (!this.data.canClaim || this.data.claimBusy) return;
    this.setData({claimBusy: true});
    const result = await invoke({ action: 'person.claim', payload: { circleId: this.circleId, personId: this.personId } });
    this.setData({claimBusy: false});
    if (!result.ok) return showApiError(result);
    this.setData({canClaim: false, claimPending: true});
    toast('已提交，等待管理员确认');
    await this.loadData();
  }
});
