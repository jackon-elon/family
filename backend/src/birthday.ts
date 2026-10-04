import type { Birthday } from './model';
import {lunarForGregorian} from './lunar-calendar';

export interface BirthdayOccurrence { date: string; daysUntil: number; birthdayText: string }
interface CalendarDay {
  date: string;
  daysUntil: number;
  solarYear: number;
  solarMonth: number;
  solarDay: number;
  lunarYear?: number;
  lunarMonth?: number;
  lunarDay?: number;
  lunarLeap?: boolean;
}

const DAY = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;

/** Build once per request, then reuse for all people in the requested circles. */
export class BirthdayCalendar {
  private readonly days: CalendarDay[] = [];
  private readonly lunarMonths = new Map<string, {lastDay: number; leapLastDay: number; hasLeap: boolean}>();

  constructor(now: number, daysAhead: number, needLunar: boolean) {
    const local = new Date(now + BEIJING_OFFSET);
    const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 12);
    // Include surrounding Chinese years so leap-month and 29-day fallbacks
    // depend on the whole lunar year, rather than only on the next 30 days.
    for (let offset = needLunar ? -390 : 0; offset <= daysAhead + (needLunar ? 390 : 0); offset++) {
      const date = new Date(start + offset * DAY);
      const day: CalendarDay = {
        date: date.toISOString().slice(0, 10), daysUntil: offset,
        solarYear: date.getUTCFullYear(), solarMonth: date.getUTCMonth() + 1, solarDay: date.getUTCDate()
      };
      if (needLunar) {
        const lunar = lunarForGregorian(day.date);
        if (!lunar) {
          if (offset >= 0 && offset <= daysAhead) throw new Error('LUNAR_CALENDAR_UNAVAILABLE');
          continue;
        }
        day.lunarYear = lunar.year;
        day.lunarMonth = lunar.month;
        day.lunarDay = lunar.day;
        day.lunarLeap = lunar.leapMonth;
        const key = `${day.lunarYear}/${day.lunarMonth}`;
        const aggregate = this.lunarMonths.get(key) ?? {lastDay: 0, leapLastDay: 0, hasLeap: false};
        if (day.lunarLeap) { aggregate.hasLeap = true; aggregate.leapLastDay = Math.max(aggregate.leapLastDay, day.lunarDay); }
        else aggregate.lastDay = Math.max(aggregate.lastDay, day.lunarDay);
        this.lunarMonths.set(key, aggregate);
      }
      if (offset >= 0 && offset <= daysAhead) this.days.push(day);
    }
  }

  next(birthday: Birthday): BirthdayOccurrence | undefined {
    const birthdayText = birthday.calendar === 'solar'
      ? `阳历${birthday.month}月${birthday.day}日`
      : `农历${birthday.leapMonth ? '闰' : ''}${birthday.month}月${birthday.day}日`;
    for (const day of this.days) {
      if (birthday.calendar === 'solar') {
        const leapDayFallback = birthday.month === 2 && birthday.day === 29 &&
          day.solarMonth === 2 && day.solarDay === 28 &&
          new Date(Date.UTC(day.solarYear, 1, 29)).getUTCMonth() !== 1;
        if ((day.solarMonth === birthday.month && day.solarDay === birthday.day) || leapDayFallback) {
          return {date: day.date, daysUntil: day.daysUntil, birthdayText};
        }
        continue;
      }
      if (day.lunarMonth !== birthday.month || day.lunarYear === undefined) continue;
      const month = this.lunarMonths.get(`${day.lunarYear}/${birthday.month}`);
      const expectedLeap = Boolean(birthday.leapMonth && month?.hasLeap);
      if (Boolean(day.lunarLeap) !== expectedLeap) continue;
      // A 30th day does not exist in every lunar month. Observe it on the 29th
      // when this year's matching month is short.
      const monthLastDay = day.lunarLeap ? month?.leapLastDay : month?.lastDay;
      const actualDay = birthday.day === 30 && monthLastDay === 29 ? 29 : birthday.day;
      if (day.lunarDay === actualDay) return {date: day.date, daysUntil: day.daysUntil, birthdayText};
    }
    return undefined;
  }
}
