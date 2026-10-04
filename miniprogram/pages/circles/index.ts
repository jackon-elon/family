import { Circle, JoinApplication, invoke, isDemoMode } from '../../services/api';
import { dateText, go, q } from '../../utils/navigation';
import { BirthdayEvent, BirthdayRow, birthdayRows } from '../events/model';

type ApplicationRow = JoinApplication & { circleName?: string; circleType?: string; statusText: string; date: string };

Page({
  data: { familyCircles: [] as Circle[], classCircles: [] as Circle[], applicationRows: [] as ApplicationRow[], allApplicationRows: [] as ApplicationRow[], birthdayPreview: [] as BirthdayRow[], birthdayError: '', showAllApplications: false, hasMoreApplications: false, applicationError: '', loadError: '', demoMode: true, loading: true },
  async onShow(this: any) {
    const loadVersion = (this.loadVersion || 0) + 1;
    this.loadVersion = loadVersion;
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null;
    if (tabBar) tabBar.setData({ selected: 0 });
    this.setData({ demoMode: isDemoMode(), loading: true, loadError: '' });
    // A previously verified phone can match a profile added since the last
    // visit; link it before listing circles so it appears on this launch.
    const synced = await invoke<{hasVerifiedPhone: boolean}>({action: 'account.sync'});
    if (this.loadVersion !== loadVersion) return;
    if (!synced.ok) {
      this.setData({familyCircles: [], classCircles: [], applicationRows: [], allApplicationRows: [], birthdayPreview: [], loadError: synced.error.message, loading: false});
      return;
    }
    if (!synced.data.hasVerifiedPhone) {
      wx.reLaunch({url: '/pages/login/index'});
      return;
    }
    const [result, mine, birthdays] = await Promise.all([
      invoke<{ circles: Circle[] }>({ action: 'circle.list' }),
      invoke<{ applications: Array<JoinApplication & {circleName?: string; circleType?: string}>; hasMore?: boolean }>({ action: 'join.mine' }),
      invoke<{ events: BirthdayEvent[] }>({ action: 'birthday.upcoming', payload: { days: 30 } })
    ]);
    if (this.loadVersion !== loadVersion) return;
    if (!result.ok) { this.setData({ familyCircles: [], classCircles: [], applicationRows: [], allApplicationRows: [], loadError: result.error.message, loading: false }); return; }
    const applicationRows: ApplicationRow[] = mine.ok ? mine.data.applications
      .slice().sort((a, b) => b.createdAt - a.createdAt)
      .map(application => ({
        ...application,
        date: dateText(application.createdAt),
        statusText: application.status === 'approved' ? application.canEnter === false ? '已退出或无访问权' : '已通过' : application.status === 'rejected' ? '未通过' : application.status === 'invalid' || application.status === 'expired' ? '已失效' : '审核中'
      })) : [];
    this.setData({
      familyCircles: result.data.circles.filter(c => c.type === 'family'),
      classCircles: result.data.circles.filter(c => c.type === 'classmate'),
      birthdayPreview: birthdays.ok ? birthdayRows(birthdays.data.events).slice(0, 3) : [],
      birthdayError: birthdays.ok ? '' : '生日暂时无法加载，点此重试',
      allApplicationRows: applicationRows,
      applicationRows: this.data.showAllApplications ? applicationRows : applicationRows.slice(0, 5),
      hasMoreApplications: mine.ok && !!mine.data.hasMore,
      applicationError: mine.ok ? '' : '加入申请暂时无法加载，点此重试',
      loading: false
    });
  },
  onUnload(this: any) { this.loadVersion = (this.loadVersion || 0) + 1; },
  onRetryApplications(this: any) { if (!this.data.loading) this.onShow(); },
  onRetryBirthdays(this: any) { if (!this.data.loading) this.onShow(); },
  onOpenEvents() { go('/pages/events/index'); },
  onOpenBirthday(this: any, event: any) {
    const row = this.data.birthdayPreview.find((item: BirthdayRow) => item.personId === event.currentTarget.dataset.personId && item.circleId === event.currentTarget.dataset.circleId);
    if (row) go(`/pages/person/index?circleId=${q(row.circleId)}&personId=${q(row.personId)}`);
  },
  onToggleApplications(this: any) {
    const showAllApplications = !this.data.showAllApplications;
    this.setData({ showAllApplications, applicationRows: showAllApplications ? this.data.allApplicationRows : this.data.allApplicationRows.slice(0, 5) });
  },
  onOpenApplication(this: any, event: any) { go(`/pages/apply/index?applicationId=${q(event.currentTarget.dataset.id)}`); },
  onCreate() { go('/pages/create/index'); },
  onOpenCircle(this: any, event: any) {
    const id = event.currentTarget.dataset.id;
    try { wx.setStorageSync('kin-current-circle', id); } catch (_) { /* The URL still identifies this circle. */ }
    go(`/pages/circle/index?circleId=${q(id)}`);
  },
});
