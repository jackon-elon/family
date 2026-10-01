import { AuditEvent, Circle, Person, Relation, Member, JoinApplication, ClaimRequest, Suggestion, invoke, showApiError } from '../../services/api';
import { confirm, dateText, go, q, toast } from '../../utils/navigation';

const RELATION_TYPES = ['亲子：左边是父母', '配偶', '兄弟姐妹'];
const RELATION_VALUES = ['parent', 'spouse', 'sibling'];
const AUDIT_LABELS: Record<string, string> = {
  'circle.create': '创建圈子', 'circle.upgrade': '开启邀请共建', 'circle.transferOwner': '移交圈主',
  'invite.create': '生成邀请', 'invite.revoke': '撤销邀请', 'join.approve': '批准加入', 'join.reject': '拒绝加入',
  'person.create': '添加人物卡', 'person.update': '更新资料', 'person.maintain': '代维护资料', 'person.delete': '删除人物卡',
  'person.claimRequest': '申请认领', 'person.claimApprove': '批准认领', 'person.claimReject': '拒绝认领', 'person.unclaim': '解绑认领',
  'relation.create': '添加关系', 'relation.delete': '删除关系', 'member.setRole': '调整管理员', 'member.remove': '移出成员', 'member.leave': '退出圈子',
  'delegation.grant': '授权代维护', 'delegation.revoke': '撤销代维护', 'suggestion.create': '提交更正建议', 'suggestion.resolve': '处理更正建议'
};
function timeText(epoch: number): string {
  const d = new Date(epoch);
  return `${dateText(epoch)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

Page({
  data: {
    circle: null as Circle | null, people: [] as Person[], members: [] as Member[], applications: [] as JoinApplication[], claimRequests: [] as ClaimRequest[], suggestions: [] as Suggestion[], relations: [] as Relation[], relationRows: [] as any[], isOwner: false,
    auditEvents: [] as AuditEvent[], auditRows: [] as any[], showAllAudit: false,
    personNames: [] as string[], fromIndex: 0, toIndex: 0, relationIndex: 0, olderIndex: 0, olderOptions: ['不确定', '左边这位较年长', '右边这位较年长'], relationTypes: RELATION_TYPES,
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
    const relationRows = relationList.map(r => ({ ...r, text: r.type === 'parent' ? `${name(r.from)} → ${name(r.to)} · 亲子` : `${name(r.from)} ↔ ${name(r.to)} · ${r.type === 'spouse' ? '配偶' : '兄弟姐妹'}`, extra: r.olderId ? `较年长：${name(r.olderId)}` : '' }));
    const isOwner = detail.data.role === 'owner';
    const memberRows = members.ok ? members.data.members.map(m => { const displayName = list.find(p => p.id === m.personId)?.name || m.name || (m.isSelf ? '我' : '未认领成员'); return { ...m, name: displayName, initial: displayName.slice(-1), canManage: !m.isSelf && (isOwner || m.role === 'member') && m.role !== 'owner' }; }) : [];
    const claimRows = claims.ok ? claims.data.claimRequests.filter(c => c.status === 'pending').map(c => ({ ...c, applicantName: memberRows.find(m => m.id === (c as any).memberId)?.name || c.applicantName || '未认领成员' })) : [];
    const auditEvents = audits.ok ? audits.data.events : [];
    const auditRows = auditEvents.slice(0, this.data.showAllAudit ? 100 : 6).map(event => {
      const target = list.find(p => p.id === event.targetId)?.name || memberRows.find(m => m.id === event.targetId)?.name || (event.targetId === detail.data.circle.id ? detail.data.circle.name : '');
      const role = event.details?.role === 'admin' ? '设为管理员' : event.details?.role === 'member' ? '改为普通成员' : '';
      return { ...event, title: AUDIT_LABELS[event.type] || event.type, when: timeText(event.at), detail: [target, role].filter(Boolean).join(' · ') };
    });
    this.setData({ circle: detail.data.circle, isOwner, people: list, personNames: list.map(p => p.name), members: memberRows, applications: joins.ok ? joins.data.applications.filter(a => a.status === 'pending').map(a => ({ ...a, createdText: dateText(a.createdAt) })) : [], claimRequests: claimRows, suggestions: suggestions.ok ? suggestions.data.suggestions.filter(s => s.status === 'pending') : [], relations: relationList, relationRows, auditEvents, auditRows });
  },
  onInvite(this: any) { go(`/pages/invite/index?circleId=${q(this.circleId)}`); },
  onAddPerson(this: any) { go(`/pages/person-edit/index?circleId=${q(this.circleId)}`); },
  onPerson(this: any, e: any) { go(`/pages/person/index?circleId=${q(this.circleId)}&personId=${q(e.currentTarget.dataset.id)}`); },
  onPick(this: any, e: any) { this.setData({ [e.currentTarget.dataset.field]: Number(e.detail.value) }); },
  async onAddRelation(this: any) {
    const d = this.data;
    const from = d.people[d.fromIndex]; const to = d.people[d.toIndex];
    if (!from || !to) return toast('请先添加两个人物');
    if (from.id === to.id) return toast('请选择两个不同的人');
    const type = RELATION_VALUES[d.relationIndex];
    const payload: any = { circleId: this.circleId, from: from.id, to: to.id, type };
    if (type === 'sibling' && d.olderIndex) payload.olderId = d.olderIndex === 1 ? from.id : to.id;
    const result = await invoke({ action: 'relation.create', payload });
    if (!result.ok) return showApiError(result);
    toast('关系已添加'); this.loadData();
  },
  async onDeleteRelation(this: any, e: any) {
    const relationId = e.currentTarget.dataset.id;
    if (!(await confirm('删除关系', '这会改变相关人物的称呼和关系路径。确定删除吗？'))) return;
    const result = await invoke({ action: 'relation.delete', payload: { circleId: this.circleId, relationId } });
    if (!result.ok) return showApiError(result);
    toast('关系已删除'); this.loadData();
  },
  async onJoin(this: any, e: any) {
    const { id, decision } = e.currentTarget.dataset;
    const a = this.data.applications.find((x: JoinApplication) => x.id === id);
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
    if (!(await confirm(status === 'accepted' ? '接受建议' : '拒绝建议', status === 'accepted' ? '接受后请按建议手动修改对应资料或关系。' : '确定拒绝这条建议吗？'))) return;
    const result = await invoke({ action: 'suggestion.resolve', payload: { circleId: this.circleId, suggestionId: id, status } });
    if (!result.ok) return showApiError(result);
    toast('建议已处理'); this.loadData();
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
    if (member.role === 'member') actions.push({ text: '移出圈子', kind: 'remove' });
    if (!actions.length) return;
    wx.showActionSheet({ itemList: actions.map(a => a.text), success: (result: any) => this.performMemberAction(member, actions[result.tapIndex]?.kind) });
  },
  async performMemberAction(this: any, member: Member, kind?: string) {
    if (!kind) return;
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
    this.setData({ showAllAudit, auditRows: this.data.auditEvents.slice(0, showAllAudit ? 100 : 6).map((event: any) => {
      const target = this.data.people.find((p: Person) => p.id === event.targetId)?.name || this.data.members.find((m: Member) => m.id === event.targetId)?.name || (event.targetId === this.data.circle.id ? this.data.circle.name : '');
      const role = event.details?.role === 'admin' ? '设为管理员' : event.details?.role === 'member' ? '改为普通成员' : '';
      return { ...event, title: AUDIT_LABELS[event.type] || event.type, when: timeText(event.at), detail: [target, role].filter(Boolean).join(' · ') };
    }) });
  }
});
