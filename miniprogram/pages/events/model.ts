export interface BirthdayEvent {
  personId: string;
  personName: string;
  circleId: string;
  circleName: string;
  /** The next occurrence, expressed as a local calendar date. */
  date: string;
  daysUntil: number;
  birthdayCalendar: 'solar' | 'lunar';
  /** The recorded month and day in the person's chosen calendar. */
  birthdayText: string;
}

export interface BirthdayRow extends BirthdayEvent {
  dateLabel: string;
  countdownLabel: string;
  sourceLabel: string;
  initial: string;
}

export function birthdayRows(events: BirthdayEvent[]): BirthdayRow[] {
  return events
    .filter(event => !!event.personId && !!event.circleId && /^\d{4}-\d{2}-\d{2}$/.test(event.date) && Number.isInteger(event.daysUntil) && event.daysUntil >= 0)
    .slice()
    .sort((a, b) => a.daysUntil - b.daysUntil || a.date.localeCompare(b.date) || a.personName.localeCompare(b.personName, 'zh-CN'))
    .map(event => {
      const calendar = event.birthdayCalendar === 'lunar' ? '农历' : '阳历';
      const original = (event.birthdayText || '').trim();
      const sourceLabel = original ? (/^(农历|阳历)/.test(original) ? original : `${calendar} ${original}`) : calendar;
      return {
        ...event,
        dateLabel: `${Number(event.date.slice(5, 7))}月${Number(event.date.slice(8, 10))}日`,
        countdownLabel: event.daysUntil === 0 ? '今天' : event.daysUntil === 1 ? '明天' : `${event.daysUntil} 天后`,
        sourceLabel,
        initial: (event.personName || '人').slice(-1)
      };
    });
}
