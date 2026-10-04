import type { BirthdayEvent, GuestFamilyData } from "../types";

function serverDelay(
  snapshot: Pick<GuestFamilyData, "serverTime" | "receivedAt">,
  deadline: number,
  now: number,
): number | null {
  if (
    !Number.isFinite(deadline) ||
    typeof snapshot.serverTime !== "number" ||
    !Number.isFinite(snapshot.serverTime) ||
    !Number.isFinite(snapshot.receivedAt)
  )
    return null;
  return Math.max(
    0,
    deadline - snapshot.serverTime - Math.max(0, now - snapshot.receivedAt),
  );
}

export function guestSessionDelay(
  snapshot: Pick<GuestFamilyData, "expiresAt" | "serverTime" | "receivedAt">,
  now = Date.now(),
): number {
  return (
    serverDelay(snapshot, snapshot.expiresAt, now) ??
    Math.max(0, snapshot.expiresAt - now)
  );
}

/** Count from the server's China day, even on a device with another timezone/clock. */
export function birthdayRefreshDelay(
  snapshot: Pick<GuestFamilyData, "birthdays" | "serverTime" | "receivedAt">,
  now = Date.now(),
): number | null {
  return snapshot.birthdays
    ? serverDelay(snapshot, snapshot.birthdays.refreshAt, now)
    : null;
}

export function birthdayCountdown(daysUntil: number): string {
  return daysUntil === 0
    ? "今天生日"
    : daysUntil === 1
      ? "明天生日"
      : `${daysUntil} 天后`;
}

export function occurrenceDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

export function birthdayDateDescription(event: BirthdayEvent): string {
  const [, month, day] = event.date.split("-").map(Number);
  return event.birthdayCalendar === "solar" &&
    event.birthdayText === `阳历${month}月${day}日`
    ? `阳历 · ${occurrenceDate(event.date)}`
    : `${event.birthdayText} · 本次公历：${occurrenceDate(event.date)}`;
}
