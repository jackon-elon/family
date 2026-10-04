import { cityChoices, cityCountries, cityOptionInProvince, cityProvinces, CityOption } from '../../utils/geography';
import { toast } from '../../utils/navigation';

interface InitialCityLocation {
  city?: string;
  country?: string;
  province?: string;
  latitude?: number | null;
  longitude?: number | null;
}

type Stage = 'country' | 'province' | 'city' | 'custom';
interface Choice { label: string; value?: string; latitude?: number; longitude?: number }

function optionsFor(stage: Stage, country: string, province: string): Choice[] {
  if (stage === 'country') return cityCountries().map(label => ({label}));
  if (stage === 'province') return cityProvinces(country).map(value => ({label: value || '不分省 / 州', value}));
  if (stage === 'city') return cityChoices(country, province).map(city => ({label: city.city, latitude: city.latitude, longitude: city.longitude}));
  return [];
}

Page({
  data: {
    country: '', province: '', city: '', latitude: null as number | null, longitude: null as number | null,
    stage: 'country' as Stage, options: [] as Choice[], shownOptions: [] as Choice[], search: '',
    selecting: false, hasOpener: true, selected: false
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
      const country = initial.country || '';
      const province = initial.province || '';
      const city = initial.city || '';
      const known = cityOptionInProvince(city, country, province);
      const stage: Stage = city && !known ? 'custom' : country && city && cityProvinces(country).includes(province) ? 'city' : country && cityProvinces(country).length ? 'province' : 'country';
      const latitude = known?.latitude ?? (typeof initial.latitude === 'number' ? initial.latitude : null);
      const longitude = known?.longitude ?? (typeof initial.longitude === 'number' ? initial.longitude : null);
      this.setData({country, province, city, latitude, longitude, selected: !!city && !!known, stage, search: ''});
      this.refreshOptions();
    });
    this.refreshOptions();
  },
  onBackHome() { wx.reLaunch({url: '/pages/circles/index'}); },
  refreshOptions(this: any) {
    const options = optionsFor(this.data.stage, this.data.country, this.data.province);
    const search = this.data.search.trim().toLocaleLowerCase();
    this.setData({options, shownOptions: search ? options.filter(item => item.label.toLocaleLowerCase().includes(search)) : options});
  },
  onSearch(this: any, event: any) { this.setData({search: String(event.detail.value || '')}); this.refreshOptions(); },
  onSelect(this: any, event: any) {
    const choice: Choice | undefined = this.data.shownOptions[Number(event.currentTarget.dataset.index)];
    if (!choice) return;
    const stage: Stage = this.data.stage;
    if (stage === 'country') this.setData({country: choice.label, province: '', city: '', latitude: null, longitude: null, selected: false, stage: cityProvinces(choice.label).length === 1 && cityProvinces(choice.label)[0] === '' ? 'city' : 'province', search: ''});
    else if (stage === 'province') this.setData({province: choice.value ?? choice.label, city: '', latitude: null, longitude: null, selected: false, stage: 'city', search: ''});
    else if (stage === 'city') this.setData({city: choice.label, latitude: choice.latitude, longitude: choice.longitude, selected: true, search: ''});
    this.refreshOptions();
  },
  onBackLevel(this: any) {
    const stage: Stage = this.data.stage;
    this.setData({stage: stage === 'city' && !(cityProvinces(this.data.country).length === 1 && cityProvinces(this.data.country)[0] === '') ? 'province' : 'country', search: ''});
    this.refreshOptions();
  },
  onCustom(this: any) { this.setData({stage: 'custom', search: '', selected: false, latitude: null, longitude: null}); this.refreshOptions(); },
  onCustomInput(this: any, event: any) {
    const field = event.currentTarget.dataset.field;
    if (field === 'country' || field === 'province' || field === 'city') this.setData({[field]: event.detail.value, latitude: null, longitude: null, selected: false});
  },
  onConfirm(this: any) {
    if (this.data.selecting) return;
    if (!this.openerChannel?.emit) return toast('请从资料编辑页打开城市选择');
    const city = this.data.city.trim();
    const country = this.data.country.trim();
    const province = this.data.province.trim();
    if (!country) return toast('请选择或填写国家 / 地区');
    if (!city) return toast('请选择或填写城市');
    if (this.data.stage !== 'custom' && !this.data.selected) return toast('请从列表中选择城市');
    const known: CityOption | undefined = this.data.stage === 'custom' ? undefined : cityOptionInProvince(city, country, province);
    const existingPoint = this.data.stage === 'custom' && typeof this.data.latitude === 'number' && Number.isFinite(this.data.latitude) && Math.abs(this.data.latitude) <= 90 &&
      typeof this.data.longitude === 'number' && Number.isFinite(this.data.longitude) && Math.abs(this.data.longitude) <= 180 &&
      (this.data.latitude !== 0 || this.data.longitude !== 0);
    this.setData({selecting: true});
    this.openerChannel.emit('cityLocationSelected', {
      city, country, province,
      latitude: known?.latitude ?? (existingPoint ? Math.round(this.data.latitude * 10) / 10 : null),
      longitude: known?.longitude ?? (existingPoint ? Math.round(this.data.longitude * 10) / 10 : null)
    });
    wx.navigateBack();
  }
});
