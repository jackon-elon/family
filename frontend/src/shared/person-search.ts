import type { PersonView } from "../types";

const nameOrder = new Intl.Collator("zh-CN-u-co-pinyin", {
  numeric: true,
  sensitivity: "base",
});

/** Sort displayed names (including this viewer's remarks), without changing graph order. */
export function sortPeopleByName<T extends { id: string; name: string }>(people: T[]): T[] {
  return [...people].sort((a, b) => nameOrder.compare(a.name, b.name) || a.id.localeCompare(b.id));
}

/** Search only the profile data already available to the current viewer. */
export function matchesPerson(
  person: Partial<PersonView> & { originalName?: string },
  query: string,
  relationship = "",
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const values = [
    person.name,
    person.originalName,
    person.country,
    person.province,
    person.city,
    person.status,
    person.school,
    person.industry,
    person.occupation,
    person.bio,
    person.phone,
    person.wechatId,
    relationship,
  ];
  if (values.some((value) => value?.toLocaleLowerCase().includes(needle)))
    return true;
  // Pasted phone numbers often contain spaces, parentheses or dashes.
  const digits = needle.replace(/[\s()+-]/g, "");
  return (
    /^\d{3,}$/.test(digits) &&
    !!person.phone?.replace(/[\s()+-]/g, "").includes(digits)
  );
}
