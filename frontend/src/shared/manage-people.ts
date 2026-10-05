import type { PersonView, Relation } from "../types";

export function needsPhoto(person: Pick<PersonView, "hasPhoto" | "photoUrl">) {
  return !person.hasPhoto && !person.photoUrl;
}

export function relationSentence(
  relation: Pick<Relation, "from" | "to" | "type">,
  people: Pick<PersonView, "id" | "name" | "gender">[],
) {
  const from = people.find((person) => person.id === relation.from);
  const to = people.find((person) => person.id === relation.to);
  const role =
    relation.type === "parent"
      ? from?.gender === "male"
        ? "父亲"
        : from?.gender === "female"
          ? "母亲"
          : "父母"
      : relation.type === "spouse"
        ? "配偶"
        : "兄弟姐妹";
  return `${from?.name || "家人"} 是 ${to?.name || "家人"} 的 ${role}`;
}
