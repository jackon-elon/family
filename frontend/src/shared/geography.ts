import { CITY_CATALOG } from "./city-catalog";

export interface GeoValue {
  country?: string;
  province?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
}
export interface MapPerson extends GeoValue {
  id: string;
  name: string;
  photoUrl?: string;
}
export interface CityOption extends Required<GeoValue> {}
export interface CityGroup {
  key: string;
  country: string;
  province: string;
  city: string;
  people: MapPerson[];
  point: { latitude: number; longitude: number } | null;
  outsideChina: boolean;
}

const compare = (a: string, b: string) => a.localeCompare(b, "zh-CN");
const provinceAliases: Readonly<Record<string, string>> = {
  内蒙古自治区: "内蒙古",
  广西壮族自治区: "广西",
  西藏自治区: "西藏",
  宁夏回族自治区: "宁夏",
  新疆维吾尔自治区: "新疆",
  香港特别行政区: "香港",
  澳门特别行政区: "澳门",
};
const chineseProvinceName = (value: string) =>
  provinceAliases[value] || value.replace(/[省市]$/, "");
const chineseCityName = (value: string) => value.replace(/市$/, "");
const countries = [...new Set(CITY_CATALOG.map((row) => row[0]))].sort(
  (a, b) => (a === "中国" ? -1 : b === "中国" ? 1 : compare(a, b)),
);
export function cityCountries(): string[] {
  return countries;
}
export function cityProvinces(country: string): string[] {
  return [
    ...new Set(
      CITY_CATALOG.filter((row) => row[0] === country).map((row) => row[1]),
    ),
  ].sort(compare);
}
/** Only resolve known Chinese province aliases; preserve every unknown region. */
export function catalogProvince(country?: string, province?: string): string {
  const value = province?.trim() || "";
  if (country?.trim() !== "中国" || !value) return value;
  const matches = cityProvinces("中国").filter(
    (entry) => chineseProvinceName(entry) === chineseProvinceName(value),
  );
  return matches.length === 1 ? matches[0] : value;
}
export function cityChoices(country: string, province: string): CityOption[] {
  const normalizedProvince = catalogProvince(country, province);
  return CITY_CATALOG.filter(
    (row) => row[0] === country && row[1] === normalizedProvince,
  )
    .map(([country, province, city, latitude, longitude]) => ({
      country,
      province,
      city,
      latitude,
      longitude,
    }))
    .sort((a, b) => compare(a.city, b.city));
}
export function cityOptionInProvince(
  city?: string,
  country?: string,
  province?: string,
): CityOption | undefined {
  if (!city?.trim()) return undefined;
  const wantedCountry = country?.trim();
  const wantedProvince = province?.trim();
  const wantedCity = city.trim();
  const candidates = CITY_CATALOG.filter(
    (row) =>
      (!wantedCountry || row[0] === wantedCountry) &&
      (row[2] === wantedCity ||
        (row[0] === "中国" &&
          chineseCityName(row[2]) === chineseCityName(wantedCity))) &&
      (!wantedProvince ||
        row[1] === wantedProvince ||
        (row[0] === "中国" &&
          chineseProvinceName(row[1]) === chineseProvinceName(wantedProvince))),
  );
  // An ambiguous place name must never silently select a different province.
  if (candidates.length !== 1) return undefined;
  const [foundCountry, foundProvince, foundCity, latitude, longitude] =
    candidates[0];
  return {
    country: foundCountry,
    province: foundProvince,
    city: foundCity,
    latitude,
    longitude,
  };
}
export function coordinates(
  value: GeoValue,
): { latitude: number; longitude: number } | null {
  if (!value.city?.trim()) return null;
  if (
    typeof value.latitude === "number" &&
    Number.isFinite(value.latitude) &&
    Math.abs(value.latitude) <= 85.05112878 &&
    typeof value.longitude === "number" &&
    Number.isFinite(value.longitude) &&
    Math.abs(value.longitude) <= 180 &&
    (value.latitude !== 0 || value.longitude !== 0)
  ) {
    return { latitude: value.latitude, longitude: value.longitude };
  }
  const match = cityOptionInProvince(value.city, value.country, value.province);
  return match
    ? { latitude: match.latitude, longitude: match.longitude }
    : null;
}

/** Keep every person in the city list, even when there is no usable map coordinate. */
export function citySummary(people: readonly MapPerson[]) {
  const byCity = new Map<string, CityGroup>();
  const seen = new Set<string>();
  for (const person of people) {
    if (seen.has(person.id)) continue;
    seen.add(person.id);
    const fallback = cityOptionInProvince(
      person.city,
      person.country,
      person.province,
    );
    // Known full/short administrative names must refer to a single city group.
    // Do not normalize unknown places: similar names can be different cities.
    const country = fallback?.country || person.country?.trim() || "";
    const province = fallback?.province || person.province?.trim() || "";
    const city = fallback?.city || person.city?.trim() || "";
    const point = country ? coordinates(person) : null;
    const outsideChina = !!country && country !== "中国";
    // Province is significant: two cities with the same name are not one city.
    const key = JSON.stringify([country, province, city]);
    let group = byCity.get(key);
    if (!group) {
      group = { key, country, province, city, point, people: [], outsideChina };
      byCity.set(key, group);
    }
    group.people.push(person);
    if (!group.point && point) group.point = point;
  }
  const groups = [...byCity.values()].sort(
    (a, b) =>
      Number(!a.point) - Number(!b.point) ||
      b.people.length - a.people.length ||
      compare(a.city, b.city),
  );
  const domestic = groups
    .filter((group) => group.point && !group.outsideChina)
    .reduce((sum, group) => sum + group.people.length, 0);
  const overseas = groups
    .filter((group) => group.point && group.outsideChina)
    .reduce((sum, group) => sum + group.people.length, 0);
  const unlocated = groups
    .filter((group) => !group.point)
    .reduce((sum, group) => sum + group.people.length, 0);
  return { groups, total: seen.size, domestic, overseas, unlocated };
}
