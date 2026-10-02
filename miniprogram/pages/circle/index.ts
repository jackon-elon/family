import { Circle, Person, Relation, invoke, resolvePhotoUrls, showApiError } from '../../services/api';
import { CityGroup, groupCities } from '../../utils/geography';
import { confirm, go, q, toast } from '../../utils/navigation';
import { relationshipFor } from '../../utils/relationship';

interface PersonRow extends Person { initial: string; relationLabel: string; relationPath: string; relationMissing?: string; detail: string; depth: number }

Page({
  data: {
    circle: null as Circle | null, circleId: '', role: 'member', isAdmin: false, tab: 'list',
    people: [] as Person[], relations: [] as Relation[], rows: [] as PersonRow[], graphRows: [] as PersonRow[], relationLabels: {} as Record<string, string>,
    selfId: '', selectedStarId: '', selectedStar: null as PersonRow | null,
    query: '', statusOptions: ['全部状态'], statusIndex: 0, industryOptions: ['全部行业'], industryIndex: 0,
    cityOptions: ['全部城市'], cityIndex: 0,
    mapScope: 'china', mapGroups: [] as CityGroup[], overseas: 0, unmapped: 0,
    selectedCity: '', selectedCityRows: [] as PersonRow[], filteredCount: 0, loading: true
  },
  onLoad(this: any, options: any) { this.circleId = options.circleId || wx.getStorageSync('kin-current-circle'); this.loadData(); },
  onShow(this: any) { if (this.circleId && !this.data.loading) this.loadData(); },
  onPullDownRefresh(this: any) { this.loadData().finally(() => wx.stopPullDownRefresh()); },
  async loadData(this: any) {
    if (!this.circleId) { toast('请先选择圈子'); return; }
    this.setData({ loading: true });
    const [detail, persons, relations] = await Promise.all([
      invoke<{ circle: Circle; role: string }>({ action: 'circle.detail', payload: { circleId: this.circleId } }),
      invoke<{ persons: Person[] }>({ action: 'person.list', payload: { circleId: this.circleId } }),
      invoke<{ relations: Relation[] }>({ action: 'relation.list', payload: { circleId: this.circleId } })
    ]);
    if (!detail.ok) { showApiError(detail); this.setData({ loading: false }); return; }
    if (!persons.ok) { showApiError(persons); this.setData({ loading: false }); return; }
    const circle = detail.data.circle;
    const list = await resolvePhotoUrls(this.circleId, persons.data.persons);
    const self = list.find(p => p.isSelf);
    const tab = circle.type === 'family' ? (this.data.circle?.id === circle.id ? this.data.tab : 'network') : (this.data.circle?.id === circle.id && this.data.tab !== 'network' ? this.data.tab : 'list');
    wx.setNavigationBarTitle({ title: circle.name });
    this.setData({ circle, circleId: circle.id, role: detail.data.role, isAdmin: detail.data.role === 'owner' || detail.data.role === 'admin', people: list, relations: relations.ok ? relations.data.relations : [], selfId: self ? self.id : '', tab, loading: false });
    this.rebuild();
  },
  rebuild(this: any) {
    const d = this.data;
    const query = d.query.trim().toLowerCase();
    const status = d.statusOptions[d.statusIndex];
    const industry = d.industryOptions[d.industryIndex];
    const city = d.cityOptions[d.cityIndex];
    const rows: PersonRow[] = d.people.map((person: Person) => {
      const rel = d.circle?.type === 'family' && d.selfId ? relationshipFor(d.people, d.relations, d.selfId, person.id) : null;
      const detail = [person.city, person.status, person.industry].filter(Boolean).join(' · ');
      return { ...person, initial: person.name ? person.name.slice(-1) : '人', relationLabel: rel ? rel.label : d.circle?.type === 'family' ? '关系待补充' : '同班同学', relationPath: rel ? rel.path : '', relationMissing: rel ? rel.missing : '', detail: detail || '资料待完善', depth: rel ? (rel.path.match(/→/g) || []).length : 0 };
    });
    const statusOptions = ['全部状态'].concat(Array.from(new Set(rows.map(r => r.status).filter(Boolean))) as string[]);
    const industryOptions = ['全部行业'].concat(Array.from(new Set(rows.map(r => r.industry).filter(Boolean))) as string[]);
    const cityOptions = ['全部城市'].concat(Array.from(new Set(rows.map(r => r.city).filter(Boolean))) as string[]);
    const statusIndex = status && statusOptions.indexOf(status) >= 0 ? statusOptions.indexOf(status) : 0;
    const industryIndex = industry && industryOptions.indexOf(industry) >= 0 ? industryOptions.indexOf(industry) : 0;
    const cityIndex = city && cityOptions.indexOf(city) >= 0 ? cityOptions.indexOf(city) : 0;
    const filtered = rows.filter(row => {
      if (query && ![row.name, row.nickname, row.city, row.relationLabel].filter(Boolean).join(' ').toLowerCase().includes(query)) return false;
      if (statusIndex && row.status !== statusOptions[statusIndex]) return false;
      if (industryIndex && row.industry !== industryOptions[industryIndex]) return false;
      if (cityIndex && row.city !== cityOptions[cityIndex]) return false;
      return true;
    });
    const selfRow = rows.find(r => r.id === d.selfId);
    const graphRows = d.circle?.type === 'family' ? (selfRow && !filtered.some(r => r.id === d.selfId) ? [selfRow, ...filtered] : filtered) : [];
    const relationLabels: Record<string, string> = {};
    rows.forEach(row => { relationLabels[row.id] = row.relationLabel; });
    const mapped = groupCities(filtered, d.mapScope);
    const chosen = mapped.groups.find(g => g.key === d.selectedCity);
    const selectedStar = rows.find(row => row.id === d.selectedStarId) || null;
    this.setData({ rows: filtered, graphRows, relationLabels, selectedStar, statusOptions, statusIndex, industryOptions, industryIndex, cityOptions, cityIndex, mapGroups: mapped.groups, overseas: mapped.overseas, unmapped: mapped.unmapped, selectedCityRows: chosen ? chosen.persons.map(p => filtered.find(r => r.id === p.id)!) : [], selectedCity: chosen ? chosen.key : '', filteredCount: filtered.length });
  },
  onTab(this: any, e: any) { this.setData({ tab: e.currentTarget.dataset.tab, selectedCity: '', selectedCityRows: [], selectedStarId: '', selectedStar: null }); this.rebuild(); },
  onSearch(this: any, e: any) { this.setData({ query: e.detail.value }); this.rebuild(); },
  onFilter(this: any, e: any) { this.setData({ [e.currentTarget.dataset.field]: Number(e.detail.value) }); this.rebuild(); },
  onScope(this: any, e: any) { this.setData({ mapScope: e.currentTarget.dataset.scope, selectedCity: '', selectedCityRows: [] }); this.rebuild(); },
  onCity(this: any, e: any) { this.setData({ selectedCity: e.currentTarget.dataset.key }); this.rebuild(); },
  onMapCity(this: any, e: any) { this.setData({ selectedCity: e.detail.key }); this.rebuild(); },
  clearCity(this: any) { this.setData({ selectedCity: '', selectedCityRows: [] }); },
  onStarSelect(this: any, e: any) { this.setData({ selectedStarId: e.detail.personId }); this.rebuild(); },
  onStarClear(this: any) { this.setData({ selectedStarId: '', selectedStar: null }); },
  onStarOpen(this: any) { if (this.data.selectedStar) go(`/pages/person/index?circleId=${q(this.circleId)}&personId=${q(this.data.selectedStar.id)}`); },
  onPerson(this: any, e: any) { go(`/pages/person/index?circleId=${q(this.circleId)}&personId=${q(e.currentTarget.dataset.id)}`); },
  onAddPerson(this: any) { go(`/pages/person-edit/index?circleId=${q(this.circleId)}`); },
  onAddMyself(this: any) { go(`/pages/person-edit/index?circleId=${q(this.circleId)}`); },
  onManage(this: any) { go(`/pages/manage/index?circleId=${q(this.circleId)}`); },
  onInvite(this: any) { go(`/pages/invite/index?circleId=${q(this.circleId)}`); },
  async onLeave(this: any) {
    if (this.data.role === 'owner') return toast('请先移交圈主，再退出圈子');
    if (!(await confirm('退出这个圈子', '退出后会立即失去访问权，本人私人资料会从圈内隐藏或删除；家庭关系节点会保留最少信息。重新加入需要管理员邀请和审核。'))) return;
    const result = await invoke({ action: 'member.leave', payload: { circleId: this.circleId } });
    if (!result.ok) return showApiError(result);
    wx.removeStorageSync('kin-current-circle');
    wx.reLaunch({ url: '/pages/circles/index' });
  }
});
