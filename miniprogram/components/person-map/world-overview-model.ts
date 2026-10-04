import { MapCity } from './model';

export interface OverviewCity { key: string; city: string; country: string; count: number }
export interface OverviewCluster {
  id: string;
  x: number;
  y: number;
  count: number;
  cityCount: number;
  label: string;
  summary: string;
  selected: boolean;
  cities: OverviewCity[];
}

const LAT_MIN = -60;
const LAT_MAX = 85;
const CLUSTER_X = 4.2;
const CLUSTER_Y = 8;

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

// The local Natural Earth image uses this equirectangular longitude/latitude
// projection and omits Antarctica to give inhabited places more room.
export function projectWorldCoordinate(latitude: number, longitude: number): { x: number; y: number } {
  return {
    x: clamp((longitude + 180) / 360 * 100, 3.5, 96.5),
    y: clamp((LAT_MAX - latitude) / (LAT_MAX - LAT_MIN) * 100, 6, 94)
  };
}

export function buildWorldOverview(cities: MapCity[], selectedKey = ''): OverviewCluster[] {
  const groups: Array<{ x: number; y: number; count: number; cities: OverviewCity[] }> = [];
  for (const city of cities) {
    const point = projectWorldCoordinate(city.latitude, city.longitude);
    let nearest: typeof groups[number] | undefined;
    let best = Infinity;
    for (const group of groups) {
      const dx = Math.abs(group.x - point.x);
      const dy = Math.abs(group.y - point.y);
      if (dx > CLUSTER_X || dy > CLUSTER_Y) continue;
      const distance = dx * dx + dy * dy;
      if (distance < best) { best = distance; nearest = group; }
    }
    const summary = { key: city.key, city: city.city, country: city.country, count: city.count };
    if (!nearest) { groups.push({ x: point.x, y: point.y, count: city.count, cities: [summary] }); continue; }
    const nextCount = nearest.count + city.count;
    nearest.x = (nearest.x * nearest.count + point.x * city.count) / nextCount;
    nearest.y = (nearest.y * nearest.count + point.y * city.count) / nextCount;
    nearest.count = nextCount;
    nearest.cities.push(summary);
  }
  return groups.map((group, index) => {
    const countries = new Set(group.cities.map(city => city.country));
    const label = group.cities.length === 1 ? group.cities[0].city : countries.size === 1 ? group.cities[0].country : `${group.cities.length} 座城市`;
    return {
      id: `cluster_${index + 1}`,
      x: Math.round(group.x * 10) / 10,
      y: Math.round(group.y * 10) / 10,
      count: group.count,
      cityCount: group.cities.length,
      label,
      summary: `${label}，${group.count} 人；点按查看城市`,
      selected: group.cities.some(city => city.key === selectedKey),
      cities: group.cities
    };
  });
}
