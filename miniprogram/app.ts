import { isDemoMode } from './services/api';
import { CLOUD_ENV_ID } from './config';

App({
  onLaunch() {
    // touristappid 可以直接运行演示。配置云环境后在首页手动切换到云端。
    if (!isDemoMode() && CLOUD_ENV_ID && wx.cloud && wx.cloud.init) {
      wx.cloud.init({ env: CLOUD_ENV_ID, traceUser: true });
    }
  },
  globalData: { appName: '亲友关系网' }
});
