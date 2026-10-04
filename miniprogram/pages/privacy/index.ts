import { Member, Person, invoke, showApiError } from '../../services/api';
import { confirm, toast } from '../../utils/navigation';

const DELEGABLE = [
  { value: 'city', label: '城市' }, { value: 'birthday', label: '生日' }, { value: 'school', label: '学校' }, { value: 'industry', label: '行业' },
  { value: 'occupation', label: '职业' }, { value: 'status', label: '状态' }, { value: 'bio', label: '近况' },
  { value: 'phone', label: '手机号' }, { value: 'wechatId', label: '微信号' }, { value: 'photoFileId', label: '照片' }
];

Page({
  data: { person: null as Person | null, initial: '人', admins: [] as Member[], adminNames: [] as string[], adminIndex: 0, delegationFields: [] as string[], delegable: DELEGABLE, delegations: [] as any[], saving: false, loading: true, loadError: '' },
  onLoad(this: any, options: any) { this.circleId = options.circleId; this.personId = options.personId; this.loadData(); },
  onShow(this: any) { if (this.personId && !this.data.loading) this.loadData(); },
  async loadData(this: any) {
    if (!this.circleId || !this.personId) { this.setData({ loading: false, loadError: '未找到你的资料，请从记录重新进入' }); return; }
    const loadVersion = (this.loadVersion || 0) + 1;
    this.loadVersion = loadVersion;
    this.setData({ loading: true, loadError: '' });
    let results;
    try { results = await Promise.all([
      invoke<{ person: Person }>({ action: 'person.get', payload: { circleId: this.circleId, personId: this.personId } }),
      invoke<{ members: Member[] }>({ action: 'member.list', payload: { circleId: this.circleId } }),
      invoke<{ persons: Person[] }>({ action: 'person.list', payload: { circleId: this.circleId } })
    ]); }
    catch (_) { if (this.loadVersion === loadVersion) this.setData({ loading: false, loadError: '资料暂时无法加载，请重试' }); return; }
    if (this.loadVersion !== loadVersion) return;
    const [person, members, people] = results;
    const failed = results.find(result => !result.ok);
    if (failed && !failed.ok) { this.setData({ loading: false, loadError: failed.error.message }); return; }
    if (!person.data.person.isSelf) { this.setData({ loading: false, loadError: '只能授权代维护本人的资料' }); return; }
    const allPeople = people.data.persons;
    const admins = members.data.members.filter(m => (m.role === 'owner' || m.role === 'admin') && m.personId !== this.personId && !m.isSelf).map(m => ({ ...m, name: allPeople.find(p => p.id === m.personId)?.name || m.name || '管理员' }));
    const delegations = (person.data.person.delegations || []).filter(d => d.active !== false && !d.revokedAt).map(d => ({ ...d, adminName: admins.find(a => a.id === d.adminMemberId)?.name || '管理员', fieldNames: d.fields.map(f => DELEGABLE.find(x => x.value === f)?.label || f).join('、') }));
    this.setData({ person: person.data.person, initial: person.data.person.name?.slice(-1) || '人', admins, adminNames: admins.map(a => a.name), delegations, loading: false, loadError: '' });
  },
  onRetry(this: any) { if (!this.data.loading) return this.loadData(); },
  onHome() { wx.reLaunch({ url: '/pages/circles/index' }); },
  onAdmin(this: any, e: any) { this.setData({ adminIndex: Number(e.detail.value) }); },
  onDelegable(this: any, e: any) { this.setData({ delegationFields: e.detail.value }); },
  async onGrant(this: any) {
    if (this.data.saving || this.data.loading || this.data.loadError) return;
    const admin = this.data.admins[this.data.adminIndex];
    if (!admin) return toast('记录内还没有可授权的其他管理员');
    if (!this.data.delegationFields.length) return toast('请选择允许代维护的字段');
    if (!(await confirm('授权代维护', `允许「${admin.name}」长期代你更新所选资料？你可以随时撤销。`))) return;
    if (this.data.saving) return;
    this.setData({ saving: true });
    const result = await invoke({ action: 'delegation.grant', payload: { circleId: this.circleId, personId: this.personId, adminMemberId: admin.id, fields: this.data.delegationFields } });
    this.setData({ saving: false });
    if (!result.ok) return showApiError(result);
    toast('授权已生效'); this.loadData();
  },
  async onRevoke(this: any, e: any) {
    if (this.data.saving || this.data.loading || this.data.loadError) return;
    if (!(await confirm('撤销代维护', '撤销后该管理员将无法再替你更新资料。确定吗？'))) return;
    if (this.data.saving) return;
    this.setData({ saving: true });
    const result = await invoke({ action: 'delegation.revoke', payload: { circleId: this.circleId, delegationId: e.currentTarget.dataset.id } });
    this.setData({ saving: false });
    if (!result.ok) return showApiError(result);
    toast('授权已撤销'); this.loadData();
  }
});
