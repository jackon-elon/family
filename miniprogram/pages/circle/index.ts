import { Circle, Person, Relation, invoke, resolvePhotoUrls, showApiError } from '../../services/api';
import { CityGroup, groupCities } from '../../utils/geography';
import { go, q, toast } from '../../utils/navigation';
import { relationshipFor } from '../../utils/relationship';

interface PersonRow extends Person { initial: string; relationLabel: string; relationPath: string; relationMissing?: string; detail: string; depth: number }

Page({
  data: {
    circle: null as Circle | null, circleId: '', role: 'member', isAdmin: false, tab: 'list',
    people: [] as Person[], relations: [] as Relation[], rows: [] as PersonRow[], graphRows: [] as PersonRow[],
    selfId: '', perspectiveId: '', perspectiveName: '', perspectiveInitial: '我', perspectiveNames: [] as string[], perspectiveIndex: 0,
    query: '', statusOptions: ['全部状态'], statusIndex: 0, industryOptions: ['全部行业'], industryIndex: 0,
    cityOptions: ['全部城市'], cityIndex: 0, expanded: false,
    mapScope: 'china', mapGroups: [] as CityGroup[], overseas: 0, unmapped: 0,
    selectedCity: '', selectedCityRows: [] as PersonRow[], filteredCount: 0, loading: true
  },
  onLoad(this: any, options: any) { this.circleId = options.circleId || wx.getStorageSync('kin-current-circle'); this.requestedPerspectiveId = options.perspectiveId || ''; this.loadData(); },
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
    const requestedPerspective = this.requestedPerspectiveId && list.some(p => p.id === this.requestedPerspectiveId) ? this.requestedPerspectiveId : '';
    const existingPerspective = requestedPerspective || (list.some(p => p.id === this.data.perspectiveId) ? this.data.perspectiveId : '');
    this.requestedPerspectiveId = '';
    const perspectiveId = existingPerspective || (self && self.id) || (list[0] && list[0].id) || '';
    const tab = circle.type === 'family' ? (this.data.circle?.id === circle.id ? this.data.tab : 'network') : (this.data.circle?.id === circle.id && this.data.tab !== 'network' ? this.data.tab : 'list');
    wx.setNavigationBarTitle({ title: circle.name });
    this.setData({ circle, circleId: circle.id, role: detail.data.role, isAdmin: detail.data.role === 'owner' || detail.data.role === 'admin', people: list, relations: relations.ok ? relations.data.relations : [], selfId: self ? self.id : '', perspectiveId, perspectiveName: list.find(p => p.id === perspectiveId)?.name || '', perspectiveInitial: list.find(p => p.id === perspectiveId)?.name?.slice(-1) || '我', perspectiveNames: list.map(p => p.name), perspectiveIndex: Math.max(0, list.findIndex(p => p.id === perspectiveId)), tab, loading: false });
    this.rebuild();
  },
  rebuild(this: any) {
    const d = this.data;
    const query = d.query.trim().toLowerCase();
    const status = d.statusOptions[d.statusIndex];
    const industry = d.industryOptions[d.industryIndex];
    const city = d.cityOptions[d.cityIndex];
    const rows: PersonRow[] = d.people.map((person: Person) => {
      const rel = d.circle?.type === 'family' && d.perspectiveId ? relationshipFor(d.people, d.relations, d.perspectiveId, person.id) : null;
      const detail = [person.city, person.status, person.industry].filter(Boolean).join(' · ');
      return { ...person, initial: person.name ? person.name.slice(-1) : '人', relationLabel: rel ? rel.label : '同班同学', relationPath: rel ? rel.path : '', relationMissing: rel ? rel.missing : '', detail: detail || '资料待完善', depth: rel ? (rel.path.match(/→/g) || []).length : 0 };
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
    const graphRows = filtered.filter(r => r.id !== d.perspectiveId && (d.expanded || query || r.depth <= 2)).sort((a, b) => (a.depth || 99) - (b.depth || 99));
    const mapped = groupCities(filtered, d.mapScope);
    const chosen = mapped.groups.find(g => g.key === d.selectedCity);
    this.setData({ rows: filtered, graphRows, statusOptions, statusIndex, industryOptions, industryIndex, cityOptions, cityIndex, mapGroups: mapped.groups, overseas: mapped.overseas, unmapped: mapped.unmapped, selectedCityRows: chosen ? chosen.persons.map(p => filtered.find(r => r.id === p.id)!) : [], selectedCity: chosen ? chosen.key : '', filteredCount: filtered.length });
  },
  onTab(this: any, e: any) { this.setData({ tab: e.currentTarget.dataset.tab, selectedCity: '', selectedCityRows: [] }); this.rebuild(); },
  onSearch(this: any, e: any) { this.setData({ query: e.detail.value }); this.rebuild(); },
  onFilter(this: any, e: any) { this.setData({ [e.currentTarget.dataset.field]: Number(e.detail.value) }); this.rebuild(); },
  onScope(this: any, e: any) { this.setData({ mapScope: e.currentTarget.dataset.scope, selectedCity: '', selectedCityRows: [] }); this.rebuild(); },
  onCity(this: any, e: any) { this.setData({ selectedCity: e.currentTarget.dataset.key }); this.rebuild(); },
  clearCity(this: any) { this.setData({ selectedCity: '', selectedCityRows: [] }); },
  onPerspective(this: any, e: any) {
    const index = Number(e.detail.value);
    const person = this.data.people[index];
    if (!person) return;
    this.setData({ perspectiveIndex: index, perspectiveId: person.id, perspectiveName: person.name, perspectiveInitial: person.name?.slice(-1) || '人' });
    this.rebuild();
  },
  onMyView(this: any) {
    if (!this.data.selfId) return toast('认领本人卡后就能一键回到我的视角');
    const index = this.data.people.findIndex((p: Person) => p.id === this.data.selfId);
    this.setData({ perspectiveId: this.data.selfId, perspectiveIndex: index, perspectiveName: this.data.people[index]?.name || '', perspectiveInitial: this.data.people[index]?.name?.slice(-1) || '我' });
    this.rebuild();
  },
  onExpand(this: any) { this.setData({ expanded: !this.data.expanded }); this.rebuild(); },
  onPerson(this: any, e: any) { go(`/pages/person/index?circleId=${q(this.circleId)}&personId=${q(e.currentTarget.dataset.id)}&perspectiveId=${q(this.data.perspectiveId)}`); },
  onAddPerson(this: any) { go(`/pages/person-edit/index?circleId=${q(this.circleId)}`); },
  onAddMyself(this: any) { go(`/pages/person-edit/index?circleId=${q(this.circleId)}`); },
  onManage(this: any) { go(`/pages/manage/index?circleId=${q(this.circleId)}`); },
  onInvite(this: any) { go(`/pages/invite/index?circleId=${q(this.circleId)}`); }
});
