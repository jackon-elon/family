import { Circle, invoke, isDemoMode, resetDemoData, setDemoMode } from '../../services/api';
import { CLOUD_ENV_ID } from '../../config';
import { confirm, go, q, toast } from '../../utils/navigation';

interface ManagedRecord extends Circle {
  roleLabel: string;
  typeLabel: string;
}

Page({
  data: {
    loading: true,
    error: '',
    demoMode: isDemoMode(),
    canConnectCloud: isDemoMode() && !!CLOUD_ENV_ID,
    managedRecords: [] as ManagedRecord[]
  },
  onShow(this: any) {
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null;
    if (tabBar) tabBar.setData({ selected: 1 });
    this.loadData();
  },
  onPullDownRefresh(this: any) { this.loadData().finally(() => wx.stopPullDownRefresh()); },
  async loadData(this: any) {
    const request = (this.loadVersion || 0) + 1;
    this.loadVersion = request;
    const demoMode = isDemoMode();
    this.setData({ loading: true, error: '', demoMode, canConnectCloud: demoMode && !!CLOUD_ENV_ID });
    const synced = await invoke<{ hasVerifiedPhone: boolean }>({ action: 'account.sync' });
    if (this.loadVersion !== request) return;
    if (!synced.ok) {
      this.setData({ loading: false, error: synced.error.message, managedRecords: [] });
      return;
    }
    if (!synced.data.hasVerifiedPhone) {
      wx.reLaunch({ url: '/pages/login/index' });
      return;
    }
    const result = await invoke<{ circles: Circle[] }>({ action: 'circle.list' });
    if (this.loadVersion !== request) return;
    if (!result.ok) {
      this.setData({ loading: false, error: result.error.message, managedRecords: [] });
      return;
    }
    this.setData({
      loading: false,
      managedRecords: result.data.circles
        .filter(circle => circle.role === 'owner' || circle.role === 'admin')
        .map(circle => ({
          ...circle,
          roleLabel: '管理员',
          typeLabel: circle.type === 'family' ? '家人录' : '同窗录'
        }))
    });
  },
  onRetry(this: any) { if (!this.data.loading) this.loadData(); },
  onOpenProfile() { go('/pages/profile/index'); },
  onOpenManage(this: any, event: any) {
    const circleId = String(event.currentTarget.dataset.id || '');
    if (this.data.managedRecords.some((record: ManagedRecord) => record.id === circleId)) {
      go(`/pages/manage/index?circleId=${q(circleId)}`);
    }
  },
  async onReset(this: any) {
    if (!isDemoMode()) return;
    if (!(await confirm('恢复演示资料', '你在本机演示中添加的家人录、同窗录、人物和申请都会清除。确定恢复吗？'))) return;
    if (!resetDemoData()) return toast('演示资料存储空间不足，恢复失败');
    toast('演示资料已恢复');
    this.loadData();
  },
  async onSwitchMode(this: any) {
    if (!isDemoMode() || !CLOUD_ENV_ID) return;
    if (!(await confirm('切换到云端', '请先配置真实小程序 AppID、云环境，并部署 api 云函数。现在尝试切换吗？'))) return;
    if (!setDemoMode(false)) return toast('切换失败，请检查云环境和本机存储');
    this.loadData();
  }
});
