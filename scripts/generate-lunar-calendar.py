"""Regenerate the compact Chinese lunar month table from HKO official text files.

The generated source is checked in so the mini program can convert birthdays
offline. Run intentionally, then inspect the diff before updating the data.
Source: https://www.hko.gov.hk/tc/gts/time/conversion1_text.htm
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from urllib.request import urlopen
from tempfile import gettempdir
import ssl
import re

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / "packages" / "lunar-calendar" / "src" / "index.ts"
YEARS = range(1901, 2101)
CACHE = Path(gettempdir()) / "family-class-hko-lunar-cache"
MONTHS = {name: number for number, name in enumerate(
    ("正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"), 1
)}
ROW = re.compile(r"^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\S+)")


def load_year(year: int) -> tuple[int, list[tuple[date, str]]]:
    url = f"https://www.hko.gov.hk/tc/gts/time/calendar/text/files/T{year}c.txt"
    cached = CACHE / f"T{year}c.txt"
    if cached.exists():
        content = cached.read_text(encoding="utf-8-sig")
    else:
        try:
            import certifi  # type: ignore
            context = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            context = ssl.create_default_context()
        with urlopen(url, timeout=30, context=context) as response:
            content = response.read().decode("utf-8-sig")
        CACHE.mkdir(parents=True, exist_ok=True)
        cached.write_text(content, encoding="utf-8")
    rows: list[tuple[date, str]] = []
    for line in content.splitlines():
        match = ROW.match(line.strip())
        if match:
            rows.append((date(*map(int, match.group(1, 2, 3))), match.group(4)))
    expected = 366 if date(year, 12, 31).timetuple().tm_yday == 366 else 365
    if len(rows) != expected or rows[0][0] != date(year, 1, 1) or rows[-1][0] != date(year, 12, 31):
        raise ValueError(f"HKO {year}: expected {expected} complete daily rows; got {len(rows)}")
    for index in range(1, len(rows)):
        if rows[index][0] != rows[index - 1][0] + timedelta(days=1):
            raise ValueError(f"HKO {year}: calendar gap at {rows[index][0]}")
    return year, rows


def main() -> None:
    with ThreadPoolExecutor(max_workers=8) as pool:
        year_rows = dict(pool.map(load_year, YEARS))
    # HKO starts its published table on 1901-01-01, marked lunar 11th day
    # of the prior year's 11th month. Derive that month's first day so all
    # published dates in 1901 are covered too.
    if year_rows[1901][0] != (date(1901, 1, 1), "十一"):
        raise ValueError("HKO 1901 opening day changed")
    starts: list[tuple[int, int, int]] = [(19001222, 1900, 11)]
    previous_day: date | None = None
    for gregorian_year in YEARS:
        lunar_year = gregorian_year - 1
        for current, label in year_rows[gregorian_year]:
            if previous_day is not None and current != previous_day + timedelta(days=1):
                raise ValueError(f"HKO calendar gap at {current}")
            previous_day = current
            if not label.endswith("月"):
                continue
            leap = label.startswith("閏")
            plain_label = label[1:] if leap else label
            plain_label = plain_label[:-1] if plain_label.endswith("月") else plain_label
            month = MONTHS.get(plain_label)
            if month is None:
                continue
            if month == 1 and not leap:
                lunar_year = gregorian_year
            encoded_month = month + (12 if leap else 0)
            starts.append((current.year * 10000 + current.month * 100 + current.day,
                           lunar_year, encoded_month))
    if not any(row == (20270206, 2027, 1) for row in starts):
        raise ValueError("HKO 2027 lunar new year regression")
    for earlier, later in zip(starts, starts[1:]):
        a = date(earlier[0] // 10000, earlier[0] // 100 % 100, earlier[0] % 100)
        b = date(later[0] // 10000, later[0] // 100 % 100, later[0] % 100)
        if (b - a).days not in (29, 30):
            raise ValueError(f"Invalid lunar month length: {earlier} to {later}")
    header = """// Generated from Hong Kong Observatory Gregorian-Lunar conversion tables (1901-2100).
// Source: https://www.hko.gov.hk/tc/gts/time/conversion1_text.htm
// Do not hand-edit month boundaries; run scripts/generate-lunar-calendar.py.
// Each row: Gregorian YYYYMMDD, lunar year, lunar month (13-24 means leap 1-12).
const STARTS: ReadonlyArray<readonly [number, number, number]> = [
"""
    rows = "\n".join(f"  [{day}, {lunar_year}, {month}]," for day, lunar_year, month in starts)
    footer = """
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const LAST_SUPPORTED_DAY = 21001231;

export interface LunarDate {
  year: number;
  month: number;
  day: number;
  leapMonth: boolean;
}

function utcDay(number: number): number {
  return Date.UTC(Math.floor(number / 10000), Math.floor(number / 100) % 100 - 1, number % 100);
}

/** Convert a Beijing civil date using the HKO table; undefined outside coverage. */
export function lunarForGregorian(isoDate: string): LunarDate | undefined {
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(isoDate)) return undefined;
  const number = Number(isoDate.replace(/-/g, ''));
  if (number < STARTS[0][0] || number > LAST_SUPPORTED_DAY) return undefined;
  const time = utcDay(number);
  if (new Date(time).toISOString().slice(0, 10) !== isoDate) return undefined;
  let low = 0;
  let high = STARTS.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (STARTS[mid][0] <= number) low = mid + 1;
    else high = mid - 1;
  }
  const [start, year, encodedMonth] = STARTS[high];
  const day = Math.floor((time - utcDay(start)) / MS_PER_DAY) + 1;
  if (day < 1 || day > 30) return undefined;
  return {year, month: encodedMonth > 12 ? encodedMonth - 12 : encodedMonth,
    day, leapMonth: encodedMonth > 12};
}

/** Convert the actual lunar date, never a birthday observance in another year. */
export function gregorianForLunar(lunar: LunarDate): string | undefined {
  if (!Number.isInteger(lunar.year) || !Number.isInteger(lunar.month) || !Number.isInteger(lunar.day) ||
      lunar.month < 1 || lunar.month > 12 || lunar.day < 1 || lunar.day > 30 || typeof lunar.leapMonth !== 'boolean') return undefined;
  let low = 0;
  let high = STARTS.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (STARTS[mid][1] < lunar.year) low = mid + 1;
    else high = mid;
  }
  const encodedMonth = lunar.month + (lunar.leapMonth ? 12 : 0);
  for (let index = low; index < STARTS.length && STARTS[index][1] === lunar.year; index++) {
    if (STARTS[index][2] !== encodedMonth) continue;
    const date = new Date(utcDay(STARTS[index][0]) + (lunar.day - 1) * MS_PER_DAY).toISOString().slice(0, 10);
    const checked = lunarForGregorian(date);
    // Reject nonexistent leap months, a 30th day in a short month and dates
    // beyond the published table. Age calculations must not use fallbacks.
    return checked?.year === lunar.year && checked.month === lunar.month && checked.day === lunar.day &&
      checked.leapMonth === lunar.leapMonth ? date : undefined;
  }
  return undefined;
}
"""
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(header + rows + footer, encoding="utf-8")
    print(f"Wrote {TARGET} with {len(starts)} official lunar month starts")


if __name__ == "__main__":
    main()
