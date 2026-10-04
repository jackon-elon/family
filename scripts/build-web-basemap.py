"""Rebuild the bundled web overview map using Python 3.8+ standard library.

Pinned public-domain Natural Earth 1:50m data. This downloads vector source
files only, never map tiles. With --source-dir the rebuild works offline.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "frontend/src/assets/basemap"
COMMIT = "ca96624a56bd078437bca8184e78163e5039ad19"
BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/" + COMMIT + "/geojson/"
SOURCES = {
    "ne_50m_admin_0_countries.geojson": "3e458fc036ad0a66411f2c1e6cac49c5d7bfb81cb1123bc513b22511a2b7fdeb",
    "ne_50m_land.geojson": "e874b27a51d146452be360cafb3cc50c86001074a67d534113e6534682f9826b",
}
DECIMALS = 4


def digest(payload):
    return hashlib.sha256(payload).hexdigest()


def encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")


def rings(geometry):
    if geometry["type"] == "Polygon":
        polygons = [geometry["coordinates"]]
    elif geometry["type"] == "MultiPolygon":
        polygons = geometry["coordinates"]
    else:
        raise ValueError("Only Polygon/MultiPolygon geometry is expected")
    if not polygons:
        raise ValueError("Empty polygon geometry")
    for polygon in polygons:
        if not polygon:
            raise ValueError("Polygon has no exterior ring")
        for ring in polygon:
            yield ring


def validate_geometry(geometry):
    count = 0
    for ring in rings(geometry):
        if len(ring) < 4 or ring[0] != ring[-1]:
            raise ValueError("Polygon ring must be closed and contain at least four positions")
        if len({tuple(point) for point in ring}) < 3:
            raise ValueError("Polygon ring has fewer than three distinct positions")
        for point in ring:
            if len(point) != 2 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in point):
                raise ValueError("Expected finite WGS84 longitude/latitude positions")
            if abs(point[0]) > 180 or abs(point[1]) > 90:
                raise ValueError("Coordinate outside WGS84 longitude/latitude bounds")
        if abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:]))) < 1e-12:
            raise ValueError("Degenerate zero-area ring")
        count += len(ring)
    return count


def round_coordinates(value):
    if isinstance(value, list):
        return [round_coordinates(item) for item in value]
    rounded = round(value, DECIMALS)
    return int(rounded) if rounded == int(rounded) else rounded


def read_source(filename, expected, source_dir):
    if source_dir:
        payload = (source_dir / filename).read_bytes()
    else:
        request = Request(BASE + filename, headers={"User-Agent": "renjian-xingtu-basemap-build/1"})
        payload = urlopen(request, timeout=60).read()
    if digest(payload) != expected:
        raise ValueError("Source SHA256 mismatch: " + filename)
    data = json.loads(payload)
    if data.get("type") != "FeatureCollection":
        raise ValueError("Expected a GeoJSON FeatureCollection: " + filename)
    for feature in data["features"]:
        validate_geometry(feature["geometry"])
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, help="Directory containing both pinned source files; no network is used")
    parser.add_argument("--check", action="store_true", help="Verify committed output is exactly reproducible without modifying it")
    args = parser.parse_args()
    source = {name: read_source(name, checksum, args.source_dir) for name, checksum in SOURCES.items()}
    countries = source["ne_50m_admin_0_countries.geojson"]["features"]
    features, labels = [], []
    ids = set()
    vertices = 0
    for item in sorted(countries, key=lambda feature: feature["properties"]["ADM0_A3"]):
        properties = item["properties"]
        identity, name = properties["ADM0_A3"], properties["NAME_ZH"]
        if not isinstance(name, str) or not name or identity in ids:
            raise ValueError("Missing Chinese label or duplicate feature ID")
        ids.add(identity)
        geometry = {"type": item["geometry"]["type"], "coordinates": round_coordinates(item["geometry"]["coordinates"])}
        vertices += validate_geometry(geometry)
        features.append({"type": "Feature", "properties": {"name": name, "id": identity}, "geometry": geometry})
        longitude, latitude = properties["LABEL_X"], properties["LABEL_Y"]
        if not math.isfinite(longitude) or not math.isfinite(latitude) or abs(longitude) > 180 or abs(latitude) > 90:
            raise ValueError("Invalid source label center")
        labels.append({
            "name": name,
            "longitude": round(longitude, DECIMALS),
            "latitude": round(latitude, DECIMALS),
            "minZoom": min(6, max(2, math.ceil(properties["MIN_LABEL"]) + 1)),
            "kind": "country",
        })
    outputs = {
        "world.json": encode({"type": "FeatureCollection", "features": features}),
        "labels.json": encode(labels),
    }
    if sum(len(payload) for payload in outputs.values()) > 2_000_000:
        raise ValueError("Overview data exceeds the 2 MB uncompressed payload budget")
    manifest = {
        "sourceCommit": COMMIT,
        "license": "Public domain",
        "licenseUrl": "https://www.naturalearthdata.com/about/terms-of-use/",
        "coordinateReferenceSystem": "WGS84 longitude/latitude (EPSG:4326)",
        "coordinateDecimals": DECIMALS,
        "sourceScale": "1:50,000,000",
        "sources": [{"url": BASE + name, "sha256": checksum} for name, checksum in SOURCES.items()],
        "features": len(features),
        "coordinatePositions": vertices,
        "rings": sum(1 for feature in features for _ in rings(feature["geometry"])),
        "labels": len(labels),
        "outputs": {name: {"bytes": len(payload), "sha256": digest(payload)} for name, payload in outputs.items()},
    }
    outputs["manifest.json"] = encode(manifest)
    if not args.check:
        OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, payload in outputs.items():
        destination = OUTPUT / name
        if args.check:
            if destination.read_bytes() != payload:
                raise ValueError("Committed output differs from pinned source: " + name)
        else:
            destination.write_bytes(payload)
        print("{}: {} bytes; gzip {} bytes; sha256 {}".format(name, len(payload), len(gzip.compress(payload, mtime=0)), digest(payload)))
    print("Verified {} features, {} rings, {} WGS84 positions, {} labels".format(
        len(features), manifest["rings"], vertices, len(labels)))


if __name__ == "__main__":
    main()
