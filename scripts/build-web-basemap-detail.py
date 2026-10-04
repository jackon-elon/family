"""Rebuild bundled province outlines and city labels using Python 3.8+ stdlib.

Only vector source files are fetched. --source-dir supports an offline rebuild;
the existing local city catalog is pinned by a canonical JSON checksum.
"""

from __future__ import annotations

import argparse
import gzip
import importlib.util
import json
import math
import re
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("overview", ROOT / "scripts/build-web-basemap.py")
overview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overview)
OUTPUT = overview.OUTPUT
ADMIN_FILE = "ne_10m_admin_1_states_provinces.geojson"
ADMIN_HASH = "22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5"
CATALOG_PATH = "frontend/src/shared/city-catalog.ts"
CATALOG_HASH = "d2ea345bc63d1c7a027e4740a20b99fa666b27c04e04df7d47dbe78a14157846"
MIT_FILE = "china-cities-LICENSE.txt"
MIT_URL = "https://raw.githubusercontent.com/public-wheels/china-cities/91375815c8a1a5b834705be249bd1aa5f645053a/LICENSE"
MIT_HASH = "c80e94af1dc4f24e01dd16a6fbf41925d1193a7cce408e18ff3a2fd03f2cd1cb"
COVERED = ["CHN", "HKG", "MAC", "TWN"]
DIRECT = {"北京", "上海", "天津", "重庆", "香港", "澳门"}
PROVINCE_CAPITALS = {
    "石家庄", "太原", "呼和浩特", "沈阳", "长春", "哈尔滨", "南京", "杭州", "合肥",
    "福州", "南昌", "济南", "郑州", "武汉", "长沙", "广州", "南宁", "海口", "成都",
    "贵阳", "昆明", "拉萨", "西安", "兰州", "西宁", "银川", "乌鲁木齐", "台北",
}
# Display priorities, not population claims. All remaining catalog cities are
# retained; the UI resolves overlaps according to zoom and the visible extent.
PROMINENT_CITIES = DIRECT | PROVINCE_CAPITALS | {"深圳", "苏州", "厦门", "青岛", "大连", "宁波"}
WORLD_HIGHLIGHTS = {
    ("美国", "纽约"), ("美国", "旧金山"), ("美国", "洛杉矶"), ("加拿大", "多伦多"),
    ("加拿大", "温哥华"), ("英国", "伦敦"), ("法国", "巴黎"), ("德国", "柏林"),
    ("日本", "东京"), ("日本", "大阪"), ("韩国", "首尔"), ("新加坡", "新加坡"),
    ("澳大利亚", "悉尼"), ("澳大利亚", "墨尔本"), ("新西兰", "奥克兰"), ("俄罗斯", "莫斯科"),
}


def source(filename, url, expected, source_dir):
    if source_dir:
        payload = (source_dir / filename).read_bytes()
    else:
        request = Request(url, headers={"User-Agent": "renjian-xingtu-basemap-build/1"})
        payload = urlopen(request, timeout=90).read()
    if overview.digest(payload) != expected:
        raise ValueError("Source SHA256 mismatch: " + filename)
    return payload


def city_catalog():
    text = (ROOT / CATALOG_PATH).read_text(encoding="utf-8-sig")
    value = text.split("export const CITY_CATALOG: CatalogCity[] = ", 1)[1].strip().rstrip(";")
    rows = json.loads(re.sub(r",\s*(?=\])", "", value))
    if overview.digest(overview.encode(rows)) != CATALOG_HASH:
        raise ValueError("City catalog changed; review its coverage/source before updating CATALOG_HASH")
    keys = set()
    for country, province, city, latitude, longitude in rows:
        key = (country, province, city)
        if key in keys or not all(isinstance(value, str) and value.strip() for value in key):
            raise ValueError("Empty or duplicate city catalog key")
        keys.add(key)
        if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in (latitude, longitude)):
            raise ValueError("Invalid city coordinates")
        if abs(latitude) > 90 or abs(longitude) > 180:
            raise ValueError("City outside longitude/latitude bounds")
    return rows


def label(name, longitude, latitude, kind, minimum, maximum, priority):
    if not name or not math.isfinite(longitude) or not math.isfinite(latitude) or abs(longitude) > 180 or abs(latitude) > 90:
        raise ValueError("Invalid label")
    return {"name": name, "longitude": round(longitude, 4), "latitude": round(latitude, 4),
            "kind": kind, "minZoom": minimum, "maxZoom": maximum, "priority": priority}


