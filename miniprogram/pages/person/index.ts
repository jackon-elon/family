import { Circle, Person, Relation, invoke, resolvePhotoUrls, showApiError } from '../../services/api';
import { confirm, dateText, go, q, toast } from '../../utils/navigation';
import { relationshipFor } from '../../utils/relationship';

const RELATION_TYPES = ['亲子（父母 → 子女）', '配偶', '兄弟姐妹'];
const RELATION_VALUES: Relation['type'][] = ['parent', 'spouse', 'sibling'];
const CORRECTION_MODES = ['新增遗漏的关系', '修改一条现有关系', '删除一条错误关系'];
function relationText(relation: Pick<Relation, 'from' | 'to' | 'type' | 'olderId'>, people: Person[]): string {
  const name = (id: string) => people.find(person => person.id === id)?.name || '人物';
  if (relation.type === 'parent') return `${name(relation.from)} 是 ${name(relation.to)} 的父母`;
  if (relation.type === 'spouse') return `${name(relation.from)} 与 ${name(relation.to)} 是配偶`;
  return `${name(relation.from)} 与 ${name(relation.to)} 是兄弟姐妹${relation.olderId ? `；${name(relation.olderId)} 较年长` : ''}`;
}
function proposalFrom(data: any): { removeRelationId?: string; relation?: { from: string; to: string; type: Relation['type']; olderId?: string } } | null {
  const mode = data.suggestionModeIndex;
  const existing = data.suggestionExisting[data.suggestionExistingIndex] as Relation | undefined;
  if (mode !== 0 && !existing) return null;
  const removeRelationId = mode !== 0 ? existing?.id : undefined;
  if (mode === 2) return { removeRelationId };
  const from = data.allPeople[data.suggestionFromIndex - 1] as Person | undefined;
  const to = data.allPeople[data.suggestionToIndex - 1] as Person | undefined;
  if (!from || !to || from.id === to.id) return null;
  const type = RELATION_VALUES[data.suggestionTypeIndex];
  const relation = { from: from.id, to: to.id, type, ...(type === 'sibling' && data.suggestionOlderIndex ? { olderId: data.suggestionOlderIndex === 1 ? from.id : to.id } : {}) };
  return { ...(removeRelationId ? { removeRelationId } : {}), relation };
}
function proposalText(data: any): string {
  const change = proposalFrom(data);
  if (!change) return '请选择两位不同的人物和现有关系';
  const before = data.suggestionExisting.find((r: Relation) => r.id === change.removeRelationId);
  return `${before ? `原关系：${relationText(before, data.allPeople)}；` : ''}${change.relation ? `建议：${relationText(change.relation, data.allPeople)}` : '建议删除这条关系'}`;
}

