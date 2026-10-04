import { isDemoMode } from './services/api';
import { CLOUD_ENV_ID } from './config';

App({
  onLaunch() {
    // 没有云环境时使用本地演示；配置云环境后优先进入真实服务。
    if (!isDemoMode() && CLOUD_ENV_ID && wx.cloud && wx.cloud.init) {
      wx.cloud.init({ env: CLOUD_ENV_ID, traceUser: true });
    }
  },
  globalData: { appName: '人间星图' }
});
