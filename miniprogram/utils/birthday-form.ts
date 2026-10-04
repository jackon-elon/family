const SOLAR_MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function birthdayDayOptions(calendarIndex: number, monthIndex: number, yearText: string): string[] {
  let count = 31;
  if (calendarIndex === 1) count = 30;
  else if (monthIndex >= 0 && monthIndex < 12) {
    count = SOLAR_MONTH_DAYS[monthIndex];
    if (monthIndex === 1 && /^\d{4}$/.test(yearText)) {
      const year = Number(yearText);
      count = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
    }
  }
  return Array.from({length: count}, (_, index) => `${index + 1} 日`);
}

export function birthdayDayIndex(currentIndex: number, options: string[]): number {
  return currentIndex >= 0 && currentIndex < options.length ? currentIndex : -1;
}
