import { Person } from '../../services/api';
import { cityOption } from '../../utils/geography';

export type MapScope = 'china' | 'world';

export interface MapCity {
  key: string;
  city: string;
  country: string;
  count: number;
  personIds: string[];
  latitude: number;
  longitude: number;
}

export interface MapMarker {
  id: number;
  latitude: number;
  longitude: number;
  iconPath: string;
  width: number;
  height: number;
  anchor: { x: number; y: number };
  label: {
    content: string;
    color: string;
    fontSize: number;
    borderRadius: number;
    borderWidth: number;
    borderColor: string;
    bgColor: string;
    padding: number;
    anchorX: number;
    anchorY: number;
  };
}

export interface PersonMapModel {
  cities: MapCity[];
  markers: MapMarker[];
  includePoints: { latitude: number; longitude: number }[];
  centerLatitude: number;
  centerLongitude: number;
  scale: number;
}

function validCoordinate(latitude: unknown, longitude: unknown): latitude is number {
  return typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180 &&
    (latitude !== 0 || longitude !== 0);
}

function cityCoordinate(person: Person, city: string, country: string): { latitude: number; longitude: number } | null {
  // Use the city centre selected on the map. An older record may contain a
  // precise coordinate, so always reduce it to city-level precision here.
  if (validCoordinate(person.latitude, person.longitude)) return {
    latitude: Math.round(person.latitude * 10) / 10,
    longitude: Math.round(person.longitude! * 10) / 10
  };
  const known = cityOption(city, country);
  return known ? { latitude: known.latitude, longitude: known.longitude } : null;
}

export function buildPersonMapModel(people: Person[], scope: MapScope, selectedKey = ''): PersonMapModel {
  const map = new Map<string, MapCity>();
  for (const person of people || []) {
    const city = (person.city || '').trim();
    if (!city) continue;
    const country = (person.country || '中国').trim() || '中国';
    if (scope === 'china' && country !== '中国') continue;
    const point = cityCoordinate(person, city, country);
    if (!point) continue;
    const key = `${country}/${city}`;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
      existing.personIds.push(person.id);
    } else {
      map.set(key, { key, city, country, count: 1, personIds: [person.id], ...point });
    }
  }

  const cities = Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
  const markers = cities.map((city, index): MapMarker => {
    const selected = city.key === selectedKey;
    const color = selected ? '#a65326' : '#174d3a';
    return {
      id: index + 1,
      latitude: city.latitude,
      longitude: city.longitude,
      iconPath: selected ? '/components/person-map/marker-selected.png' : '/components/person-map/marker.png',
      width: 30,
      height: 30,
      anchor: { x: 0.5, y: 0.5 },
      label: {
        content: `${city.city} · ${city.count}人`,
        color,
        fontSize: 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: selected ? '#e6aa75' : '#d2e5db',
        bgColor: '#ffffff',
        padding: 5,
        anchorX: 17,
        anchorY: -10
      }
    };
  });

  // The native map cannot zoom out far enough to fit intercontinental points
  // into a portrait phone screen. Start at a member's city in that case.
  const latitudeSpread = cities.length ? Math.max(...cities.map(city => city.latitude)) - Math.min(...cities.map(city => city.latitude)) : 0;
  const longitudeSpread = cities.length ? Math.max(...cities.map(city => city.longitude)) - Math.min(...cities.map(city => city.longitude)) : 0;
  const canFit = latitudeSpread <= 50 && longitudeSpread <= 60;
  const selectedCity = map.get(selectedKey);
  // A single point should not zoom down to a street. Nearby points can fit automatically.
  const includePoints = cities.length >= 2 && canFit && !selectedCity
    ? cities.map(({ latitude, longitude }) => ({ latitude, longitude }))
    : [];
  const fallback = scope === 'china'
    ? { latitude: 35, longitude: 104, scale: 4 }
    : { latitude: 20, longitude: 10, scale: 3 };
  const self = (people || []).find(person => person.isSelf && person.city);
  const selfCountry = (self?.country || '中国').trim() || '中国';
  const focus = selectedCity || (self && map.get(`${selfCountry}/${self.city?.trim()}`)) || cities[0];
  const focused = !!selectedCity || cities.length === 1 || (cities.length >= 2 && !canFit);
  return {
    cities,
    markers,
    includePoints,
    centerLatitude: focused && focus ? focus.latitude : fallback.latitude,
    centerLongitude: focused && focus ? focus.longitude : fallback.longitude,
    scale: focused && focus ? (scope === 'china' ? 6 : selectedCity ? 5 : 4) : fallback.scale
  };
}