Page({
  data: { circle: null as Circle | null, person: null as Person | null, initial: '人', relationLabel: '', relationPath: '', relationMissing: '', relationStatus: '', alternatives: '', isAdmin: false, canEdit: false, canClaim: false, claimPending: false, claimBusy: false, rows: [] as { label: string; value: string }[], updated: '', updatedLabel: '', loading: true, loadError: '',
    allPeople: [] as Person[], suggestionExisting: [] as Relation[], suggestionExistingNames: [] as string[], personNames: [] as string[], showRelationSuggestion: false, suggestionModeOptions: CORRECTION_MODES, suggestionModeIndex: 0, suggestionExistingIndex: 0, suggestionTypeOptions: RELATION_TYPES, suggestionTypeIndex: 0, suggestionFromIndex: 0, suggestionToIndex: 1, suggestionOlderOptions: ['暂不确定', '第一位较年长', '第二位较年长'], suggestionOlderIndex: 0, suggestionMessage: '', suggestionPreview: '', submittingSuggestion: false },
  onLoad(this: any, options: any) { this.circleId = options.circleId; this.personId = options.personId; this.loadData(); },
  onShow(this: any) { if (this.personId && !this.data.loading) this.loadData(); },
  async loadData(this: any) {
    if (!this.circleId || !this.personId) { this.setData({ loading: false, loadError: '缺少人物信息，请返回圈子重新打开' }); return; }
    this.setData({ loading: true, loadError: '' });
    const [detail, current, people, relations, claims] = await Promise.all([
      invoke<{ circle: Circle; role: string }>({ action: 'circle.detail', payload: { circleId: this.circleId } }),
      invoke<{ person: Person }>({ action: 'person.get', payload: { circleId: this.circleId, personId: this.personId } }),
      invoke<{ persons: Person[] }>({ action: 'person.list', payload: { circleId: this.circleId } }),
      invoke<{ relations: Relation[] }>({ action: 'relation.list', payload: { circleId: this.circleId } }),
      invoke<{ claimRequests: Array<{status: string}> }>({ action: 'person.claimMine', payload: { circleId: this.circleId } })
    ]);
    if (!detail.ok || !current.ok || !people.ok || !relations.ok || !claims.ok) {
      const failed = [detail, current, people, relations, claims].find(result => !result.ok);
      this.setData({ loading: false, loadError: failed && !failed.ok ? failed.error.message : '加载失败，请重试' }); return;
    }
    const person = (await resolvePhotoUrls(this.circleId, [current.data.person]))[0];
    const circle = detail.data.circle;
    const all = people.data.persons;
    const relationList = relations.data.relations;
    const selfId = all.find(p => p.isSelf)?.id || '';
    const relation = circle.type === 'family' && selfId ? relationshipFor(all, relationList, selfId, person.id) : null;
    const rows = [
      { label: '所在城市', value: [person.country && person.country !== '中国' ? person.country : '', person.city].filter(Boolean).join(' · ') },
      { label: '目前状态', value: person.status }, { label: '学校', value: person.school },
      { label: '行业', value: person.industry }, { label: '职业', value: person.occupation },
      { label: '近况', value: person.bio }
    ].filter(x => !!x.value) as { label: string; value: string }[];
    const isAdmin = detail.data.role === 'owner' || detail.data.role === 'admin';
    const claimPending = claims.ok && claims.data.claimRequests.some(request => request.status === 'pending');
    wx.setNavigationBarTitle({ title: person.name });
    const relevant = relationList.filter(r => r.from === person.id || r.to === person.id);
    const suggestedData = { ...this.data, allPeople: all, suggestionExisting: relevant, suggestionFromIndex: 0, suggestionToIndex: 0 };
    this.setData({ circle, person, initial: person.name?.slice(-1) || '人', isAdmin, canEdit: !!person.isSelf || (isAdmin && !person.isClaimed) || !!(person as any).myDelegatedFields?.length, canClaim: !claimPending && !person.isClaimed && !all.some(p => p.isSelf), claimPending, relationLabel: relation?.label || (circle.type === 'classmate' ? '同班同学' : '关系待补充'), relationPath: relation?.path || '', relationMissing: relation?.missing || '', relationStatus: relation?.status || 'unrelated', alternatives: relation?.alternatives || '', rows, updated: person.lastConfirmedAt ? dateText(person.lastConfirmedAt) : person.updatedAt ? dateText(person.updatedAt) : '', updatedLabel: person.lastConfirmedAt ? '本人最近更新' : '资料最近更新', loading: false, allPeople: all, personNames: ['请选择人物', ...all.map(p => p.name)], suggestionExisting: relevant, suggestionExistingNames: relevant.map(r => relationText(r, all)), suggestionFromIndex: 0, suggestionToIndex: 0, suggestionPreview: proposalText(suggestedData) });
  },
  onRetry(this: any) { if (!this.data.loading) return this.loadData(); },
  onHome() { wx.reLaunch({ url: '/pages/circles/index' }); },
  onEdit(this: any) { go(`/pages/person-edit/index?circleId=${q(this.circleId)}&personId=${q(this.personId)}`); },
  onPhoto(this: any) { go(`/pages/person-edit/index?circleId=${q(this.circleId)}&personId=${q(this.personId)}&focus=photo`); },
  onPrivacy(this: any) { go(`/pages/privacy/index?circleId=${q(this.circleId)}&personId=${q(this.personId)}`); },
  onCopyWechat(this: any) { wx.setClipboardData({ data: this.data.person.wechatId }); },
  onCall(this: any) { wx.makePhoneCall({ phoneNumber: this.data.person.phone }); },
  async onClaim(this: any) {
    if (!this.data.canClaim || this.data.claimBusy) return;
    this.setData({claimBusy: true});
    if (!(await confirm('申请认领', `确认申请认领「${this.data.person.name}」吗？管理员需要核对身份。`))) { this.setData({claimBusy: false}); return; }
    const result = await invoke({ action: 'person.claim', payload: { circleId: this.circleId, personId: this.personId } });
    this.setData({claimBusy: false});
    if (!result.ok) return showApiError(result);
    toast('认领申请已提交，等待管理员核对');
    this.loadData();
  },
  onSuggest(this: any) {
    if (this.data.circle?.type === 'family') {
      wx.showActionSheet({ itemList: ['资料内容有误', '家庭关系有误'], success: (result: any) => {
        if (result.tapIndex === 1) this.setData({ showRelationSuggestion: true });
        else this.onSuggestPerson();
      } });
      return;
    }
    this.onSuggestPerson();
  },
  onSuggestPerson(this: any) {
    wx.showModal({ title: '建议更正', editable: true, placeholderText: '写下你发现的问题或正确关系', confirmText: '提交建议', confirmColor: '#1d684e', success: async (r: any) => {
      if (!r.confirm) return;
      const message = (r.content || '').trim();
      if (!message) return toast('请先写下建议内容');
      const result = await invoke({ action: 'suggestion.create', payload: { circleId: this.circleId, type: 'person', personId: this.personId, message } });
      if (!result.ok) return showApiError(result);
      toast('已提交给管理员');
    } });
  },
  onSuggestionPick(this: any, e: any) {
    const field = e.currentTarget.dataset.field;
    const index = Number(e.detail.value);
    if (field === 'suggestionModeIndex' && index !== 0 && !this.data.suggestionExisting.length) return toast('这张卡暂无已记录的关系，可以建议新增');
    const next: any = { ...this.data, [field]: index };
    if (field === 'suggestionExistingIndex' || field === 'suggestionModeIndex') {
      const existing = next.suggestionExisting[next.suggestionExistingIndex] as Relation | undefined;
      if (existing && next.suggestionModeIndex !== 0) {
        next.suggestionFromIndex = next.allPeople.findIndex((p: Person) => p.id === existing.from) + 1;
        next.suggestionToIndex = next.allPeople.findIndex((p: Person) => p.id === existing.to) + 1;
        next.suggestionTypeIndex = RELATION_VALUES.indexOf(existing.type);
        next.suggestionOlderIndex = existing.olderId ? existing.olderId === existing.from ? 1 : 2 : 0;
      }
    }
    this.setData({ [field]: index, suggestionFromIndex: next.suggestionFromIndex, suggestionToIndex: next.suggestionToIndex, suggestionTypeIndex: next.suggestionTypeIndex, suggestionOlderIndex: next.suggestionOlderIndex, suggestionPreview: proposalText(next) });
  },
  onSuggestionInput(this: any, e: any) { this.setData({ suggestionMessage: e.detail.value }); },
  onCancelRelationSuggestion(this: any) { this.setData({ showRelationSuggestion: false, suggestionMessage: '' }); },
  async onSubmitRelationSuggestion(this: any) {
    if (this.data.submittingSuggestion) return;
    const change = proposalFrom(this.data);
    if (!change) return toast('请核对关系中的人物');
    const message = this.data.suggestionMessage.trim();
    if (!message) return toast('请说明为什么要更正');
    this.setData({ submittingSuggestion: true });
    if (!(await confirm('提交关系更正', `${proposalText(this.data)}\n\n管理员审核前，关系网不会变化。`))) { this.setData({submittingSuggestion: false}); return; }
    const result = await invoke({ action: 'suggestion.create', payload: { circleId: this.circleId, type: 'relation', personId: this.personId, message, relationChange: change } });
    this.setData({ submittingSuggestion: false });
    if (!result.ok) return showApiError(result);
    this.setData({ showRelationSuggestion: false, suggestionMessage: '' });
    toast('关系建议已提交给管理员');
  },
  async onDelete(this: any) {
    if (this.deleteBusy) return;
    this.deleteBusy = true;
    const relations = await invoke<{ relations: Relation[] }>({ action: 'relation.list', payload: { circleId: this.circleId } });
    if (!relations.ok) { this.deleteBusy = false; return showApiError(relations); }
    const links = relations.data.relations.filter(r => r.from === this.personId || r.to === this.personId).length;
    if (links) { this.deleteBusy = false; return wx.showModal({ title: '暂不能删除', content: `这张卡连接着 ${links} 条家庭关系。先在管理页调整关系，再删除人物卡；否则会让其他人的关系路径断开。`, showCancel: false }); }
    if (!(await confirm('删除人物卡', `确定删除「${this.data.person.name}」吗？此操作不能撤回。`))) { this.deleteBusy = false; return; }
    const result = await invoke({ action: 'person.delete', payload: { circleId: this.circleId, personId: this.personId } });
    if (!result.ok) { this.deleteBusy = false; return showApiError(result); }
    toast('已删除人物卡'); wx.navigateBack();
  }
});
