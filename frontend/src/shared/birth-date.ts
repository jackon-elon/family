import type { Birthday } from "../../../backend/src/model";
import { gregorianForLunar } from "./lunar-calendar";

/** A complete birth date for age comparisons; annual birthday reminders are separate. */
export function birthDateForBirthday(
  birthday: Birthday | undefined,
): string | undefined {
  if (
    !birthday ||
    !Number.isInteger(birthday.year) ||
    birthday.year! < 1900 ||
    birthday.year! > 2100 ||
    !Number.isInteger(birthday.month) ||
    !Number.isInteger(birthday.day) ||
    birthday.month < 1 ||
    birthday.month > 12 ||
    birthday.day < 1 ||
    birthday.day > 31
  )
    return undefined;
  if (birthday.calendar === "lunar") {
    return gregorianForLunar({
      year: birthday.year!,
      month: birthday.month,
      day: birthday.day,
      leapMonth: !!birthday.leapMonth,
    });
  }
  if (birthday.calendar !== "solar" || birthday.leapMonth) return undefined;
  const date = new Date(
    Date.UTC(birthday.year!, birthday.month - 1, birthday.day),
  );
  if (
    date.getUTCFullYear() !== birthday.year ||
    date.getUTCMonth() !== birthday.month - 1 ||
    date.getUTCDate() !== birthday.day
  )
    return undefined;
  return date.toISOString().slice(0, 10);
}
