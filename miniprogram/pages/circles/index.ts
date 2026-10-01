import { Circle, invoke, isDemoMode, resetDemoData, setDemoMode, showApiError } from '../../services/api';
import { confirm, go, q, toast } from '../../utils/navigation';

Page({
  data: { familyCircles: [] as Circle[], classCircles: [] as Circle[], demoMode: true, loading: true },
  async onShow(this: any) {
    this.setData({ demoMode: isDemoMode(), loading: true });
    const result = await invoke<{ circles: Circle[] }>({ action: 'circle.list' });
    if (!result.ok) { showApiError(result); this.setData({ loading: false }); return; }
    this.setData({
      familyCircles: result.data.circles.filter(c => c.type === 'family'),
      classCircles: result.data.circles.filter(c => c.type === 'classmate'),
      loading: false
    });
  },
  onOpenCircle(this: any, event: any) {
    const id = event.currentTarget.dataset.id;
    wx.setStorageSync('kin-current-circle', id);
    go(`/pages/circle/index?circleId=${q(id)}`);
  },
  onCreate() { go('/pages/create/index'); },
  async onReset(this: any) {
    if (!(await confirm('重置演示数据', '会清除你在演示模式中新增的圈子、人物和申请。确定重置吗？'))) return;
    resetDemoData();
    toast('演示数据已恢复');
    this.onShow();
  },
  async onSwitchMode(this: any) {
    if (this.data.demoMode) {
      if (!(await confirm('切换到云端', '请先配置真实小程序 AppID、云环境，并部署 api 云函数。现在尝试切换吗？'))) return;
      if (!setDemoMode(false)) { toast('当前环境没有云开发能力'); return; }
    } else {
      setDemoMode(true);
    }
    this.onShow();
  }
});
