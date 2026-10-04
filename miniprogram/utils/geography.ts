import { Person } from '../services/api';
import { CITY_CATALOG } from './city-catalog';

export interface CityOption { city: string; province: string; country: string; latitude: number; longitude: number }
export interface CityGroup { key: string; city: string; country: string; count: number; persons: Person[]; outsideChina: boolean }

export const CITY_OPTIONS: CityOption[] = [
  { city: '北京', province: '北京', country: '中国', latitude: 39.9, longitude: 116.4 },
  { city: '上海', province: '上海', country: '中国', latitude: 31.2, longitude: 121.5 },
  { city: '广州', province: '广东', country: '中国', latitude: 23.1, longitude: 113.3 },
  { city: '深圳', province: '广东', country: '中国', latitude: 22.5, longitude: 114.1 },
  { city: '杭州', province: '浙江', country: '中国', latitude: 30.3, longitude: 120.2 },
  { city: '成都', province: '四川', country: '中国', latitude: 30.7, longitude: 104.1 },
  { city: '苏州', province: '江苏', country: '中国', latitude: 31.3, longitude: 120.6 },
  { city: '武汉', province: '湖北', country: '中国', latitude: 30.6, longitude: 114.3 },
  { city: '西安', province: '陕西', country: '中国', latitude: 34.3, longitude: 108.9 },
  { city: '重庆', province: '重庆', country: '中国', latitude: 29.6, longitude: 106.5 },
  { city: '香港', province: '香港', country: '中国', latitude: 22.3, longitude: 114.2 },
  { city: '伦敦', province: '', country: '英国', latitude: 51.5, longitude: -0.1 },
  { city: '巴黎', province: '', country: '法国', latitude: 48.9, longitude: 2.4 },
  { city: '纽约', province: '纽约州', country: '美国', latitude: 40.7, longitude: -74.0 },
  { city: '旧金山', province: '加利福尼亚州', country: '美国', latitude: 37.8, longitude: -122.4 },
  { city: '多伦多', province: '安大略省', country: '加拿大', latitude: 43.7, longitude: -79.4 },
  { city: '温哥华', province: '不列颠哥伦比亚省', country: '加拿大', latitude: 49.3, longitude: -123.1 },
  { city: '悉尼', province: '新南威尔士州', country: '澳大利亚', latitude: -33.9, longitude: 151.2 },
  { city: '东京', province: '', country: '日本', latitude: 35.7, longitude: 139.7 },
  { city: '新加坡', province: '', country: '新加坡', latitude: 1.3, longitude: 103.8 }
];

export function cityOption(city?: string, country?: string): CityOption | undefined {
  return cityOptionInProvince(city, country);
}

export function cityOptionInProvince(city?: string, country?: string, province?: string): CityOption | undefined {
  if (!city) return undefined;
  const established = CITY_OPTIONS.find(c => c.city === city && (!country || c.country === country) && (!province || c.province === province));
  if (established) return established;
  const found = CITY_CATALOG.find(c => c[2] === city && (!country || c[0] === country) && (!province || c[1] === province));
  if (found) return { country: found[0], province: found[1], city: found[2], latitude: found[3], longitude: found[4] };
  return undefined;
}

export function cityCountries(): string[] {
  return Array.from(new Set(CITY_CATALOG.map(c => c[0]))).sort((a, b) => a === '中国' ? -1 : b === '中国' ? 1 : a.localeCompare(b, 'zh-CN'));
}

export function cityProvinces(country: string): string[] {
  return Array.from(new Set(CITY_CATALOG.filter(c => c[0] === country).map(c => c[1]))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export function cityChoices(country: string, province: string): CityOption[] {
  return CITY_CATALOG.filter(c => c[0] === country && c[1] === province)
    .map(c => ({ country: c[0], province: c[1], city: c[2], latitude: c[3], longitude: c[4] }))
    .sort((a, b) => a.city.localeCompare(b.city, 'zh-CN'));
}
function coord(person: Person): { latitude: number; longitude: number } | null {
  if (typeof person.latitude === 'number' && Number.isFinite(person.latitude) && Math.abs(person.latitude) <= 90 &&
      typeof person.longitude === 'number' && Number.isFinite(person.longitude) && Math.abs(person.longitude) <= 180 &&
      (person.latitude !== 0 || person.longitude !== 0)) return { latitude: Math.round(person.latitude * 10) / 10, longitude: Math.round(person.longitude * 10) / 10 };
  const option = cityOptionInProvince(person.city, person.country, person.province);
  return option ? { latitude: option.latitude, longitude: option.longitude } : null;
}
export interface CityMapSummary { groups: CityGroup[]; overseas: number; unmapped: number; missingCity: number; incomplete: number; mappedPeople: number }
export function groupCities(persons: Person[], scope: 'china' | 'world'): CityMapSummary {
  const incomplete = persons.filter(p => p.profileComplete === false).length;
  const eligible = persons.filter(p => p.profileComplete !== false);
  const missingCity = eligible.filter(p => !p.city?.trim()).length;
  const visible = eligible.filter(p => !!p.city?.trim());
  const overseas = visible.filter(p => p.country && p.country !== '中国').length;
  const items = scope === 'china' ? visible.filter(p => !p.country || p.country === '中国') : visible;
  const map: Record<string, CityGroup> = {};
  let unmapped = 0;
  items.forEach(person => {
    const point = coord(person);
    if (!point) { unmapped++; return; }
    const country = person.country || '中国';
    const key = `${country}/${person.city}`;
    if (!map[key]) {
      map[key] = { key, city: person.city || '', country, count: 0, persons: [], outsideChina: country !== '中国' };
    }
    map[key].count++;
    map[key].persons.push(person);
  });
  const groups = Object.values(map).sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));
  return { groups, overseas, unmapped, missingCity, incomplete, mappedPeople: groups.reduce((count, group) => count + group.count, 0) };
}
