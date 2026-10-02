import { toast } from '../../utils/navigation';

interface InitialCityLocation {
  city?: string;
  country?: string;
  province?: string;
  latitude?: number | null;
  longitude?: number | null;
}

// This map has no GPS entry point. The user names a city and pans the map to a
// representative center; only a point rounded to 0.1 degree is passed back.
const REGIONS = [
  {label: '中国', latitude: 35, longitude: 104},
  {label: '亚洲', latitude: 25, longitude: 85},
  {label: '欧洲', latitude: 49, longitude: 15},
  {label: '非洲', latitude: 2, longitude: 20},
  {label: '美洲', latitude: 39, longitude: -98},
  {label: '大洋洲', latitude: -25, longitude: 135}
];

Page({
  data: {
    city: '', country: '', province: '',
    latitude: 35, longitude: 104, scale: 5,
    regions: REGIONS,
    selecting: false, hasOpener: true
  },
  onLoad(this: any) {
    let channel: any;
    try { channel = this.getOpenerEventChannel?.(); } catch (_) { channel = null; }
    if (!channel || typeof channel.on !== 'function' || typeof channel.emit !== 'function') {
      this.setData({hasOpener: false});
      return;
    }
    this.openerChannel = channel;
    channel.on('initialCityLocation', (initial: InitialCityLocation) => {
      const hasPoint = typeof initial.latitude === 'number' && typeof initial.longitude === 'number' &&
        Number.isFinite(initial.latitude) && Number.isFinite(initial.longitude);
      this.setData({
        city: initial.city || '', country: initial.country || '', province: initial.province || '',
        latitude: hasPoint ? initial.latitude : 35,
        longitude: hasPoint ? initial.longitude : 104,
        scale: hasPoint ? 10 : 5
      });
    });
  },
  onReady(this: any) { if (this.data.hasOpener) this.mapContext = wx.createMapContext('cityMap', this); },
  onBackHome() { wx.reLaunch({url: '/pages/circles/index'}); },
  onInput(this: any, event: any) {
    const field = event.currentTarget.dataset.field;
    if (field === 'city' || field === 'country' || field === 'province') this.setData({[field]: event.detail.value});
  },
  onRegion(this: any, event: any) {
    const region = REGIONS[Number(event.currentTarget.dataset.index)];
    if (region) this.setData({latitude: region.latitude, longitude: region.longitude, scale: 5});
  },
  onConfirm(this: any) {
    if (this.data.selecting) return;
    if (!this.openerChannel?.emit) return toast('请从人物资料编辑页打开城市地图');
    const city = this.data.city.trim();
    const country = this.data.country.trim();
    const province = this.data.province.trim();
    if (!city) return toast('请填写城市名称');
    if (!country) return toast('请填写国家或地区');
    if (!this.mapContext) return toast('地图还在加载，请稍后重试');
    this.setData({selecting: true});
    this.mapContext.getCenterLocation({
      success: (point: {latitude: number; longitude: number}) => {
        if (!Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) ||
          Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) {
          this.setData({selecting: false});
          return toast('地图位置无效，请重新选择');
        }
        this.openerChannel.emit('cityLocationSelected', {
          city, country, province,
          latitude: Math.round(point.latitude * 10) / 10,
          longitude: Math.round(point.longitude * 10) / 10
        });
        wx.navigateBack();
      },
      fail: () => { this.setData({selecting: false}); toast('无法读取地图中心，请重试'); }
    });
  }
});
