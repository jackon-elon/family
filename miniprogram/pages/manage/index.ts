import { AuditEvent, Circle, Person, Relation, Member, JoinApplication, ClaimRequest, Suggestion, invoke, showApiError } from '../../services/api';
import { confirm, dateText, go, q, toast } from '../../utils/navigation';
import { buildStarLayout } from '../../components/star-network/layout';
import { relationshipFor } from '../../utils/relationship';

const RELATION_TYPES = ['亲子（父母 → 子女）', '配偶', '兄弟姐妹'];
const RELATION_VALUES = ['parent', 'spouse', 'sibling'];
type RelationDraft = Pick<Relation, 'from' | 'to' | 'type' | 'olderId'>;
function describeRelation(relation: RelationDraft, name: (id: string) => string): string {
  if (relation.type === 'parent') return `${name(relation.from)} 是 ${name(relation.to)} 的父母`;
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
  if (!changed.length) return '从当前本人卡看，称呼和代际暂未变化；保存后仍会重新计算整个关系网。';
  return `从当前本人卡看，预计 ${changed.length} 位人物的称呼、关系路径或代际位置变化：${changed.slice(0, 5).map(person => person.name).join('、')}${changed.length > 5 ? '等' : ''}。`;
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
  const relationLabel = (raw: any) => raw && raw.from && raw.to && raw.type ? describeRelation(raw, name) : '';
  const before = relationLabel(details.removed || details.before);
  const after = relationLabel(details.created || details.after);
  const change = before || after ? `${before || '无'} → ${after || '无'}` : '';
  const unclaim = event.type === 'person.unclaim' ? '已清除私人字段、撤销代维护授权；关系节点保留' : '';
  return { ...event, title: AUDIT_LABELS[event.type] || event.type, when: timeText(event.at), detail: [(event as any).actorName ? `操作人：${(event as any).actorName}` : '', target, role, change, unclaim, details.reason ? `原因：${details.reason}` : ''].filter(Boolean).join(' · ') };
}
const AUDIT_LABELS: Record<string, string> = {
  'circle.create': '创建圈子', 'circle.upgrade': '开启邀请共建', 'circle.transferOwner': '移交圈主',
  'invite.create': '生成邀请', 'invite.revoke': '撤销邀请', 'join.approve': '批准加入', 'join.reject': '拒绝加入',
  'person.create': '添加人物卡', 'person.update': '更新资料', 'person.maintain': '代维护资料', 'person.delete': '删除人物卡',
  'person.claimRequest': '申请认领', 'person.claimApprove': '批准认领', 'person.claimReject': '拒绝认领', 'person.unclaim': '解绑认领',
  'relation.create': '添加关系', 'relation.replace': '修改关系', 'relation.delete': '删除关系', 'member.setRole': '调整管理员', 'member.remove': '移出成员', 'member.leave': '退出圈子',
  'delegation.grant': '授权代维护', 'delegation.revoke': '撤销代维护', 'suggestion.create': '提交更正建议', 'suggestion.resolve': '处理更正建议'
};
function timeText(epoch: number): string {
  const d = new Date(epoch);
  return `${dateText(epoch)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

Page({
  data: {
    circle: null as Circle | null, people: [] as Person[], unclaimedPeople: [] as Person[], members: [] as Member[], applications: [] as JoinApplication[], claimRequests: [] as ClaimRequest[], suggestions: [] as any[], relations: [] as Relation[], relationRows: [] as any[], isOwner: false,
    auditEvents: [] as AuditEvent[], auditRows: [] as any[], showAllAudit: false,
    personNames: [] as string[], canCreateRelation: false, fromIndex: 0, toIndex: 0, relationIndex: 0, olderIndex: 0, olderOptions: ['暂不确定', '第一位较年长', '第二位较年长'], relationTypes: RELATION_TYPES,
    editingRelationId: '', relationPreview: '', relationImpact: '',
    busy: false
  },
  onLoad(this: any, options: any) { this.circleId = options.circleId; this.loadData(); },
  onShow(this: any) { if (this.circleId) this.loadData(); },
  onPullDownRefresh(this: any) { this.loadData().finally(() => wx.stopPullDownRefresh()); },
  async loadData(this: any) {
    const payload = { circleId: this.circleId };
    const [detail, people, members, joins, claims, suggestions, relations, audits] = await Promise.all([
      invoke<{ circle: Circle; role: string }>({ action: 'circle.detail', payload }),
      invoke<{ persons: Person[] }>({ action: 'person.list', payload }),
      invoke<{ members: Member[] }>({ action: 'member.list', payload }),
      invoke<{ applications: JoinApplication[] }>({ action: 'join.list', payload }),
      invoke<{ claimRequests: ClaimRequest[] }>({ action: 'person.claimList', payload }),
      invoke<{ suggestions: Suggestion[] }>({ action: 'suggestion.list', payload }),
      invoke<{ relations: Relation[] }>({ action: 'relation.list', payload }),
      invoke<{ events: AuditEvent[] }>({ action: 'audit.list', payload })
    ]);
    if (!detail.ok) return showApiError(detail);
    if (detail.data.role !== 'owner' && detail.data.role !== 'admin') { toast('只有管理员可以进入管理页'); wx.navigateBack(); return; }
    const list = people.ok ? people.data.persons : [];
    const relationList = relations.ok ? relations.data.relations : [];
    const name = (id: string) => list.find(p => p.id === id)?.name || '已删除的人物';
    const relationRows = relationList.map(r => ({ ...r, text: describeRelation(r, name) }));
    const isOwner = detail.data.role === 'owner';
    const memberRows = members.ok ? members.data.members.map(m => { const displayName = list.find(p => p.id === m.personId)?.name || m.name || (m.isSelf ? '我' : '未认领成员'); return { ...m, name: displayName, initial: displayName.slice(-1), canManage: !m.isSelf && (isOwner || m.role === 'member') && m.role !== 'owner' }; }) : [];
    const claimRows = claims.ok ? claims.data.claimRequests.filter(c => c.status === 'pending').map(c => ({ ...c, applicantName: memberRows.find(m => m.id === (c as any).memberId)?.name || c.applicantName || '未认领成员', targetName: name(c.personId) })) : [];
    const suggestionRows = suggestions.ok ? suggestions.data.suggestions.filter(s => s.status === 'pending').map(s => {
      const change = (s as any).relationChange as { removeRelationId?: string; relation?: RelationDraft } | undefined;
      const before = change?.removeRelationId ? relationList.find(r => r.id === change.removeRelationId) : undefined;
      const after = change?.relation;
      return { ...s, structuredRelation: s.type === 'relation' && !!change && (!!before || !!after), beforeText: before ? describeRelation(before, name) : '', afterText: after ? describeRelation(after, name) : '', personName: s.personId ? name(s.personId) : '' };
    }) : [];
    const auditEvents = audits.ok ? audits.data.events : [];
    const auditRows = auditEvents.slice(0, this.data.showAllAudit ? 100 : 6).map(event => auditRow(event, list, memberRows, detail.data.circle));
    const currentDraft = draftFromData({ ...this.data, people: list });
    const applicationRows = joins.ok ? joins.data.applications.filter(a => a.status === 'pending').map(a => {
      const status = (a as any).inviteStatus || 'active';
      const expiresAt = Number((a as any).inviteExpiresAt || 0);
      const unavailable = status !== 'active' || !!expiresAt && expiresAt <= Date.now();
      const expiringSoon = !unavailable && !!expiresAt && expiresAt - Date.now() <= 86400000;
      const inviteStatusText = unavailable ? '邀请已失效，无法批准；请重新发送邀请' : expiringSoon ? `邀请即将于 ${timeText(expiresAt)} 失效` : expiresAt ? `邀请有效至 ${timeText(expiresAt)}` : '';
      return { ...a, createdText: dateText(a.createdAt), inviteUnavailable: unavailable, inviteStatusText, inviteExpiringSoon: expiringSoon };
    }) : [];
    this.setData({ circle: detail.data.circle, isOwner, people: list, unclaimedPeople: list.filter(p => !p.isClaimed).map(p => ({ ...p, initial: p.name.slice(-1) })), personNames: ['请选择人物', ...list.map(p => p.name)], canCreateRelation: list.length >= 2, members: memberRows, applications: applicationRows, claimRequests: claimRows, suggestions: suggestionRows, relations: relationList, relationRows, auditEvents, auditRows, relationPreview: currentDraft ? describeRelation(currentDraft, name) : '', relationImpact: currentDraft ? impactText(list, relationList, this.data.editingRelationId, currentDraft) : '' });
  },
  onInvite(this: any) { go(`/pages/invite/index?circleId=${q(this.circleId)}`); },
  onAddPerson(this: any) { go(`/pages/person-edit/index?circleId=${q(this.circleId)}`); },
  onPerson(this: any, e: any) { go(`/pages/person/index?circleId=${q(this.circleId)}&personId=${q(e.currentTarget.dataset.id)}`); },
  onPick(this: any, e: any) {
    const data = { ...this.data, [e.currentTarget.dataset.field]: Number(e.detail.value) };
    const draft = draftFromData(data);
    const name = (id: string) => data.people.find((p: Person) => p.id === id)?.name || '人物';
    this.setData({ [e.currentTarget.dataset.field]: Number(e.detail.value), relationPreview: draft ? describeRelation(draft, name) : '请选择两位不同的人物', relationImpact: draft ? impactText(data.people, data.relations, data.editingRelationId, draft) : '' });
  },
  async onAddRelation(this: any) {
    const d = this.data;
    const draft = draftFromData(d);
    if (!draft) return toast('请选择两位不同的人物');
    const change = { ...(d.editingRelationId ? { removeRelationId: d.editingRelationId } : {}), relation: draft };
    const validation = await invoke({ action: 'relation.preview', payload: { circleId: this.circleId, relationChange: change } });
    if (!validation.ok) return showApiError(validation);
    const before = d.editingRelationId ? d.relations.find((r: Relation) => r.id === d.editingRelationId) : null;
    const name = (id: string) => d.people.find((p: Person) => p.id === id)?.name || '人物';
    const summary = `${before ? `原关系：${describeRelation(before, name)}\n` : ''}新关系：${describeRelation(draft, name)}\n\n${affectedText((validation.data as any).impact, d.people)}\n${impactText(d.people, d.relations, d.editingRelationId, draft)}\n请确认人物与亲子方向。`;
    if (!(await confirm(before ? '确认修改关系' : '确认添加关系', summary))) return;
    if (this.data.busy) return;
    this.setData({ busy: true });
    const action = d.editingRelationId ? 'relation.replace' : 'relation.create';
    const payload = d.editingRelationId ? { circleId: this.circleId, relationId: d.editingRelationId, relation: draft } : { circleId: this.circleId, ...draft };
    const result = await invoke({ action, payload });
    this.setData({ busy: false });
    if (!result.ok) return showApiError(result);
    toast(d.editingRelationId ? '关系已修改' : '关系已添加');
    this.setData({ editingRelationId: '', fromIndex: 0, toIndex: 0, relationIndex: 0, olderIndex: 0 });
    this.loadData();
  },
  onEditRelation(this: any, e: any) {
    const relation = this.data.relations.find((r: Relation) => r.id === e.currentTarget.dataset.id);
    if (!relation) return;
    const fromIndex = this.data.people.findIndex((p: Person) => p.id === relation.from) + 1;
    const toIndex = this.data.people.findIndex((p: Person) => p.id === relation.to) + 1;
    const relationIndex = RELATION_VALUES.indexOf(relation.type);
    const olderIndex = relation.olderId ? relation.olderId === relation.from ? 1 : 2 : 0;
    if (fromIndex < 1 || toIndex < 1) return toast('人物已不存在，无法编辑');
    const name = (id: string) => this.data.people.find((p: Person) => p.id === id)?.name || '人物';
    this.setData({ editingRelationId: relation.id, fromIndex, toIndex, relationIndex, olderIndex, relationPreview: describeRelation(relation, name), relationImpact: '请选择新的关系内容，保存前会显示具体影响。' });
    wx.pageScrollTo({ selector: '#relation-editor', duration: 250 });
  },
  onCancelEdit(this: any) {
    this.setData({ editingRelationId: '', fromIndex: 0, toIndex: 0, relationIndex: 0, olderIndex: 0, relationImpact: '', relationPreview: '' });
  },
  async onDeleteRelation(this: any, e: any) {
    const relationId = e.currentTarget.dataset.id;
    const relation = this.data.relations.find((r: Relation) => r.id === relationId);
    if (!relation) return;
    const name = (id: string) => this.data.people.find((p: Person) => p.id === id)?.name || '人物';
    const preview = await invoke({ action: 'relation.preview', payload: { circleId: this.circleId, relationChange: { removeRelationId: relationId } } });
    if (!preview.ok) return showApiError(preview);
    if (!(await confirm('确认删除关系', `将删除：${describeRelation(relation, name)}\n\n${affectedText((preview.data as any).impact, this.data.people)}\n${impactText(this.data.people, this.data.relations, relationId)}\n人物卡会保留。`))) return;
    const result = await invoke({ action: 'relation.delete', payload: { circleId: this.circleId, relationId } });
    if (!result.ok) return showApiError(result);
    toast('关系已删除'); this.loadData();
  },
  async onJoin(this: any, e: any) {
    const { id, decision } = e.currentTarget.dataset;
    const a: any = this.data.applications.find((x: JoinApplication) => x.id === id);
    if (decision === 'approve' && a?.inviteUnavailable) return toast('邀请已失效，请重新邀请申请人');
    if (!(await confirm(decision === 'approve' ? '批准加入' : '拒绝申请', `${a?.name || a?.applicantName || '这位申请人'}：${a?.note || '未填写说明'}\n请先确认是认识的人${this.data.circle?.type === 'classmate' ? '，且确实是同班同学' : ''}。`))) return;
    const result = await invoke({ action: `join.${decision}`, payload: { circleId: this.circleId, applicationId: id } });
    if (!result.ok) return showApiError(result);
    toast(decision === 'approve' ? '已批准加入' : '已拒绝申请'); this.loadData();
  },
  async onClaim(this: any, e: any) {
    const { id, decision } = e.currentTarget.dataset;
    const c = this.data.claimRequests.find((x: ClaimRequest) => x.id === id);
    const p = this.data.people.find((x: Person) => x.id === c?.personId);
    if (!(await confirm(decision === 'approve' ? '批准认领' : '拒绝认领', `${c?.applicantName || '申请人'}想认领「${p?.name || '人物卡'}」。请核对本人身份。`))) return;
    const result = await invoke({ action: `person.claim${decision === 'approve' ? 'Approve' : 'Reject'}`, payload: { circleId: this.circleId, claimRequestId: id } });
    if (!result.ok) return showApiError(result);
    toast('认领申请已处理'); this.loadData();
  },
  async onSuggestion(this: any, e: any) {
    const { id, status } = e.currentTarget.dataset;
    const suggestion = this.data.suggestions.find((s: any) => s.id === id);
    if (!suggestion) return;
    if (status === 'accepted' && !suggestion.structuredRelation) {
      return wx.showModal({ title: '先完成更正', content: '这条建议只有文字说明，无法自动修改资料或关系。请先核实并录入具体变更；保持待处理，避免显示“已采纳”但关系网没有变化。', showCancel: false });
    }
    let summary = suggestion.message;
    if (suggestion.structuredRelation) {
      const change = suggestion.relationChange;
      const preview = await invoke({ action: 'relation.preview', payload: { circleId: this.circleId, relationChange: change } });
      if (!preview.ok && status === 'accepted') return showApiError(preview);
      const impact = impactText(this.data.people, this.data.relations, change.removeRelationId || '', change.relation);
      summary += `\n\n${suggestion.beforeText ? `原关系：${suggestion.beforeText}\n` : ''}${suggestion.afterText ? `新关系：${suggestion.afterText}\n` : '将删除这条关系\n'}${preview.ok ? affectedText((preview.data as any).impact, this.data.people) : ''}\n${impact}`;
    }
    if (!(await confirm(status === 'accepted' ? '采纳并更新关系' : '拒绝更正建议', summary))) return;
    const result = await invoke({ action: 'suggestion.resolve', payload: { circleId: this.circleId, suggestionId: id, status } });
    if (!result.ok) return showApiError(result);
    toast(status === 'accepted' ? '关系已更新，建议已采纳' : '建议已拒绝'); this.loadData();
  },
  onSuggestionTarget(this: any, e: any) {
    const suggestion = this.data.suggestions.find((s: any) => s.id === e.currentTarget.dataset.id);
    if (!suggestion) return;
    if (suggestion.type === 'relation') return wx.pageScrollTo({ selector: '#relation-editor', duration: 250 });
    if (suggestion.personId) return go(`/pages/person/index?circleId=${q(this.circleId)}&personId=${q(suggestion.personId)}`);
    wx.showModal({ title: '请核对建议', content: suggestion.message, showCancel: false });
  },
  async onUnclaim(this: any, member: Member) {
    if (!member.personId) return;
    const person = this.data.people.find((p: Person) => p.id === member.personId);
    if (!person) return toast('对应人物卡已不存在');
    const approved = await new Promise<boolean>(resolve => wx.showModal({
      title: '解绑错误认领',
      content: `将「${member.name || '成员'}」与「${person.name}」的人物卡解绑。该成员仍可进入圈子，但人物卡中的照片、地点、联系方式等私人资料会被清空，代维护授权也会失效。关系节点保留。请输入人物姓名确认。`,
      editable: true, placeholderText: person.name, confirmText: '确认解绑', confirmColor: '#b65654',
      success: (result: any) => resolve(!!result.confirm && String(result.content || '').trim() === person.name), fail: () => resolve(false)
    }));
    if (!approved) return toast('未输入正确姓名，未解绑');
    const result = await invoke({ action: 'person.unclaim', payload: { circleId: this.circleId, personId: person.id, reasonCode: 'wrong_person' } });
    if (!result.ok) return showApiError(result);
    toast('已解绑，成员可重新申请认领'); this.loadData();
  },
  async onRemove(this: any, e: any) {
    const memberId = e.currentTarget.dataset.id;
    const m = this.data.members.find((x: Member) => x.id === memberId);
    if (!(await confirm('移出成员', `确定将「${m?.name || '成员'}」移出圈子吗？TA 会立即失去访问权，关系节点会保留最少信息。`))) return;
    const result = await invoke({ action: 'member.remove', payload: { circleId: this.circleId, memberId } });
    if (!result.ok) return showApiError(result);
    toast('已移出成员'); this.loadData();
  },
  onMemberMenu(this: any, e: any) {
    const member = this.data.members.find((m: Member) => m.id === e.currentTarget.dataset.id);
    if (!member || member.isSelf || member.role === 'owner') return;
    const actions: { text: string; kind: string }[] = [];
    if (this.data.isOwner) {
      actions.push({ text: member.role === 'admin' ? '取消管理员' : '设为管理员', kind: member.role === 'admin' ? 'demote' : 'promote' });
      actions.push({ text: '移交圈主给 TA', kind: 'transfer' });
    }
    if (member.personId) actions.push({ text: '纠正错误认领', kind: 'unclaim' });
    if (member.role === 'member') actions.push({ text: '移出圈子', kind: 'remove' });
    if (!actions.length) return;
    wx.showActionSheet({ itemList: actions.map(a => a.text), success: (result: any) => this.performMemberAction(member, actions[result.tapIndex]?.kind) });
  },
  async performMemberAction(this: any, member: Member, kind?: string) {
    if (!kind) return;
    if (kind === 'unclaim') return this.onUnclaim(member);
    if (kind === 'remove') return this.onRemove({ currentTarget: { dataset: { id: member.id } } });
    if (kind === 'transfer') {
      if (!(await confirm('移交圈主', `将圈主移交给「${member.name || '这位成员'}」后，你会成为管理员。只有新圈主能再次移交。确定吗？`))) return;
      const result = await invoke({ action: 'circle.transferOwner', payload: { circleId: this.circleId, memberId: member.id } });
      if (!result.ok) return showApiError(result);
      toast('圈主已移交'); this.loadData(); return;
    }
    const role = kind === 'promote' ? 'admin' : 'member';
    if (!(await confirm(kind === 'promote' ? '设为管理员' : '取消管理员', kind === 'promote' ? `「${member.name || '这位成员'}」将可以邀请和审核成员。` : `「${member.name || '这位成员'}」将失去管理权限，代维护授权也会失效。`))) return;
    const result = await invoke({ action: 'member.setRole', payload: { circleId: this.circleId, memberId: member.id, role } });
    if (!result.ok) return showApiError(result);
    toast('成员角色已更新'); this.loadData();
  },
  onMoreAudit(this: any) {
    const showAllAudit = !this.data.showAllAudit;
    this.setData({ showAllAudit, auditRows: this.data.auditEvents.slice(0, showAllAudit ? 100 : 6).map((event: AuditEvent) => auditRow(event, this.data.people, this.data.members, this.data.circle)) });
  }
});
