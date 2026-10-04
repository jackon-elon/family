import { Circle, ClaimRequest, Member, OwnerTransfer, Person, Relation, invoke, resolvePhotoUrls, showApiError } from '../../services/api';
import { CityGroup, groupCities } from '../../utils/geography';
import { confirm, go, q, toast } from '../../utils/navigation';
import { relationshipFor } from '../../utils/relationship';

interface PersonRow extends Person { displayName: string; originalName: string; hasRemark: boolean; initial: string; relationLabel: string; relationPath: string; relationMissing?: string; relationStatus: string; detail: string; depth: number; isDimmed?: boolean; mapReason?: string }
interface ClaimCandidate extends Person { initial: string }

Page({
  data: {
    circle: null as Circle | null, circleId: '', role: 'member', isAdmin: false, ownerTransfer: null as OwnerTransfer | null, transferBusy: false, tab: 'list',
    people: [] as Person[], relations: [] as Relation[], rows: [] as PersonRow[], graphRows: [] as PersonRow[], mapRows: [] as PersonRow[], relationLabels: {} as Record<string, string>,
    remarks: {} as Record<string, string>, remarkError: '', remarkLoading: false,
    selfId: '', myName: '', unclaimedPeople: [] as Person[], claimCandidates: [] as ClaimCandidate[], claimQuery: '', showAllCandidates: false, showManualMatch: false,
    pendingClaim: null as ClaimRequest | null, pendingClaimName: '', lastRejectedClaim: null as ClaimRequest | null, claimBusy: '',
    selectedStarId: '', selectedStar: null as PersonRow | null, starCardPlacement: 'bottom',
    query: '', statusOptions: ['全部状态'], statusIndex: 0, industryOptions: ['全部行业'], industryIndex: 0,
    cityOptions: ['全部城市'], cityIndex: 0,
    mapScope: 'china', mapGroups: [] as CityGroup[], unmappedRows: [] as PersonRow[], overseas: 0, unmapped: 0, missingCity: 0, incompleteProfiles: 0, mappedPeople: 0,
    selectedCity: '', selectedCityRows: [] as PersonRow[], filteredCount: 0, loading: true, loadError: ''
  },
  onLoad(this: any, options: any) { let remembered = ''; try { remembered = wx.getStorageSync('kin-current-circle'); } catch (_) {} this.circleId = options.circleId || remembered; this.setData({showManualMatch: options.match === '1'}); this.loadData(); },
  onShow(this: any) { if (this.circleId && !this.data.loading) this.loadData(); },
  onHide(this: any) { this.starSelectionVersion = (this.starSelectionVersion || 0) + 1; if (!this.data.loading) this.photoLoadVersion = (this.photoLoadVersion || 0) + 1; },
  onUnload(this: any) { this.starSelectionVersion = (this.starSelectionVersion || 0) + 1; this.photoLoadVersion = (this.photoLoadVersion || 0) + 1; },
  onPullDownRefresh(this: any) { this.loadData().finally(() => wx.stopPullDownRefresh()); },
  async loadData(this: any) {
    if (!this.circleId) { this.setData({ loadError: '请返回亲友录重新选择', loading: false }); return; }
    const photoLoadVersion = (this.photoLoadVersion || 0) + 1;
    this.photoLoadVersion = photoLoadVersion;
    // A remark belongs to the signed-in viewer. Clear it before switching or
    // refreshing sessions so an unavailable request cannot reuse another view.
    this.starSelectionVersion = (this.starSelectionVersion || 0) + 1;
    this.setData({ loading: true, loadError: '', remarks: {}, remarkError: '', remarkLoading: true, selectedStarId: '', selectedStar: null });
    const session = await invoke<{hasVerifiedPhone: boolean}>({action: 'account.sync'});
    if (this.photoLoadVersion !== photoLoadVersion) return;
    if (!session.ok) { this.setData({loading: false, loadError: session.error.message}); return; }
    if (!session.data.hasVerifiedPhone) { wx.reLaunch({url: `/pages/login/index?next=${q(`/pages/circle/index?circleId=${q(this.circleId)}`)}`}); return; }
    const remarkRequest = invoke<{ remarks: Record<string, string> }>({ action: 'person.remark.list', payload: {circleId: this.circleId} });
    // Personal labels load independently; the family chart remains available
    // when only the remark endpoint fails or is slow.
    void remarkRequest.then(result => {
      if (this.photoLoadVersion !== photoLoadVersion) return;
      this.setData({ remarks: result.ok ? result.data.remarks : {}, remarkError: result.ok ? '' : '备注暂未加载，先显示原名', remarkLoading: false });
      if (!this.data.loading) this.rebuild();
    });
    const [detail, persons, relations, members, claims] = await Promise.all([
      invoke<{ circle: Circle; role: string; ownerTransfer?: OwnerTransfer | null }>({ action: 'circle.detail', payload: { circleId: this.circleId } }),
      invoke<{ persons: Person[] }>({ action: 'person.list', payload: { circleId: this.circleId } }),
      invoke<{ relations: Relation[] }>({ action: 'relation.list', payload: { circleId: this.circleId } }),
      invoke<{ members: Member[] }>({ action: 'member.list', payload: { circleId: this.circleId } }),
      invoke<{ claimRequests: ClaimRequest[] }>({ action: 'person.claimMine', payload: { circleId: this.circleId } })
    ]);
    if (this.photoLoadVersion !== photoLoadVersion) return;
    if (!detail.ok || !persons.ok || !relations.ok || !members.ok || !claims.ok) {
      const failed = [detail, persons, relations, members, claims].find(result => !result.ok);
      this.setData({ loadError: failed && !failed.ok ? failed.error.message : '加载失败，请重试', loading: false }); return;
    }
    const circle = detail.data.circle;
    const list = await resolvePhotoUrls(this.circleId, persons.data.persons, (updated, checkOnly) => {
      if (this.photoLoadVersion !== photoLoadVersion) return false;
      if (checkOnly) return true;
      const photos = new Map(updated.filter(person => person.photoUrl).map(person => [person.id, person.photoUrl]));
      this.setData({ people: this.data.people.map((person: Person) => photos.has(person.id) ? { ...person, photoUrl: photos.get(person.id) } : person) });
      this.rebuild();
      return true;
    });
    if (this.photoLoadVersion !== photoLoadVersion) return;
    const self = list.find(p => p.isSelf);
    const ownMember = members.data.members.find(m => m.isSelf);
    const ownClaims = claims.data.claimRequests;
    const pendingClaim = ownClaims.find(request => request.status === 'pending') || null;
    const lastRejectedClaim = ownClaims.slice().sort((a, b) => b.createdAt - a.createdAt).find(request => request.status === 'rejected') || null;
    const unclaimedPeople = list.filter(p => !p.isClaimed && !p.isSelf);
    const pendingClaimName = pendingClaim ? (list.find(p => p.id === pendingClaim.personId)?.name || '这份资料') : '';
    const tab = circle.type === 'family' ? (this.data.circle?.id === circle.id ? this.data.tab : 'network') : (this.data.circle?.id === circle.id && this.data.tab !== 'network' ? this.data.tab : 'list');
    wx.setNavigationBarTitle({ title: circle.name });
    this.setData({ circle, circleId: circle.id, role: detail.data.role, isAdmin: detail.data.role === 'owner' || detail.data.role === 'admin', ownerTransfer: detail.data.ownerTransfer || null, people: list, relations: relations.data.relations, selfId: self ? self.id : '', myName: ownMember?.name || '', unclaimedPeople, pendingClaim, pendingClaimName, lastRejectedClaim, tab, loading: false });
    this.rebuild();
    this.rebuildClaimCandidates();
  },
  onRetry(this: any) { if (!this.data.loading) return this.loadData(); },
  onHome() { wx.reLaunch({ url: '/pages/circles/index' }); },
  onGoMy() { wx.switchTab({url: '/pages/my/index'}); },
  onToggleManualMatch(this: any) { this.setData({showManualMatch: !this.data.showManualMatch}); },
  rebuildClaimCandidates(this: any) {
    const query = this.data.claimQuery.trim().toLowerCase();
    const ownName = this.data.myName.trim().toLowerCase();
    const matches = this.data.unclaimedPeople.filter((person: Person) => !query || [person.name, person.nickname].filter(Boolean).join(' ').toLowerCase().includes(query));
    matches.sort((a: Person, b: Person) => Number(b.name.toLowerCase() === ownName) - Number(a.name.toLowerCase() === ownName) || a.name.localeCompare(b.name, 'zh-CN'));
    const visible = this.data.showAllCandidates || query ? matches : matches.slice(0, 5);
    this.setData({ claimCandidates: visible.map((person: Person) => ({ ...person, initial: person.name ? person.name.slice(-1) : '人' })) });
  },
  onClaimSearch(this: any, event: any) { this.setData({ claimQuery: event.detail.value }); this.rebuildClaimCandidates(); },
  onShowAllCandidates(this: any) { this.setData({ showAllCandidates: true }); this.rebuildClaimCandidates(); },
  async onClaimPerson(this: any, event: any) {
    if (this.data.selfId || this.data.pendingClaim || this.data.claimBusy) return;
    const person = this.data.unclaimedPeople.find((p: Person) => p.id === event.currentTarget.dataset.id);
    if (!person) return toast('暂时找不到这位家人或同学，请刷新重试');
    this.setData({ claimBusy: person.id });
    const result = await invoke<{ claimRequest: ClaimRequest }>({ action: 'person.claim', payload: { circleId: this.circleId, personId: person.id } });
    this.setData({ claimBusy: '' });
    if (!result.ok) return showApiError(result);
    this.setData({ pendingClaim: result.data.claimRequest, pendingClaimName: person.name });
    toast('已提交，等待管理员确认');
    await this.loadData();
  },
  rebuild(this: any, onRendered?: () => void) {
    const d = this.data;
    const query = d.query.trim().toLowerCase();
    const status = d.statusOptions[d.statusIndex];
    const industry = d.industryOptions[d.industryIndex];
    const city = d.cityOptions[d.cityIndex];
    const rows: PersonRow[] = d.people.map((person: Person) => {
      const rel = d.circle?.type === 'family' && d.selfId ? relationshipFor(d.people, d.relations, d.selfId, person.id) : null;
      const detail = [person.city, person.status, person.industry].filter(Boolean).join(' · ');
      const remark = typeof d.remarks?.[person.id] === 'string' ? d.remarks[person.id].trim() : '';
      const displayName = remark || person.name;
      return { ...person, displayName, originalName: person.name, hasRemark: Boolean(remark && remark !== person.name), initial: displayName ? displayName.slice(-1) : '人', relationLabel: rel ? rel.label : d.circle?.type === 'family' ? '关系待补充' : '同班同学', relationPath: rel ? rel.path : '', relationMissing: rel ? rel.missing : '', relationStatus: rel?.status || 'unrelated', detail: detail || '资料待完善', depth: rel ? (rel.path.match(/→/g) || []).length : 0 };
    });
    const statusOptions = ['全部状态'].concat(Array.from(new Set(rows.map(r => r.status).filter(Boolean))) as string[]);
    const industryOptions = ['全部行业'].concat(Array.from(new Set(rows.map(r => r.industry).filter(Boolean))) as string[]);
    const cityOptions = ['全部城市'].concat(Array.from(new Set(rows.map(r => r.city).filter(Boolean))) as string[]);
    const statusIndex = status && statusOptions.indexOf(status) >= 0 ? statusOptions.indexOf(status) : 0;
    const industryIndex = industry && industryOptions.indexOf(industry) >= 0 ? industryOptions.indexOf(industry) : 0;
    const cityIndex = city && cityOptions.indexOf(city) >= 0 ? cityOptions.indexOf(city) : 0;
    const filtered = rows.filter(row => {
      if (query && ![row.displayName, row.originalName, row.nickname, row.city, row.relationLabel].filter(Boolean).join(' ').toLowerCase().includes(query)) return false;
      if (statusIndex && row.status !== statusOptions[statusIndex]) return false;
      if (industryIndex && row.industry !== industryOptions[industryIndex]) return false;
      if (cityIndex && row.city !== cityOptions[cityIndex]) return false;
      return true;
    });
    // Keep the full relation chain while searching; removing an intermediate
    // parent would make the next generation appear disconnected or misaligned.
    const matchingIds = new Set(filtered.map(row => row.id));
    const graphRows = d.circle?.type === 'family'
      ? rows.map(row => ({ ...row, name: row.displayName, isDimmed: Boolean(query) && !matchingIds.has(row.id) }))
      : [];
    const relationLabels: Record<string, string> = {};
    rows.forEach(row => { relationLabels[row.id] = row.relationLabel; });
    const mapped = groupCities(filtered, d.mapScope);
    const mappedIds = new Set<string>();
    mapped.groups.forEach(group => group.persons.forEach(person => mappedIds.add(person.id)));
    const unmappedRows = filtered.filter(row => !mappedIds.has(row.id)).map(row => ({
      ...row,
      mapReason: row.profileComplete === false ? '资料待补齐' : !row.city?.trim() ? '未填城市' : d.mapScope === 'china' && row.country && row.country !== '中国' ? '海外 · 切换世界查看' : '城市待定位'
    }));
    const chosen = mapped.groups.find(g => g.key === d.selectedCity);
    const selectedStar = rows.find(row => row.id === d.selectedStarId) || null;
    this.setData({ rows: filtered, graphRows, mapRows: filtered.map(row => ({...row, name: row.displayName})), relationLabels, selectedStar, statusOptions, statusIndex, industryOptions, industryIndex, cityOptions, cityIndex, mapGroups: mapped.groups, unmappedRows, overseas: mapped.overseas, unmapped: mapped.unmapped, missingCity: mapped.missingCity, incompleteProfiles: mapped.incomplete, mappedPeople: mapped.mappedPeople, selectedCityRows: chosen ? chosen.persons.map(p => filtered.find(r => r.id === p.id)!) : [], selectedCity: chosen ? chosen.key : '', filteredCount: filtered.length }, onRendered);
  },
  onTab(this: any, e: any) { this.setData({ tab: e.currentTarget.dataset.tab, selectedCity: '', selectedCityRows: [], selectedStarId: '', selectedStar: null }); this.rebuild(); },
  onSearch(this: any, e: any) { this.setData({ query: e.detail.value }); this.rebuild(); },
  onFilter(this: any, e: any) { this.setData({ [e.currentTarget.dataset.field]: Number(e.detail.value) }); this.rebuild(); },
  onScope(this: any, e: any) { this.setData({ mapScope: e.currentTarget.dataset.scope, selectedCity: '', selectedCityRows: [] }); this.rebuild(); },
  onCity(this: any, e: any) { this.setData({ selectedCity: e.currentTarget.dataset.key }); this.rebuild(); },
  onMapCity(this: any, e: any) { this.setData({ selectedCity: e.detail.key }); this.rebuild(); },
  clearCity(this: any) { this.setData({ selectedCity: '', selectedCityRows: [] }); },
  async onStarSelect(this: any, e: any) {
    const personId = e.detail.personId;
    if (!this.data.people.some((item: Person) => item.id === personId)) return;
    if (this.data.selectedStarId === personId) { this.onStarClear(); return; }
    const selectionVersion = (this.starSelectionVersion || 0) + 1;
    this.starSelectionVersion = selectionVersion;
    let windowHeight = 667;
    try { windowHeight = wx.getSystemInfoSync().windowHeight || windowHeight; } catch (_) {}
    const clientY = e.detail.clientY;
    this.setData({ selectedStarId: personId, starCardPlacement: typeof clientY === 'number' && clientY > windowHeight * .5 ? 'top' : 'bottom' });
    // The compact floating card appears at the opposite end of the screen.
    // Leave the selected node tappable, and never move the page or graph.
    this.rebuild();
    const person = this.data.people.find((item: Person) => item.id === personId);
    if (!person?.hasPhoto || person.photoUrl) return;
    const photo = await invoke<{ url: string }>({ action: 'photo.url', payload: { circleId: this.circleId, personId } });
    if (!photo.ok || !photo.data.url || this.starSelectionVersion !== selectionVersion || this.data.selectedStarId !== personId) return;
    const people = this.data.people.map((item: Person) => item.id === personId ? { ...item, photoUrl: photo.data.url } : item);
    this.setData({ people });
    this.rebuild();
  },
  onStarClear(this: any) { this.starSelectionVersion = (this.starSelectionVersion || 0) + 1; this.setData({ selectedStarId: '', selectedStar: null }); },
  onStarCardTap() {},
  onStarOpen(this: any) { if (this.data.selectedStar) go(`/pages/person/index?circleId=${q(this.circleId)}&personId=${q(this.data.selectedStar.id)}`); },
  onPerson(this: any, e: any) { go(`/pages/person/index?circleId=${q(this.circleId)}&personId=${q(e.currentTarget.dataset.id)}`); },
  onAddMyself(this: any) { go(`/pages/person-edit/index?circleId=${q(this.circleId)}&purpose=self`); },
  async onLeave(this: any) {
    if (this.data.role === 'owner' || this.data.leaving) return;
    const title = this.data.circle?.type === 'family' ? '退出家人录' : '退出同窗录';
    this.setData({leaving: true});
    if (!(await confirm(title, `退出后将无法查看；你在这里的照片、联系方式等资料会清除，姓名${this.data.circle?.type === 'family' ? '和亲属关系' : ''}保留。`))) { this.setData({leaving: false}); return; }
    const result = await invoke({action: 'member.leave', payload: {circleId: this.circleId}});
    this.setData({leaving: false});
    if (!result.ok) return showApiError(result);
    toast('已退出');
    wx.switchTab({url: '/pages/circles/index'});
  },
  async onOwnerTransfer(this: any, event: any) {
    const transfer = this.data.ownerTransfer as OwnerTransfer | null;
    const accept = event.currentTarget.dataset.decision === 'accept';
    if (!transfer?.isTarget || this.data.transferBusy) return;
    this.setData({transferBusy: true});
    if (accept && !(await confirm('接任创建者', '接受后由你设置管理员，原创建者仍是管理员。确定接任吗？'))) { this.setData({transferBusy: false}); return; }
    const result = await invoke({action: accept ? 'circle.acceptOwnerTransfer' : 'circle.cancelOwnerTransfer', payload: {circleId: this.circleId, transferId: transfer.id}});
    this.setData({transferBusy: false});
    if (!result.ok) return showApiError(result);
    toast(accept ? '你已成为创建者' : '已谢绝接任');
    this.loadData();
  }
});
