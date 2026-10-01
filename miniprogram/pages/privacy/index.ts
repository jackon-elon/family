import { Delegation, Member, Person, Visibility, invoke, showApiError } from '../../services/api';
import { confirm, toast } from '../../utils/navigation';

const FIELDS = [
  { key: 'photoFileId', label: '照片', description: '在人物卡、列表和城市卡片展示' },
  { key: 'city', label: '所在城市', description: '开启后会出现在地图城市人数中' },
  { key: 'school', label: '学校', description: '向本圈成员展示学校信息' },
  { key: 'industry', label: '行业', description: '向本圈成员展示行业' },
  { key: 'occupation', label: '职业', description: '向本圈成员展示职业' },
  { key: 'status', label: '目前状态', description: '向本圈成员展示在读、工作等状态' },
  { key: 'bio', label: '近况', description: '向本圈成员展示自我介绍' },
  { key: 'phone', label: '手机号', description: '默认仅自己可见，开启后可供圈内联系' },
  { key: 'wechatId', label: '微信号', description: '默认仅自己可见，开启后可供圈内联系' }
];
const DELEGABLE = [
  { value: 'city', label: '城市' }, { value: 'school', label: '学校' }, { value: 'industry', label: '行业' },
  { value: 'occupation', label: '职业' }, { value: 'status', label: '状态' }, { value: 'bio', label: '近况' },
  { value: 'phone', label: '手机号' }, { value: 'wechatId', label: '微信号' }, { value: 'photoFileId', label: '照片' }
];

Page({
  data: { person: null as Person | null, initial: '人', settings: [] as any[], visibility: {} as Record<string, Visibility>, admins: [] as Member[], adminNames: [] as string[], adminIndex: 0, delegationFields: [] as string[], delegable: DELEGABLE, delegations: [] as any[], saving: false },
  onLoad(this: any, options: any) { this.circleId = options.circleId; this.personId = options.personId; this.loadData(); },
  onShow(this: any) { if (this.personId) this.loadData(); },
  async loadData(this: any) {
    const [person, members, people] = await Promise.all([
      invoke<{ person: Person }>({ action: 'person.get', payload: { circleId: this.circleId, personId: this.personId } }),
      invoke<{ members: Member[] }>({ action: 'member.list', payload: { circleId: this.circleId } }),
      invoke<{ persons: Person[] }>({ action: 'person.list', payload: { circleId: this.circleId } })
    ]);
    if (!person.ok) return showApiError(person);
    if (!person.data.person.isSelf) { toast('只能设置本人资料的可见范围'); wx.navigateBack(); return; }
    const visibility = person.data.person.visibility || {};
    const allPeople = people.ok ? people.data.persons : [];
    const admins = members.ok ? members.data.members.filter(m => (m.role === 'owner' || m.role === 'admin') && m.personId !== this.personId && !m.isSelf).map(m => ({ ...m, name: allPeople.find(p => p.id === m.personId)?.name || m.name || '未认领管理员' })) : [];
    const delegations = (person.data.person.delegations || []).filter(d => d.active !== false && !d.revokedAt).map(d => ({ ...d, adminName: admins.find(a => a.id === d.adminMemberId)?.name || '管理员', fieldNames: d.fields.map(f => DELEGABLE.find(x => x.value === f)?.label || f).join('、') }));
    this.setData({ person: person.data.person, initial: person.data.person.name?.slice(-1) || '人', visibility, settings: FIELDS.map(f => ({ ...f, shared: visibility[f.key] === 'circle' })), admins, adminNames: admins.map(a => a.name), delegations });
  },
  onToggle(this: any, e: any) {
    const key = e.currentTarget.dataset.key;
    const visibility = { ...this.data.visibility, [key]: e.detail.value ? 'circle' : 'self' };
    this.setData({ visibility, settings: FIELDS.map(f => ({ ...f, shared: visibility[f.key] === 'circle' })) });
  },
  async onSave(this: any) {
    this.setData({ saving: true });
    const result = await invoke({ action: 'person.update', payload: { circleId: this.circleId, personId: this.personId, patch: {}, visibility: this.data.visibility } });
    this.setData({ saving: false });
    if (!result.ok) return showApiError(result);
    toast('可见范围已更新');
  },
  onAdmin(this: any, e: any) { this.setData({ adminIndex: Number(e.detail.value) }); },
  onDelegable(this: any, e: any) { this.setData({ delegationFields: e.detail.value }); },
  async onGrant(this: any) {
    const admin = this.data.admins[this.data.adminIndex];
    if (!admin) return toast('圈内还没有可授权的其他管理员');
    if (!this.data.delegationFields.length) return toast('请选择允许代维护的字段');
    if (!(await confirm('授权代维护', `允许「${admin.name}」长期代你更新所选资料？你可以随时撤销，管理员不能更改可见范围。`))) return;
    const result = await invoke({ action: 'delegation.grant', payload: { circleId: this.circleId, personId: this.personId, adminMemberId: admin.id, fields: this.data.delegationFields } });
    if (!result.ok) return showApiError(result);
    toast('授权已生效'); this.loadData();
  },
  async onRevoke(this: any, e: any) {
    if (!(await confirm('撤销代维护', '撤销后该管理员将无法再替你更新资料。确定吗？'))) return;
    const result = await invoke({ action: 'delegation.revoke', payload: { circleId: this.circleId, delegationId: e.currentTarget.dataset.id } });
    if (!result.ok) return showApiError(result);
    toast('授权已撤销'); this.loadData();
  }
});
