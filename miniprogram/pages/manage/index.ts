import { AuditEvent, Circle, OwnerTransfer, Person, Relation, Member, JoinApplication, ClaimRequest, Suggestion, invoke, showApiError } from '../../services/api';
import { confirm, dateText, go, q, toast } from '../../utils/navigation';
import { buildStarLayout } from '../../components/star-network/layout';
import { relationshipFor } from '../../utils/relationship';

const RELATION_TYPES = ['亲子（父母 → 子女）', '配偶', '兄弟姐妹'];
const RELATION_VALUES = ['parent', 'spouse', 'sibling'];
const JOIN_RELATION_KINDS = ['', 'newParent', 'newChild', 'spouse', 'sibling'];
const JOIN_RELATION_OLDER = ['unknown', 'new', 'anchor'];
function joinRelationKindOptions(anchorName: string): string[] {
  return ['请选择两人的关系', `新成员是「${anchorName}」的父母`, `新成员是「${anchorName}」的子女`,
    `新成员与「${anchorName}」是配偶`, `新成员与「${anchorName}」是兄弟姐妹`];
}
function describeJoinedRelation(newName: string, anchorName: string, kind: string, older: string): string {
  if (kind === 'newParent') return `${newName} 是 ${anchorName} 的父母`;
  if (kind === 'newChild') return `${newName} 是 ${anchorName} 的子女`;
  if (kind === 'spouse') return `${newName} 与 ${anchorName} 是配偶`;
  return `${newName} 与 ${anchorName} 是兄弟姐妹${older === 'new' ? `；${newName} 年长` : older === 'anchor' ? `；${anchorName} 年长` : ''}`;
}
function birthdaySummary(value: any): string {
  return value && Number.isInteger(value.month) && Number.isInteger(value.day)
    ? `${value.year ? `${value.year}年` : ''}${value.calendar === 'lunar' ? '农历' : '阳历'}${value.leapMonth ? '闰' : ''}${value.month}月${value.day}日` : '生日未填';
}
type RelationDraft = Pick<Relation, 'from' | 'to' | 'type' | 'olderId'>;
function describeRelation(relation: RelationDraft, name: (id: string) => string, people: Person[] = []): string {
  if (relation.type === 'parent') {
    const gender = people.find(p => p.id === relation.from)?.gender;
    return `${name(relation.from)} 是 ${name(relation.to)} 的${gender === 'male' ? '爸爸' : gender === 'female' ? '妈妈' : '父亲或母亲'}`;
  }
  if (relation.type === 'spouse') return `${name(relation.from)} 与 ${name(relation.to)} 是配偶`;
  return `${name(relation.from)} 与 ${name(relation.to)} 是兄弟姐妹${relation.olderId ? `；${name(relation.olderId)} 较年长` : ''}`;
}
function draftFromData(data: any): RelationDraft | null {
  const from = data.people[data.fromIndex - 1] as Person | undefined;
  const to = data.people[data.toIndex - 1] as Person | undefined;
  if (!from || !to || from.id === to.id) return null;
  const type = RELATION_VALUES[data.relationIndex] as Relation['type'];
  return { from: from.id, to: to.id, type, ...(type === 'sibling' && data.olderIndex ? { olderId: data.olderIndex === 1 ? from.id : to.id } : {}) };
}
function impactText(people: Person[], relations: Relation[], oldId: string, next?: RelationDraft): string {
  const selfId = people.find(person => person.isSelf)?.id || '';
  const after = relations.filter(relation => relation.id !== oldId).concat(next ? [{ ...next, id: 'preview', circleId: '' }] : []);
  const beforeLayout = buildStarLayout(people, relations, selfId, selfId);
  const afterLayout = buildStarLayout(people, after, selfId, selfId);
  const beforeNodes = new Map(beforeLayout.nodes.map(node => [node.id, node]));
  const afterNodes = new Map(afterLayout.nodes.map(node => [node.id, node]));
  const changed = people.filter(person => {
    const beforeNode = beforeNodes.get(person.id);
    const afterNode = afterNodes.get(person.id);
    if (beforeNode?.generation !== afterNode?.generation || beforeNode?.isConflicted !== afterNode?.isConflicted) return true;
    if (!selfId) return false;
    const before = relationshipFor(people, relations, selfId, person.id);
    const future = relationshipFor(people, after, selfId, person.id);
    return before.label !== future.label || before.path !== future.path;
  });
  if (!changed.length) return '以你为起点，称呼和代际暂未变化；保存后仍会重新计算整个关系网。';
  return `以你为起点，预计 ${changed.length} 位人物的称呼、关系路径或代际位置变化：${changed.slice(0, 5).map(person => person.name).join('、')}${changed.length > 5 ? '等' : ''}。`;
}
function affectedText(impact: any, people: Person[]): string {
  const ids: string[] = impact?.affectedPersonIds || [];
  if (!ids.length) return '';
  const names = ids.slice(0, 5).map(id => people.find(person => person.id === id)?.name || '人物');
  return `这条关系连接的范围涉及 ${ids.length} 位人物：${names.join('、')}${ids.length > 5 ? '等' : ''}。`;
}
function auditRow(event: AuditEvent, people: Person[], members: Member[], circle: Circle): any {
  const name = (id: string) => people.find(p => p.id === id)?.name || '人物';
  const target = people.find(p => p.id === event.targetId)?.name || members.find(m => m.id === event.targetId)?.name || (event.targetId === circle.id ? circle.name : '');
  const details: any = event.details || {};
  const role = details.role === 'admin' ? '设为管理员' : details.role === 'member' ? '改为普通成员' : '';
  const relationLabel = (raw: any) => raw && raw.from && raw.to && raw.type ? describeRelation(raw, name, people) : '';
  const before = relationLabel(details.removed || details.before);
  const after = relationLabel(details.created || details.after);
  const change = before || after ? `${before || '无'} → ${after || '无'}` : '';
  const unclaim = event.type === 'person.unclaim' ? '本录私人资料已清空，人物与关系保留' : '';
  return { ...event, title: AUDIT_LABELS[event.type] || event.type, when: timeText(event.at), detail: [(event as any).actorName ? `操作人：${(event as any).actorName}` : '', target, role, change, unclaim, details.reason ? `原因：${details.reason}` : '', details.resolutionNote ? `处理说明：${details.resolutionNote}` : ''].filter(Boolean).join(' · ') };
}
const AUDIT_LABELS: Record<string, string> = {
  'circle.create': '创建亲友录', 'circle.upgrade': '开启邀请', 'circle.transferRequested': '申请更换创建者', 'circle.transferAccepted': '确认成为创建者', 'circle.transferCancelled': '取消更换创建者', 'circle.transferRejected': '拒绝成为创建者',
  'invite.create': '生成邀请', 'invite.revoke': '撤销邀请', 'join.approve': '批准加入', 'join.reject': '拒绝加入',
  'person.create': '添加人物', 'person.update': '更新资料', 'person.maintain': '修改资料', 'person.delete': '删除人物',
  'person.claimRequest': '申请确认本人资料', 'person.claimApprove': '已确认本人资料', 'person.claimReject': '未确认本人资料', 'person.unclaim': '更正本人资料归属',
  'relation.create': '添加关系', 'relation.replace': '修改关系', 'relation.delete': '删除关系', 'member.setRole': '调整管理员', 'member.remove': '移出成员', 'member.leave': '退出亲友录',
  'delegation.grant': '授权代维护', 'delegation.revoke': '撤销代维护', 'suggestion.create': '提交更正建议', 'suggestion.resolve': '处理更正建议'
};
function timeText(epoch: number): string {
  const d = new Date(epoch);
  return `${dateText(epoch)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

Page({
  data: {
    activeTab: 'people', personSearch: '', visiblePersonRows: [] as any[], pendingCount: 0, showRelationEditor: false,
    circle: null as Circle | null, people: [] as Person[], personRows: [] as any[], unclaimedPeople: [] as Person[], members: [] as Array<Member & {canManage?: boolean}>, applications: [] as JoinApplication[], joinTargetIds: [] as string[], joinTargetLabels: [] as string[],
    joinRelationAnchorIds: [] as string[], joinRelationAnchorLabels: [] as string[],
    joinRelationOlderOptions: ['长幼暂不确定', '新成员年长', '已选家人年长'],
    claimRequests: [] as ClaimRequest[], suggestions: [] as any[], relations: [] as Relation[], relationRows: [] as any[], isOwner: false, ownerTransfer: null as OwnerTransfer | null, ownerTransferExpiry: '', transferBusy: false,
    showTransferSettings: false, transferMemberIds: [] as string[], transferMemberNames: ['请选择一位成员'], transferMemberIndex: 0, memberActionBusy: false,
    auditEvents: [] as AuditEvent[], auditRows: [] as any[], showAllAudit: false, showAudit: false,
    personNames: [] as string[], canCreateRelation: false, fromIndex: 0, toIndex: 0, relationIndex: 0, olderIndex: 0, olderOptions: ['暂不确定', '第一位较年长', '第二位较年长'], relationTypes: RELATION_TYPES,
    editingRelationId: '', relationPreview: '', relationImpact: '', relationFocusPersonId: '', relationFocusName: '',
    busy: false, reviewBusy: false, removeCandidateId: '', removeCandidateName: '', removeBusy: false,
    loading: true, loadError: ''
  },
  onLoad(this: any, options: any) { this.circleId = options.circleId; this.loadData(); },
  onShow(this: any) { if (this.circleId && !this.data.loading) this.loadData(); },
  onPullDownRefresh(this: any) { this.loadData().finally(() => wx.stopPullDownRefresh()); },
  async loadData(this: any, afterReview = false) {
    if (this.data.busy || (this.data.reviewBusy && !afterReview)) return;
    if (!this.circleId) { this.setData({ loading: false, loadError: '未指定记录，请从亲友录重新进入管理页' }); return; }
    const loadVersion = (this.loadVersion || 0) + 1;
    this.loadVersion = loadVersion;
    this.setData({ loading: true, loadError: '' });
    const payload = { circleId: this.circleId };
    let results;
    try { results = await Promise.all([
      invoke<{ circle: Circle; role: string; ownerTransfer?: OwnerTransfer | null }>({ action: 'circle.detail', payload }),
      invoke<{ persons: Person[] }>({ action: 'person.list', payload }),
      invoke<{ members: Member[] }>({ action: 'member.list', payload }),
      invoke<{ applications: JoinApplication[] }>({ action: 'join.list', payload }),
      invoke<{ claimRequests: ClaimRequest[] }>({ action: 'person.claimList', payload }),
      invoke<{ suggestions: Suggestion[] }>({ action: 'suggestion.list', payload }),
      invoke<{ relations: Relation[] }>({ action: 'relation.list', payload }),
      invoke<{ events: AuditEvent[] }>({ action: 'audit.list', payload })
    ]); }
    catch (_) { if (this.loadVersion === loadVersion) this.setData({ loading: false, loadError: '管理资料暂时无法加载，请重试' }); return; }
    if (this.loadVersion !== loadVersion) return;
    const [detail, people, members, joins, claims, suggestions, relations, audits] = results;
    if (detail.ok && detail.data.role !== 'owner' && detail.data.role !== 'admin') { this.setData({ loading: false, loadError: '只有管理员可以进入管理页' }); return; }
    const failed = results.find(result => !result.ok);
    if (failed && !failed.ok) { this.setData({ loading: false, loadError: failed.error.message }); return; }
    const list = people.ok ? people.data.persons : [];
    const relationList = relations.ok ? relations.data.relations : [];
    const name = (id: string) => list.find(p => p.id === id)?.name || '已删除的人物';
    const focusId = list.some(p => p.id === this.data.relationFocusPersonId) ? this.data.relationFocusPersonId : '';
    const relationRows = relationList.filter(r => !focusId || r.from === focusId || r.to === focusId).map(r => ({ ...r, text: describeRelation(r, name, list) }));
    const isOwner = detail.data.role === 'owner';
    const memberRows = members.ok ? members.data.members.map(m => { const displayName = list.find(p => p.id === m.personId)?.name || m.name || (m.isSelf ? '我' : '成员'); return { ...m, name: displayName, initial: displayName.slice(-1), canManage: !m.isSelf && (isOwner || m.role === 'member') && m.role !== 'owner' }; }) : [];
    const transferMemberIds = memberRows.filter(m => !m.isSelf && m.role !== 'owner').map(m => m.id);
    const selectedTransferId = this.data.transferMemberIds[this.data.transferMemberIndex - 1];
    const transferMemberIndex = transferMemberIds.indexOf(selectedTransferId) + 1;
    const personRows = list.map(person => {
      const member = memberRows.find(m => m.personId === person.id);
      return {
        id: person.id, personId: person.id, memberId: member?.id || '',
        name: person.name, initial: person.name.slice(-1),
        roleLabel: member?.role === 'owner' || member?.role === 'admin' ? '管理员' : '',
        profileText: person.profileComplete === false ? '资料待补齐' : person.city || '资料已记录',
        canManage: !!member?.canManage, canDelete: !person.isClaimed
      };
    });
    const claimRows = claims.ok ? claims.data.claimRequests.filter(c => c.status === 'pending').map(c => ({ ...c, applicantName: memberRows.find(m => m.id === (c as any).memberId)?.name || c.applicantName || '成员', targetName: name(c.personId) })) : [];
    const suggestionRows = suggestions.ok ? suggestions.data.suggestions.filter(s => s.status === 'pending').map(s => {
      const change = (s as any).relationChange as { removeRelationId?: string; relation?: RelationDraft } | undefined;
      const before = change?.removeRelationId ? relationList.find(r => r.id === change.removeRelationId) : undefined;
      const after = change?.relation;
      return { ...s, structuredRelation: s.type === 'relation' && !!change && !!(change.removeRelationId || change.relation), beforeText: before ? describeRelation(before, name, list) : '', afterText: after ? describeRelation(after, name, list) : '', personName: s.personId ? name(s.personId) : '' };
    }) : [];
    const auditEvents = audits.ok ? audits.data.events : [];
    const auditRows = auditEvents.slice(0, this.data.showAllAudit ? 100 : 6).map(event => auditRow(event, list, memberRows, detail.data.circle));
    const fromId = this.data.people[this.data.fromIndex - 1]?.id;
    const toId = this.data.people[this.data.toIndex - 1]?.id;
    const fromIndex = fromId ? list.findIndex(p => p.id === fromId) + 1 : 0;
    const toIndex = toId ? list.findIndex(p => p.id === toId) + 1 : 0;
    const currentDraft = draftFromData({ ...this.data, people: list, fromIndex, toIndex });
    const unclaimed = list.filter(p => !p.isClaimed);
    const applicationRows = joins.ok ? joins.data.applications.filter(a => a.status === 'pending').map(a => {
      const status = (a as any).inviteStatus || 'active';
      const expiresAt = Number((a as any).inviteExpiresAt || 0);
      const unavailable = status !== 'active' || !!expiresAt && expiresAt <= Date.now();
      const expiringSoon = !unavailable && !!expiresAt && expiresAt - Date.now() <= 86400000;
      const inviteStatusText = unavailable ? '邀请已失效，无法批准；请重新发送邀请' : expiringSoon ? `邀请即将于 ${timeText(expiresAt)} 失效` : expiresAt ? `邀请有效至 ${timeText(expiresAt)}` : '';
      const profile = a.profile;
      const applicantName = String(a.name || a.applicantName || '').trim();
      const ownIndex = list.findIndex(person => person.isSelf);
      const relationAnchorIndex = ownIndex >= 0 ? ownIndex + 1 : list.length ? 1 : 0;
      return { ...a, applicantName, createdText: dateText(a.createdAt), inviteUnavailable: unavailable, inviteStatusText, inviteExpiringSoon: expiringSoon, targetIndex: 0,
        targetProfileText: '', targetDataMismatch: false,
        relationAnchorIndex, relationKindIndex: 0, relationOlderIndex: 0, deferRelation: false,
        relationKindOptions: joinRelationKindOptions(list[relationAnchorIndex - 1]?.name || '已选家人'),
        sameNameInCircle: !!applicantName && unclaimed.some(p => p.name.trim() === applicantName), profileText: profile && profile.birthday && profile.city ? `${profile.country} · ${profile.province ? profile.province + ' · ' : ''}${profile.city} · ${profile.birthday.calendar === 'lunar' ? '农历' : '阳历'}${profile.birthday.leapMonth ? '闰' : ''}${profile.birthday.month}月${profile.birthday.day}日` : '申请人的当前资料缺少城市或生日，请让对方补齐后刷新' };
    }) : [];
    const keyword = this.data.personSearch.trim().toLocaleLowerCase();
    this.setData({ fromIndex, toIndex, visiblePersonRows: personRows.filter(p => `${p.name} ${p.profileText}`.toLocaleLowerCase().includes(keyword)), pendingCount: applicationRows.length + claimRows.length + suggestionRows.length });
    this.setData({ circle: detail.data.circle, isOwner, ownerTransfer: detail.data.ownerTransfer || null, ownerTransferExpiry: detail.data.ownerTransfer ? timeText(detail.data.ownerTransfer.expiresAt) : '', transferMemberIds, transferMemberIndex, transferMemberNames: ['请选择一位成员', ...transferMemberIds.map(id => memberRows.find(m => m.id === id)!.name)], people: list, personRows, unclaimedPeople: unclaimed.map(p => ({ ...p, initial: p.name.slice(-1) })), joinTargetIds: ['__choose__', '', ...unclaimed.map(p => p.id)], joinTargetLabels: ['请选择：新增或使用已有资料', '这里还没有，新增资料', ...unclaimed.map(p => `已记录：${p.name}${p.city ? ' · ' + p.city : ''}`)],
      joinRelationAnchorIds: list.map(p => p.id), joinRelationAnchorLabels: ['请选择已有家人', ...list.map(p => `${p.isSelf ? '我 · ' : ''}${p.name}${p.city ? ' · ' + p.city : ''}`)],
      personNames: ['请选择人物', ...list.map(p => p.name)], canCreateRelation: list.length >= 2, members: memberRows, applications: applicationRows, claimRequests: claimRows, suggestions: suggestionRows, relations: relationList, relationRows, relationFocusPersonId: focusId, relationFocusName: focusId ? name(focusId) : '', auditEvents, auditRows, relationPreview: currentDraft ? describeRelation(currentDraft, name, list) : '', relationImpact: currentDraft ? impactText(list, relationList, this.data.editingRelationId, currentDraft) : '', loading: false, loadError: '' });
  },
  onRetry(this: any) { if (!this.data.loading) return this.loadData(); },
  onTab(this: any, e: any) {
    const activeTab = e.currentTarget.dataset.tab;
    if (!['people', 'relations', 'pending', 'settings'].includes(activeTab) || activeTab === 'relations' && this.data.circle?.type !== 'family') return;
    this.setData({ activeTab });
  },
  onPersonSearch(this: any, e: any) {
    const personSearch = String(e.detail.value || '');
    const keyword = personSearch.trim().toLocaleLowerCase();
    this.setData({ personSearch, visiblePersonRows: this.data.personRows.filter((p: any) => `${p.name} ${p.profileText}`.toLocaleLowerCase().includes(keyword)) });
  },
  onStartRelation(this: any) {
    if (this.data.busy) return;
    this.onCancelEdit();
    this.setData({ activeTab: 'relations', showRelationEditor: true }, () => wx.pageScrollTo({ selector: '#relation-editor', duration: 200 }));
  },
  onHome() { wx.reLaunch({ url: '/pages/circles/index' }); },
  onInvite(this: any) { go(`/pages/invite/index?circleId=${q(this.circleId)}`); },
  onAddPerson(this: any) { go(`/pages/person-edit/index?circleId=${q(this.circleId)}`); },
  onPerson(this: any, e: any) { go(`/pages/person/index?circleId=${q(this.circleId)}&personId=${q(e.currentTarget.dataset.id)}`); },
  onEditPerson(this: any, e: any) { go(`/pages/person-edit/index?circleId=${q(this.circleId)}&personId=${q(e.currentTarget.dataset.id)}`); },
  onPersonMenu(this: any, e: any) {
    const person = this.data.people.find((p: Person) => p.id === e.currentTarget.dataset.id);
    if (!person || person.isClaimed || this.deleteBusy) return;
    wx.showActionSheet({itemList: ['删除人物'], success: (result: any) => {
      if (result.tapIndex === 0) this.onDeletePerson(person.id);
    }});
  },
  async onDeletePerson(this: any, personId: string) {
    const person = this.data.people.find((p: Person) => p.id === personId);
    if (!person || person.isClaimed || this.deleteBusy) return;
    this.deleteBusy = true;
    try {
      const relations = await invoke<{relations: Relation[]}>({action: 'relation.list', payload: {circleId: this.circleId}});
      if (!relations.ok) return showApiError(relations);
      const links = relations.data.relations.filter(relation => relation.from === personId || relation.to === personId).length;
      if (links) {
        const goToRelations = await new Promise<boolean>(resolve => wx.showModal({title: '先调整家庭关系', content: `「${person.name}」还有 ${links} 条关系，请先调整后再删除。`, confirmText: '查看关系', confirmColor: '#1d684e', success: (result: any) => resolve(!!result.confirm), fail: () => resolve(false)}));
        if (goToRelations) this.onManagePersonRelation({currentTarget: {dataset: {id: personId}}});
        return;
      }
      if (!(await confirm('删除人物', `确定删除「${person.name}」吗？删除后无法恢复。`))) return;
      const result = await invoke({action: 'person.delete', payload: {circleId: this.circleId, personId}});
      if (!result.ok) return showApiError(result);
      toast('已删除人物');
      await this.loadData();
    } finally { this.deleteBusy = false; }
  },
  onManagePersonRelation(this: any, e: any) {
    if (this.data.busy) return;
    const person = this.data.people.find((p: Person) => p.id === e.currentTarget.dataset.id);
    if (!person) return toast('人物已变化，请刷新后重试');
    const fromIndex = this.data.people.findIndex((p: Person) => p.id === person.id) + 1;
    const relationRows = this.data.relations.filter((r: Relation) => r.from === person.id || r.to === person.id)
      .map((r: Relation) => ({...r, text: describeRelation(r, (id: string) => this.data.people.find((p: Person) => p.id === id)?.name || '人物', this.data.people)}));
    this.setData({activeTab: 'relations', showRelationEditor: false, relationFocusPersonId: person.id, relationFocusName: person.name, relationRows,
      editingRelationId: '', fromIndex, toIndex: 0, relationIndex: 0, olderIndex: 0,
      relationPreview: '', relationImpact: ''});
  },
  onClearRelationFocus(this: any) {
    const name = (id: string) => this.data.people.find((p: Person) => p.id === id)?.name || '人物';
    this.setData({relationFocusPersonId: '', relationFocusName: '', relationRows: this.data.relations.map((r: Relation) => ({...r, text: describeRelation(r, name, this.data.people)}))});
  },
  onPick(this: any, e: any) {
    if (this.data.busy) return;
    const field = e.currentTarget.dataset.field;
    const resetOlder = ['fromIndex', 'toIndex', 'relationIndex'].includes(field) && this.data[field] !== Number(e.detail.value);
    const data = { ...this.data, [field]: Number(e.detail.value), ...(resetOlder ? {olderIndex: 0} : {}) };
    const draft = draftFromData(data);
    const name = (id: string) => data.people.find((p: Person) => p.id === id)?.name || '人物';
    this.setData({ [field]: Number(e.detail.value), ...(resetOlder ? {olderIndex: 0} : {}), relationPreview: draft ? describeRelation(draft, name, this.data.people) : '请选择两位不同的人物', relationImpact: draft ? impactText(data.people, data.relations, data.editingRelationId, draft) : '' });
  },
  async onAddRelation(this: any) {
    if (this.data.busy) return;
    const d = this.data;
    const editingRelationId = d.editingRelationId;
    const draft = draftFromData(d);
    if (!draft) return toast('请选择两位不同的人物');
    this.setData({ busy: true });
    const action = editingRelationId ? 'relation.replace' : 'relation.create';
    const payload = editingRelationId ? { circleId: this.circleId, relationId: editingRelationId, relation: draft } : { circleId: this.circleId, ...draft };
    const result = await invoke({ action, payload });
    this.setData({ busy: false });
    if (!result.ok) return showApiError(result);
    toast(editingRelationId ? '关系已修改' : '关系已添加');
    const focusIndex = this.data.people.findIndex((p: Person) => p.id === this.data.relationFocusPersonId) + 1;
    this.setData({ showRelationEditor: false, editingRelationId: '', fromIndex: focusIndex, toIndex: 0, relationIndex: 0, olderIndex: 0 });
    this.loadData();
  },
  onEditRelation(this: any, e: any) {
    if (this.data.busy) return;
    const relation = this.data.relations.find((r: Relation) => r.id === e.currentTarget.dataset.id);
    if (!relation) return;
    const fromIndex = this.data.people.findIndex((p: Person) => p.id === relation.from) + 1;
    const toIndex = this.data.people.findIndex((p: Person) => p.id === relation.to) + 1;
    const relationIndex = RELATION_VALUES.indexOf(relation.type);
    const olderIndex = relation.olderId ? relation.olderId === relation.from ? 1 : 2 : 0;
    if (fromIndex < 1 || toIndex < 1) return toast('人物已不存在，无法编辑');
    const name = (id: string) => this.data.people.find((p: Person) => p.id === id)?.name || '人物';
    this.setData({ activeTab: 'relations', showRelationEditor: true, editingRelationId: relation.id, fromIndex, toIndex, relationIndex, olderIndex, relationPreview: describeRelation(relation, name, this.data.people), relationImpact: '关系网和称呼会随修改更新。' }, () => wx.pageScrollTo({ selector: '#relation-editor', duration: 200 }));
  },
  onCancelEdit(this: any) {
    if (this.data.busy) return;
    const focusIndex = this.data.people.findIndex((p: Person) => p.id === this.data.relationFocusPersonId) + 1;
    this.setData({ showRelationEditor: false, editingRelationId: '', fromIndex: focusIndex, toIndex: 0, relationIndex: 0, olderIndex: 0, relationImpact: '', relationPreview: '' });
  },
  async onDeleteRelation(this: any, e: any) {
    const relationId = e.currentTarget.dataset.id;
    const relation = this.data.relations.find((r: Relation) => r.id === relationId);
    if (!relation) return;
    const name = (id: string) => this.data.people.find((p: Person) => p.id === id)?.name || '人物';
    const preview = await invoke({ action: 'relation.preview', payload: { circleId: this.circleId, relationChange: { removeRelationId: relationId } } });
    if (!preview.ok) return showApiError(preview);
    if (!(await confirm('删除这条关系？', `${describeRelation(relation, name, this.data.people)}\n人物资料会保留，相关称呼会重新计算。`))) return;
    const result = await invoke({ action: 'relation.delete', payload: { circleId: this.circleId, relationId } });
    if (!result.ok) return showApiError(result);
    toast('关系已删除'); this.loadData();
  },
  onJoinTarget(this: any, e: any) {
    if (this.data.reviewBusy) return;
    const row = this.data.applications.findIndex((a: JoinApplication) => a.id === e.currentTarget.dataset.id);
    const index = Number(e.detail.value);
    if (row < 0 || !Number.isInteger(index) || index < 0 || index >= this.data.joinTargetIds.length) return;
    const a = this.data.applications[row];
    const target = this.data.people.find((person: Person) => person.id === this.data.joinTargetIds[index]);
    const targetProfileText = target ? `${target.name} · ${target.city || '城市未填'} · ${birthdaySummary(target.birthday)}` : '';
    const targetDataMismatch = !!target && (target.name !== a.applicantName ||
      target.country !== a.profile?.country || target.province !== a.profile?.province ||
      target.city !== a.profile?.city || birthdaySummary(target.birthday) !== birthdaySummary(a.profile?.birthday));
    this.setData({ [`applications[${row}].targetIndex`]: index,
      [`applications[${row}].targetProfileText`]: targetProfileText,
      [`applications[${row}].targetDataMismatch`]: targetDataMismatch });
  },
  onJoinRelationAnchor(this: any, e: any) {
    if (this.data.reviewBusy) return;
    const row = this.data.applications.findIndex((a: JoinApplication) => a.id === e.currentTarget.dataset.id);
    const index = Number(e.detail.value);
    if (row < 0 || !Number.isInteger(index) || index < 0 || index > this.data.joinRelationAnchorIds.length) return;
    const anchor = this.data.people.find((person: Person) => person.id === this.data.joinRelationAnchorIds[index - 1]);
    this.setData({[`applications[${row}].relationAnchorIndex`]: index, [`applications[${row}].relationKindIndex`]: 0,
      [`applications[${row}].relationOlderIndex`]: 0, [`applications[${row}].relationKindOptions`]: joinRelationKindOptions(anchor?.name || '已选家人')});
  },
  onJoinRelationKind(this: any, e: any) {
    if (this.data.reviewBusy) return;
    const row = this.data.applications.findIndex((a: JoinApplication) => a.id === e.currentTarget.dataset.id);
    const index = Number(e.detail.value);
    if (row < 0 || !Number.isInteger(index) || index < 0 || index >= JOIN_RELATION_KINDS.length) return;
    this.setData({[`applications[${row}].relationKindIndex`]: index, [`applications[${row}].relationOlderIndex`]: 0});
  },
  onJoinDeferRelation(this: any, e: any) {
    if (this.data.reviewBusy) return;
    const row = this.data.applications.findIndex((a: JoinApplication) => a.id === e.currentTarget.dataset.id);
    if (row < 0 || this.data.circle?.type !== 'family') return;
    this.setData({[`applications[${row}].deferRelation`]: !!e.detail.value});
  },
  onJoinRelationOlder(this: any, e: any) {
    if (this.data.reviewBusy) return;
    const row = this.data.applications.findIndex((a: JoinApplication) => a.id === e.currentTarget.dataset.id);
    const index = Number(e.detail.value);
    if (row < 0 || !Number.isInteger(index) || index < 0 || index >= JOIN_RELATION_OLDER.length) return;
    this.setData({[`applications[${row}].relationOlderIndex`]: index});
  },
  async onJoin(this: any, e: any) {
    if (this.data.reviewBusy) return;
    const { id, decision } = e.currentTarget.dataset;
    if (!['approve', 'reject'].includes(decision)) return;
    const a: any = this.data.applications.find((x: JoinApplication) => x.id === id);
    if (!a) return toast('申请已变化，请刷新后重试');
    if (decision === 'approve' && a?.inviteUnavailable) return toast('邀请已失效，请重新邀请申请人');
    if (decision === 'approve' && !a?.targetIndex) return toast('请先选择新增资料或使用已有资料');
    const targetPersonId = decision === 'approve' ? this.data.joinTargetIds[a.targetIndex] : '';
    const targetPerson = this.data.people.find((p: Person) => p.id === targetPersonId);
    const targetName = targetPerson?.name;
    if (targetPersonId && (!targetPerson || !Number.isFinite(targetPerson.updatedAt))) return toast('已有资料已变化，请刷新后重新选择');
    const newFamilyPerson = decision === 'approve' && a.targetIndex === 1 && this.data.circle?.type === 'family';
    const deferRelation = newFamilyPerson && !!a.deferRelation;
    const anchorPersonId = newFamilyPerson && !deferRelation ? this.data.joinRelationAnchorIds[a.relationAnchorIndex - 1] : undefined;
    if (newFamilyPerson && !deferRelation && this.data.joinRelationAnchorIds.length && !anchorPersonId) return toast('请先选择一位已有家人，再填写两人的关系');
    if (anchorPersonId && !a.relationKindIndex) return toast('请选择新成员与这位家人的关系');
    const initialRelation = anchorPersonId ? {anchorPersonId, kind: JOIN_RELATION_KINDS[a.relationKindIndex],
      ...(a.relationKindIndex === 4 ? {older: JOIN_RELATION_OLDER[a.relationOlderIndex]} : {})} : undefined;
    const anchorName = this.data.people.find((p: Person) => p.id === anchorPersonId)?.name || '已选家人';
    const relationText = initialRelation ? describeJoinedRelation(a.applicantName || a.name || '新成员', anchorName, initialRelation.kind, (initialRelation as any).older || 'unknown') : deferRelation ? '稍后补充' : '';
    const applicantName = a.applicantName || a.name || '申请人';
    const actionText = targetPersonId
      ? `确认「${applicantName}」就是已记录的「${targetName || '人物'}」？批准后使用这份资料，保留原有关系。`
      : `新增「${applicantName}」${relationText ? `，关系：${relationText}` : ''}。确认批准？`;
    if (decision === 'approve' && (a.profileIncomplete || !a.profile)) return toast('申请人当前资料不完整，请让对方补齐后刷新');
    if (decision === 'approve' && !a.reviewToken) return toast('审核资料尚未准备好，请刷新后重试');
    const changedNotice = a.profileChanged ? '申请人修改过资料，请按卡内对照核对。\n' : '';
    const summary = decision === 'approve'
      ? `${changedNotice}${actionText}${this.data.circle?.type === 'classmate' ? '请确认确实是同班同学。' : ''}`
      : `拒绝「${applicantName}」的加入申请？`;
    this.setData({reviewBusy: true});
    try {
      if (!(await confirm(decision === 'approve' ? '批准加入' : '拒绝申请', summary))) return;
      const result = await invoke({ action: `join.${decision}`, payload: { circleId: this.circleId, applicationId: id, ...(decision === 'approve' ? {reviewToken: a.reviewToken} : {}), ...(targetPersonId ? { targetPersonId, targetPersonUpdatedAt: targetPerson?.updatedAt } : {}), ...(initialRelation ? {initialRelation} : {}), ...(deferRelation ? {deferRelation: true} : {}) } });
      if (!result.ok) {
        if (result.error.code === 'PROFILE_CHANGED' || result.error.code === 'PROFILE_INCOMPLETE' || result.error.code === 'TARGET_CHANGED') {
          toast(result.error.message);
          await this.loadData(true);
          return;
        }
        return showApiError(result);
      }
      toast(decision === 'approve' ? '已批准加入' : '已拒绝申请'); await this.loadData(true);
    } finally { this.setData({reviewBusy: false}); }
  },
  async onClaim(this: any, e: any) {
    if (this.data.reviewBusy) return;
    const { id, decision } = e.currentTarget.dataset;
    if (!['approve', 'reject'].includes(decision)) return;
    const c = this.data.claimRequests.find((x: ClaimRequest) => x.id === id);
    const p = this.data.people.find((x: Person) => x.id === c?.personId);
    if (!c || !p) return toast('申请已变化，请刷新后重试');
    this.setData({reviewBusy: true});
    try {
      if (!(await confirm(decision === 'approve' ? '确认是本人' : '不是本人', `${c.applicantName || '申请人'}说「${p.name}」是自己。${decision === 'approve' ? '确认后可使用和修改这份资料。' : '拒绝后不会使用这份资料。'}`))) return;
      const result = await invoke({ action: `person.claim${decision === 'approve' ? 'Approve' : 'Reject'}`, payload: { circleId: this.circleId, claimRequestId: id } });
      if (!result.ok) return showApiError(result);
      toast('已处理本人确认申请'); await this.loadData(true);
    } finally { this.setData({reviewBusy: false}); }
  },
  async onSuggestion(this: any, e: any) {
    if (this.data.reviewBusy) return;
    const { id, status } = e.currentTarget.dataset;
    const suggestion = this.data.suggestions.find((s: any) => s.id === id);
    if (!suggestion) return;
    if (status === 'accepted' && !suggestion.structuredRelation) {
      return wx.showModal({ title: '先完成更正', content: '这条建议只有文字说明，无法自动修改资料或关系。请先核实并录入具体变更；保持待处理，避免显示“已采纳”但关系网没有变化。', showCancel: false });
    }
    if (status === 'handled' && suggestion.structuredRelation) return toast('请使用“预览并采纳”更新这条关系');
    this.setData({reviewBusy: true});
    try {
      let summary = suggestion.message;
      if (suggestion.structuredRelation) {
        const change = suggestion.relationChange;
        const preview = await invoke({ action: 'relation.preview', payload: { circleId: this.circleId, relationChange: change } });
        if (!preview.ok && status === 'accepted') return showApiError(preview);
        const impact = impactText(this.data.people, this.data.relations, change.removeRelationId || '', change.relation);
        summary += `\n\n${suggestion.beforeText ? `原关系：${suggestion.beforeText}\n` : ''}${suggestion.afterText ? `新关系：${suggestion.afterText}\n` : '将删除这条关系\n'}${preview.ok ? affectedText((preview.data as any).impact, this.data.people) : ''}\n${impact}`;
      }
      const title = status === 'accepted' ? '采纳并更新关系' : status === 'handled' ? '标记为已处理' : '拒绝更正建议';
      const resolutionNote = await new Promise<string | null>(resolve => wx.showModal({
        title, content: `${summary}\n\n请填写处理说明，供后续核对。${status === 'handled' ? '此操作不会自动修改资料或邀请。' : ''}`,
        editable: true, placeholderText: status === 'handled' ? '例如：已核对并更正城市' : '例如：已核实这条关系',
        confirmText: '确认处理', confirmColor: '#1d684e',
        success: (result: any) => resolve(result.confirm ? String(result.content || '').trim() : null),
        fail: () => resolve(null)
      }));
      if (resolutionNote === null) return;
      if (!resolutionNote || resolutionNote.length > 500) return toast('请填写 1 至 500 字的处理说明');
      const result = await invoke({ action: 'suggestion.resolve', payload: { circleId: this.circleId, suggestionId: id, status, resolutionNote } });
      if (!result.ok) return showApiError(result);
      toast(status === 'accepted' ? '关系已更新，建议已采纳' : status === 'handled' ? '建议已标记为处理完成' : '建议已拒绝'); await this.loadData(true);
    } finally { this.setData({reviewBusy: false}); }
  },
  onSuggestionTarget(this: any, e: any) {
    const suggestion = this.data.suggestions.find((s: any) => s.id === e.currentTarget.dataset.id);
    if (!suggestion) return;
    if (suggestion.type === 'relation') {
      if (suggestion.personId && this.data.people.some((p: Person) => p.id === suggestion.personId)) return this.onManagePersonRelation({currentTarget: {dataset: {id: suggestion.personId}}});
      this.onClearRelationFocus();
      this.setData({activeTab: 'relations', showRelationEditor: false});
      return;
    }
    if (suggestion.type === 'person' && suggestion.personId) return go(`/pages/person-edit/index?circleId=${q(this.circleId)}&personId=${q(suggestion.personId)}`);
    wx.showModal({ title: '请核对建议', content: suggestion.message, showCancel: false });
  },
  onRemove(this: any, e: any) {
    const memberId = e.currentTarget.dataset.id;
    const m = this.data.members.find((x: Member) => x.id === memberId);
    if (this.data.removeBusy || this.data.memberActionBusy || this.data.transferBusy) return;
    if (!m?.canManage || m.isSelf || m.role === 'owner') return toast('无法移出这位成员，请刷新后重试');
    this.setData({removeCandidateId: m.id, removeCandidateName: m.name || '这位成员'});
  },
  onCancelRemove(this: any) { if (!this.data.removeBusy) this.setData({removeCandidateId: '', removeCandidateName: ''}); },
  async onConfirmRemove(this: any) {
    if (this.data.removeBusy || this.data.memberActionBusy || this.data.transferBusy) return;
    const memberId = this.data.removeCandidateId;
    const m = this.data.members.find((x: Member) => x.id === memberId);
    if (!m?.canManage || m.isSelf || m.role === 'owner') return toast('成员已变化，请刷新后重试');
    this.setData({removeBusy: true});
    try {
      const result = await invoke({ action: 'member.remove', payload: { circleId: this.circleId, memberId } });
      if (!result.ok) return showApiError(result);
      this.setData({removeCandidateId: '', removeCandidateName: ''});
      toast('已移出成员'); await this.loadData();
    } finally { this.setData({removeBusy: false}); }
  },
  onMemberMenu(this: any, e: any) {
    const member = this.data.members.find((m: Member) => m.id === e.currentTarget.dataset.id);
    if (!member?.canManage || member.isSelf || member.role === 'owner' || this.data.memberActionBusy || this.data.removeBusy || this.data.transferBusy) return;
    const actions: { text: string; kind: string }[] = [];
    if (this.data.isOwner) {
      actions.push({ text: member.role === 'admin' ? '取消管理员' : '设为管理员', kind: member.role === 'admin' ? 'demote' : 'promote' });
    }
    if (member.role === 'member' || (this.data.isOwner && member.role === 'admin')) actions.push({ text: '移出成员', kind: 'remove' });
    if (!actions.length) return;
    wx.showActionSheet({ itemList: actions.map(a => a.text), success: (result: any) => this.performMemberAction(member, actions[result.tapIndex]?.kind) });
  },
  async performMemberAction(this: any, member: Member, kind?: string) {
    if (!kind || !['promote', 'demote', 'remove'].includes(kind) || this.data.memberActionBusy || this.data.removeBusy || this.data.transferBusy) return;
    // Recheck the current row after the action sheet closes; a stale row is not authority.
    const current = this.data.members.find((m: Member) => m.id === member.id);
    if (!current?.canManage || current.isSelf || current.role === 'owner') return;
    if (kind === 'remove') return this.onRemove({ currentTarget: { dataset: { id: member.id } } });
    if (!this.data.isOwner || current.role !== (kind === 'promote' ? 'member' : 'admin')) return;
    const role = kind === 'promote' ? 'admin' : 'member';
    this.setData({memberActionBusy: true, removeCandidateId: '', removeCandidateName: ''});
    try {
      if (!(await confirm(kind === 'promote' ? '设为管理员' : '取消管理员', kind === 'promote' ? `「${current.name || '这位成员'}」将可以邀请、审核成员，修改资料和关系。` : `「${current.name || '这位成员'}」将成为普通成员，仍可查看和修改自己的资料。`))) return;
      const result = await invoke({ action: 'member.setRole', payload: { circleId: this.circleId, memberId: current.id, role } });
      if (!result.ok) return showApiError(result);
      toast(kind === 'promote' ? '已设为管理员' : '已取消管理员'); await this.loadData();
    } finally { this.setData({memberActionBusy: false}); }
  },
  onToggleTransferSettings(this: any) {
    if (!this.data.isOwner || this.data.transferBusy) return;
    this.setData({showTransferSettings: !this.data.showTransferSettings});
  },
  onTransferMember(this: any, e: any) {
    const index = Number(e.detail.value);
    if (!this.data.isOwner || this.data.transferBusy || !Number.isInteger(index) || index < 0 || index > this.data.transferMemberIds.length) return;
    this.setData({transferMemberIndex: index});
  },
  async onRequestOwnerTransfer(this: any) {
    if (!this.data.isOwner || this.data.ownerTransfer || this.data.transferBusy || this.data.memberActionBusy || this.data.removeBusy) return;
    const memberId = this.data.transferMemberIds[this.data.transferMemberIndex - 1];
    const member = this.data.members.find((m: Member) => m.id === memberId);
    if (!member?.canManage || member.isSelf || member.role === 'owner') return toast('请先选择一位成员');
    this.setData({transferBusy: true, showTransferSettings: true, removeCandidateId: '', removeCandidateName: ''});
    try {
      if (!(await confirm('更换创建者', `对方确认后，「${member.name}」将成为创建者，你仍是管理员。请对方在 72 小时内确认。`))) return;
      const result = await invoke({action: 'circle.transferOwner', payload: {circleId: this.circleId, memberId}});
      if (!result.ok) return showApiError(result);
      toast('已发送，等待对方确认'); await this.loadData();
    } finally { this.setData({transferBusy: false}); }
  },
  async onCancelOwnerTransfer(this: any) {
    const transfer = this.data.ownerTransfer as OwnerTransfer | null;
    if (!this.data.isOwner || !transfer || this.data.transferBusy) return;
    this.setData({transferBusy: true});
    try {
      if (!(await confirm('取消更换', `不再将创建者身份交给「${transfer.targetName}」？`))) return;
      const result = await invoke({action: 'circle.cancelOwnerTransfer', payload: {circleId: this.circleId, transferId: transfer.id}});
      if (!result.ok) return showApiError(result);
      toast('已取消更换'); await this.loadData();
    } finally { this.setData({transferBusy: false}); }
  },
  onMoreAudit(this: any) {
    const showAllAudit = !this.data.showAllAudit;
    this.setData({ showAllAudit, auditRows: this.data.auditEvents.slice(0, showAllAudit ? 100 : 6).map((event: AuditEvent) => auditRow(event, this.data.people, this.data.members, this.data.circle)) });
  },
  onToggleAudit(this: any) {
    this.setData({showAudit: !this.data.showAudit});
  }
});
