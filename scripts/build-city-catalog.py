"""Build the checked-in offline country > province/state > city picker data.

Sources: public-wheels/china-cities (MIT) and GeoNames cities15000 (CC BY).
The generated catalog stores city-centre coordinates rounded to 0.1 degree.
"""

import io
import json
import subprocess
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHINA_URL = "https://raw.githubusercontent.com/public-wheels/china-cities/master/china_cities.json"
GEONAMES_URL = "https://download.geonames.org/export/dump/cities15000.zip"
ADMIN_URL = "https://download.geonames.org/export/dump/admin1CodesASCII.txt"
DIRECT = {"北京", "天津", "上海", "重庆", "香港", "澳门"}
WORLD_LIMIT = {"US": 120, "CA": 45, "GB": 45, "AU": 45, "JP": 45, "DE": 40,
               "FR": 40, "IT": 35, "RU": 60, "IN": 60, "KR": 35, "NZ": 30,
               "MY": 30, "AE": 25, "SG": 25}
CITY_ZH = {
    ("US", "New York City"): "纽约", ("US", "San Francisco"): "旧金山",
    ("US", "Los Angeles"): "洛杉矶", ("US", "Seattle"): "西雅图",
    ("US", "Chicago"): "芝加哥", ("US", "Boston"): "波士顿",
    ("CA", "Toronto"): "多伦多", ("CA", "Vancouver"): "温哥华",
    ("CA", "Montreal"): "蒙特利尔", ("GB", "London"): "伦敦",
    ("FR", "Paris"): "巴黎", ("AU", "Sydney"): "悉尼",
    ("AU", "Melbourne"): "墨尔本", ("JP", "Tokyo"): "东京",
    ("JP", "Osaka"): "大阪", ("JP", "Kyoto"): "京都",
    ("SG", "Singapore"): "新加坡", ("KR", "Seoul"): "首尔",
    ("DE", "Berlin"): "柏林", ("DE", "Munich"): "慕尼黑",
    ("RU", "Moscow"): "莫斯科", ("NZ", "Auckland"): "奥克兰",
}


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "family-network-catalog-builder/1.0"})
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read()


def point(row):
    try:
        latitude = round(float(row[0]), 1)
        longitude = round(float(row[1]), 1)
    except (TypeError, ValueError):
        return None
    return [latitude, longitude] if -90 <= latitude <= 90 and -180 <= longitude <= 180 else None


def china_cities():
    raw = json.loads(fetch(CHINA_URL))
    selected = {}
    for province in raw:
        province_name = province.get("ProvinceNameZh", "").strip()
        for prefecture in province.get("prefectureCities", []):
            city_name = prefecture.get("prefectureNameZh", "").strip()
            if not city_name or province_name in DIRECT and city_name != province_name:
                continue
            centre = next((city for city in prefecture.get("cities", []) if city.get("nameZh") == city_name), None)
            if centre is None and prefecture.get("cities"):
                centre = prefecture["cities"][0]
            coordinate = point([centre.get("latitude"), centre.get("longtitude")]) if centre else None
            if coordinate:
                selected[(province_name, city_name)] = ["中国", province_name, city_name, *coordinate]
    # The source's Chongqing municipality entry resolves to an eastern district
    # in one duplicate province block; use the established municipal centre.
    selected[("重庆", "重庆")] = ["中国", "重庆", "重庆", 29.6, 106.5]
    return list(selected.values())


def country_names(codes):
    script = "const codes=JSON.parse(process.argv[1]);const names=new Intl.DisplayNames(['zh-CN'],{type:'region'});process.stdout.write(JSON.stringify(Object.fromEntries(codes.map(c=>[c,names.of(c)]))))"
    return json.loads(subprocess.check_output(["node", "-e", script, json.dumps(codes)], encoding="utf8"))


def world_cities():
    admin = {}
    for line in fetch(ADMIN_URL).decode("utf8").splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            admin[parts[0]] = parts[1]
    with zipfile.ZipFile(io.BytesIO(fetch(GEONAMES_URL))) as archive:
        lines = archive.read("cities15000.txt").decode("utf8").splitlines()
    countries = defaultdict(list)
    for line in lines:
        parts = line.split("\t")
        if len(parts) < 15:
            continue
        iso = parts[8]
        if iso in {"CN", "HK", "MO", "TW"} or len(iso) != 2:
            continue
        coordinate = point([parts[4], parts[5]])
        if not coordinate:
            continue
        try:
            population = int(parts[14] or 0)
        except ValueError:
            population = 0
        countries[iso].append((population, parts[7] == "PPLC", parts[1], parts[10], coordinate))
    display = country_names(list(countries))
    selected = {}
    for iso, cities in countries.items():
        cities.sort(key=lambda city: (city[1], city[0]), reverse=True)
        for _, _, name, state_code, coordinate in cities[:WORLD_LIMIT.get(iso, 15)]:
            country = display.get(iso, iso)
            state = admin.get(f"{iso}.{state_code}", state_code or country)
            city = CITY_ZH.get((iso, name), name)
            selected[(iso, state, city)] = [country, state, city, *coordinate]
    # Cities used by the original demo must stay stable even when rankings change.
    expected = {"美国/旧金山", "美国/纽约", "加拿大/多伦多", "加拿大/温哥华",
                "英国/伦敦", "法国/巴黎", "澳大利亚/悉尼", "日本/东京", "新加坡/新加坡"}
    found = {f"{row[0]}/{row[2]}" for row in selected.values()}
    missing = expected - found
    if missing:
        raise ValueError(f"Required demo cities not in GeoNames selection: {missing}")
    return list(selected.values())


def main():
    catalog = china_cities() + world_cities()
    catalog.sort(key=lambda row: (row[0] != "中国", row[0], row[1], row[2]))
    path = ROOT / "miniprogram" / "utils" / "city-catalog.ts"
    data = json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))
    path.write_text("// Generated by scripts/build-city-catalog.py; sources and licence: docs/city-catalog-data.md\n"
                    "export type CatalogCity = [country: string, province: string, city: string, latitude: number, longitude: number];\n"
                    f"export const CITY_CATALOG: CatalogCity[] = {data};\n", encoding="utf8")
    print(f"Wrote {len(catalog)} cities across {len(set(row[0] for row in catalog))} countries/regions to {path}")


if __name__ == "__main__":
    main()
