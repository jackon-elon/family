import { Circle, JoinApplication, invoke, isDemoMode, resetDemoData, setDemoMode, showApiError } from '../../services/api';
import { confirm, dateText, go, q, toast } from '../../utils/navigation';

type ApplicationRow = JoinApplication & { circleName?: string; circleType?: string; statusText: string; date: string };

Page({
  data: { familyCircles: [] as Circle[], classCircles: [] as Circle[], applicationRows: [] as ApplicationRow[], applicationError: '', demoMode: true, loading: true },
  async onShow(this: any) {
    this.setData({ demoMode: isDemoMode(), loading: true });
    const [result, mine] = await Promise.all([
      invoke<{ circles: Circle[] }>({ action: 'circle.list' }),
      invoke<{ applications: Array<JoinApplication & {circleName?: string; circleType?: string}> }>({ action: 'join.mine' })
    ]);
    if (!result.ok) { showApiError(result); this.setData({ loading: false }); return; }
    const applicationRows: ApplicationRow[] = mine.ok ? mine.data.applications
      .slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5)
      .map(application => ({
        ...application,
        date: dateText(application.createdAt),
        statusText: application.status === 'approved' ? '已通过' : application.status === 'rejected' ? '未通过' : application.status === 'invalid' || application.status === 'expired' ? '已失效' : '审核中'
      })) : [];
    this.setData({
      familyCircles: result.data.circles.filter(c => c.type === 'family'),
      classCircles: result.data.circles.filter(c => c.type === 'classmate'),
      applicationRows,
      applicationError: mine.ok ? '' : '加入申请暂时无法加载，点此重试',
      loading: false
    });
  },
  onRetryApplications(this: any) { this.onShow(); },
  onOpenApplication(this: any, event: any) { go(`/pages/apply/index?applicationId=${q(event.currentTarget.dataset.id)}`); },
  onOpenCircle(this: any, event: any) {
    const id = event.currentTarget.dataset.id;
    wx.setStorageSync('kin-current-circle', id);
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
      setDemoMode(true);
    }
    this.onShow();
  }
});
