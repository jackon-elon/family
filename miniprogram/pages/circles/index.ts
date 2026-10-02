import { Circle, JoinApplication, invoke, isDemoMode, resetDemoData, setDemoMode, showApiError } from '../../services/api';
import { confirm, dateText, go, q, toast } from '../../utils/navigation';

type ApplicationRow = JoinApplication & { circleName?: string; circleType?: string; statusText: string; date: string };

Page({
  data: { familyCircles: [] as Circle[], classCircles: [] as Circle[], applicationRows: [] as ApplicationRow[], allApplicationRows: [] as ApplicationRow[], showAllApplications: false, hasMoreApplications: false, applicationError: '', loadError: '', demoMode: true, loading: true },
  async onShow(this: any) {
    this.setData({ demoMode: isDemoMode(), loading: true, loadError: '' });
    const [result, mine] = await Promise.all([
      invoke<{ circles: Circle[] }>({ action: 'circle.list' }),
      invoke<{ applications: Array<JoinApplication & {circleName?: string; circleType?: string}>; hasMore?: boolean }>({ action: 'join.mine' })
    ]);
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
      allApplicationRows: applicationRows,
      applicationRows: this.data.showAllApplications ? applicationRows : applicationRows.slice(0, 5),
      hasMoreApplications: mine.ok && !!mine.data.hasMore,
      applicationError: mine.ok ? '' : '加入申请暂时无法加载，点此重试',
      loading: false
    });
  },
  onRetryApplications(this: any) { if (!this.data.loading) this.onShow(); },
  onToggleApplications(this: any) {
    const showAllApplications = !this.data.showAllApplications;
    this.setData({ showAllApplications, applicationRows: showAllApplications ? this.data.allApplicationRows : this.data.allApplicationRows.slice(0, 5) });
  },
  onOpenApplication(this: any, event: any) { go(`/pages/apply/index?applicationId=${q(event.currentTarget.dataset.id)}`); },
  onOpenCircle(this: any, event: any) {
    const id = event.currentTarget.dataset.id;
    try { wx.setStorageSync('kin-current-circle', id); } catch (_) { /* The URL still identifies this circle. */ }
    go(`/pages/circle/index?circleId=${q(id)}`);
  },
  onCreate() { go('/pages/create/index'); },
  async onReset(this: any) {
    if (!(await confirm('重置演示数据', '会清除你在演示模式中新增的圈子、人物和申请。确定重置吗？'))) return;
    if (!resetDemoData()) return toast('演示资料存储空间不足，重置失败');
    toast('演示数据已恢复');
    this.onShow();
  },
  async onSwitchMode(this: any) {
    if (this.data.demoMode) {
      if (!(await confirm('切换到云端', '请先配置真实小程序 AppID、云环境，并部署 api 云函数。现在尝试切换吗？'))) return;
      if (!setDemoMode(false)) { toast('切换失败，请检查云环境和本机存储'); return; }
    } else {
      if (!setDemoMode(true)) { toast('切换失败，请检查本机存储'); return; }
    }
    this.onShow();
  }
});