def region_name(name):
    return re.sub(r"(?:维吾尔自治区|壮族自治区|回族自治区|自治区|省|市)$", "", name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, help="Directory with pinned admin-1, countries and MIT license files")
    parser.add_argument("--check", action="store_true", help="Verify byte-for-byte output without modifying files")
    args = parser.parse_args()
    admin = json.loads(source(ADMIN_FILE, overview.BASE + ADMIN_FILE, ADMIN_HASH, args.source_dir))
    countries_file = "ne_50m_admin_0_countries.geojson"
    countries = json.loads(source(countries_file, overview.BASE + countries_file, overview.SOURCES[countries_file], args.source_dir))
    license_text = source(MIT_FILE, MIT_URL, MIT_HASH, args.source_dir)
    rows = city_catalog()
    features, labels, ids = [], [], set()
    vertices = 0
    for item in sorted(admin["features"], key=lambda feature: feature["properties"]["adm1_code"]):
        properties = item["properties"]
        country = properties["adm0_a3"]
        if country not in COVERED:
            continue
        identity, name = properties["adm1_code"], properties["name_zh"]
        if not name or identity in ids:
            raise ValueError("Missing Chinese name or duplicate administrative feature")
        ids.add(identity)
        overview.validate_geometry(item["geometry"])
        geometry = {"type": item["geometry"]["type"], "coordinates": overview.round_coordinates(item["geometry"]["coordinates"])}
        vertices += overview.validate_geometry(geometry)
        features.append({"type": "Feature", "properties": {"id": identity, "name": name, "countryId": country}, "geometry": geometry})
        if country == "CHN" and re.fullmatch(r"CN-[A-Z]{2}", properties["iso_3166_2"]):
            labels.append(label(region_name(name), properties["longitude"], properties["latitude"], "region", 2, 6.5, 80))
    # Province-level names only; Hong Kong district names and Taiwan local
    # administrative names stay in source geometries, not province labels.
    names = {"HKG": "香港", "MAC": "澳门", "TWN": "台湾"}
    for feature in countries["features"]:
        properties = feature["properties"]
        if properties["ADM0_A3"] in names:
            labels.append(label(names[properties["ADM0_A3"]], properties["LABEL_X"], properties["LABEL_Y"], "region", 2, 6.5, 80))
    if len(labels) != 34 or len(features) != 72:
        raise ValueError("Unexpected pinned province coverage")
    for country, province, city, latitude, longitude in rows:
        prominent = city in PROMINENT_CITIES if country == "中国" else (country, city) in WORLD_HIGHLIGHTS
        minimum = 5 if prominent else 6 if country == "中国" else 7
        labels.append(label(city, longitude, latitude, "city", minimum, 9, 100 if prominent else 40 if country == "中国" else 20))
    if len([row for row in rows if row[0] == "中国"]) != 370 or len(rows) != 3339:
        raise ValueError("Unexpected pinned city catalog coverage")
    outputs = {
        "china-provinces.json": overview.encode({"type": "FeatureCollection", "features": features}),
        "city-labels.json": overview.encode(labels),
        MIT_FILE: license_text,
    }
    if sum(len(payload) for payload in outputs.values()) > 1_600_000:
        raise ValueError("Detailed layer exceeds the 1.6 MB uncompressed budget")
    manifest = {
        "sourceCommit": overview.COMMIT, "sourceScale": "1:10,000,000",
        "coordinateReferenceSystem": "Province geometries: WGS84 longitude/latitude (EPSG:4326)",
        "cityCoordinates": "Existing catalog rounded to 0.1 degree; GeoNames WGS84, original domestic source datum unspecified",
        "coveredCountryIds": COVERED, "provinceGeometryFeatures": len(features), "provinceLabels": 34,
        "cityLabels": len(rows), "domesticCityLabels": 370, "coordinatePositions": vertices,
        "geometryProcessing": "Keep every source polygon and ring; round coordinates to 4 decimals; no vertex simplification",
        "sources": [
            {"url": overview.BASE + ADMIN_FILE, "sha256": ADMIN_HASH, "license": "Public domain", "licenseUrl": "https://www.naturalearthdata.com/about/terms-of-use/"},
            {"url": overview.BASE + countries_file, "sha256": overview.SOURCES[countries_file], "use": "Hong Kong, Macao and Taiwan label centers"},
            {"path": CATALOG_PATH, "canonicalJsonSha256": CATALOG_HASH, "provenance": "docs/city-catalog-data.md", "licenses": ["MIT (domestic)", "CC BY 4.0 GeoNames (world)"]},
            {"url": MIT_URL, "sha256": MIT_HASH},
        ],
        "outputs": {name: {"bytes": len(payload), "gzipBytes": len(gzip.compress(payload, mtime=0)), "sha256": overview.digest(payload)} for name, payload in outputs.items()},
    }
    outputs["detail-manifest.json"] = overview.encode(manifest)
    if not args.check:
        OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, payload in outputs.items():
        destination = OUTPUT / name
        if args.check:
            if destination.read_bytes() != payload:
                raise ValueError("Committed output differs from pinned source: " + name)
        else:
            destination.write_bytes(payload)
        print("{}: {} bytes; gzip {} bytes; sha256 {}".format(name, len(payload), len(gzip.compress(payload, mtime=0)), overview.digest(payload)))
    print("Verified {} admin features, {} coordinate positions, 34 province labels and {} catalog city labels".format(len(features), vertices, len(rows)))


if __name__ == "__main__":
    main()
