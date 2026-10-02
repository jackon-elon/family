import { Circle, Person, Relation, invoke, resolvePhotoUrls, showApiError } from '../../services/api';
import { confirm, dateText, go, q, toast } from '../../utils/navigation';
import { relationshipFor } from '../../utils/relationship';

Page({
  data: { circle: null as Circle | null, person: null as Person | null, initial: '人', relationLabel: '', relationPath: '', relationMissing: '', relationStatus: '', alternatives: '', isAdmin: false, canEdit: false, canClaim: false, rows: [] as { label: string; value: string }[], updated: '', loading: true },
  onLoad(this: any, options: any) { this.circleId = options.circleId; this.personId = options.personId; this.loadData(); },
  onShow(this: any) { if (this.personId && !this.data.loading) this.loadData(); },
  async loadData(this: any) {
    this.setData({ loading: true });
    const [detail, current, people, relations] = await Promise.all([
      invoke<{ circle: Circle; role: string }>({ action: 'circle.detail', payload: { circleId: this.circleId } }),
      invoke<{ person: Person }>({ action: 'person.get', payload: { circleId: this.circleId, personId: this.personId } }),
      invoke<{ persons: Person[] }>({ action: 'person.list', payload: { circleId: this.circleId } }),
      invoke<{ relations: Relation[] }>({ action: 'relation.list', payload: { circleId: this.circleId } })
    ]);
    if (!detail.ok) { showApiError(detail); return; }
    if (!current.ok) { showApiError(current); return; }
    const person = (await resolvePhotoUrls(this.circleId, [current.data.person]))[0];
    const circle = detail.data.circle;
    const all = people.ok ? people.data.persons : [person];
    const selfId = all.find(p => p.isSelf)?.id || '';
    const relation = circle.type === 'family' && selfId ? relationshipFor(all, relations.ok ? relations.data.relations : [], selfId, person.id) : null;
    const rows = [
      { label: '所在城市', value: [person.country && person.country !== '中国' ? person.country : '', person.city].filter(Boolean).join(' · ') },
      { label: '目前状态', value: person.status }, { label: '学校', value: person.school },
      { label: '行业', value: person.industry }, { label: '职业', value: person.occupation },
      { label: '近况', value: person.bio }
    ].filter(x => !!x.value) as { label: string; value: string }[];
    const isAdmin = detail.data.role === 'owner' || detail.data.role === 'admin';
    wx.setNavigationBarTitle({ title: person.name });
    this.setData({ circle, person, initial: person.name?.slice(-1) || '人', isAdmin, canEdit: !!person.isSelf || (isAdmin && !person.isClaimed) || !!(person as any).myDelegatedFields?.length, canClaim: !person.isClaimed && !all.some(p => p.isSelf), relationLabel: relation?.label || (circle.type === 'classmate' ? '同班同学' : '关系待补充'), relationPath: relation?.path || '', relationMissing: relation?.missing || '', relationStatus: relation?.status || 'unrelated', alternatives: relation?.alternatives || '', rows, updated: dateText(person.updatedAt), loading: false });
  },
  onEdit(this: any) { go(`/pages/person-edit/index?circleId=${q(this.circleId)}&personId=${q(this.personId)}`); },
  onPrivacy(this: any) { go(`/pages/privacy/index?circleId=${q(this.circleId)}&personId=${q(this.personId)}`); },
  onCopyWechat(this: any) { wx.setClipboardData({ data: this.data.person.wechatId }); },
  onCall(this: any) { wx.makePhoneCall({ phoneNumber: this.data.person.phone }); },
  async onClaim(this: any) {
    if (!(await confirm('申请认领', `确认申请认领「${this.data.person.name}」吗？管理员需要核对身份。`))) return;
    const result = await invoke({ action: 'person.claim', payload: { circleId: this.circleId, personId: this.personId } });
    if (!result.ok) return showApiError(result);
    toast('认领申请已提交，等待管理员核对');
    this.loadData();
  },
  onSuggest(this: any) {
    wx.showModal({ title: '建议更正', editable: true, placeholderText: '写下你发现的问题或正确关系', confirmText: '提交建议', confirmColor: '#1d684e', success: async (r: any) => {
      if (!r.confirm) return;
      const message = (r.content || '').trim();
      if (!message) return toast('请先写下建议内容');
      const result = await invoke({ action: 'suggestion.create', payload: { circleId: this.circleId, type: this.data.circle.type === 'family' ? 'relation' : 'person', personId: this.personId, message } });
      if (!result.ok) return showApiError(result);
      toast('已提交给管理员');
    } });
  },
  async onDelete(this: any) {
    const relations = await invoke<{ relations: Relation[] }>({ action: 'relation.list', payload: { circleId: this.circleId } });
    const links = relations.ok ? relations.data.relations.filter(r => r.from === this.personId || r.to === this.personId).length : 0;
    if (links) return wx.showModal({ title: '暂不能删除', content: `这张卡连接着 ${links} 条家庭关系。先在管理页调整关系，再删除人物卡；否则会让其他人的关系路径断开。`, showCancel: false });
    if (!(await confirm('删除人物卡', `确定删除「${this.data.person.name}」吗？此操作不能撤回。`))) return;
    const result = await invoke({ action: 'person.delete', payload: { circleId: this.circleId, personId: this.personId } });
    if (!result.ok) return showApiError(result);
    toast('已删除人物卡'); wx.navigateBack();
  }
});
