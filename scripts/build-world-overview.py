"""Build the compact world land image used behind mini-program overview dots.

Requires Pillow. Source is a pinned Natural Earth 1:110m land GeoJSON revision;
see docs/world-overview-data.md for provenance and public-domain terms.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

from PIL import Image, ImageDraw, ImageFont


SOURCE = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
    "ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_110m_land.geojson"
)
SOURCE_SHA256 = "9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9"
OUTPUT = Path(__file__).resolve().parents[1] / "miniprogram/components/person-map/world-land.png"
WIDTH, HEIGHT, SCALE = 1200, 520, 2
LAT_MIN, LAT_MAX = -60.0, 85.0


def project(lon: float, lat: float) -> tuple[float, float]:
    return ((lon + 180) / 360 * WIDTH * SCALE, (LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * HEIGHT * SCALE)


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in ("C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size * SCALE)
    return ImageFont.load_default()


def main() -> None:
    payload = urlopen(SOURCE, timeout=30).read()
    if hashlib.sha256(payload).hexdigest() != SOURCE_SHA256:
        raise RuntimeError("Natural Earth source content changed; inspect it before rebuilding")
    features = json.loads(payload)["features"]

    image = Image.new("RGB", (WIDTH * SCALE, HEIGHT * SCALE), "#e6f3f1")
    draw = ImageDraw.Draw(image)
    for lon in range(-180, 181, 45):
        x, _ = project(lon, 0)
        draw.line([(x, 0), (x, HEIGHT * SCALE)], fill="#d3e7e4", width=SCALE)
    for lat in (-60, -30, 0, 30, 60):
        _, y = project(0, lat)
        draw.line([(0, y), (WIDTH * SCALE, y)], fill="#d3e7e4", width=SCALE)

    for feature in features:
        geometry = feature["geometry"]
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        for rings in polygons:
            if max(lat for lon, lat in rings[0]) < LAT_MIN:
                continue
            exterior = [project(lon, lat) for lon, lat in rings[0]]
            draw.polygon(exterior, fill="#cce3d4")
            draw.line(exterior, fill="#7eaf9c", width=2 * SCALE, joint="curve")
            for hole in rings[1:]:
                draw.polygon([project(lon, lat) for lon, lat in hole], fill="#e6f3f1")

    labels = [
        (-103, 45, "NORTH AMERICA"), (-58, -16, "SOUTH AMERICA"),
        (17, 46, "EUROPE"), (17, 1, "AFRICA"),
        (89, 46, "ASIA"), (135, -27, "OCEANIA"),
    ]
    label_font = font(25)
    for lon, lat, label in labels:
        x, y = project(lon, lat)
        bbox = draw.textbbox((0, 0), label, font=label_font)
        draw.text((x - (bbox[2] - bbox[0]) / 2, y), label, fill="#629380", font=label_font)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS).save(OUTPUT, optimize=True)
    print(f"Created {OUTPUT} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
