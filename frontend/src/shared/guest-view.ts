import type { FamilyBrowseData, GuestFamilyData } from "../types";

/** Guest browsing has no current member, private remarks or management state. */
export function guestBrowseData(snapshot: GuestFamilyData): FamilyBrowseData {
  return {
    circle: { id: snapshot.family.id, name: snapshot.family.name },
    people: snapshot.persons.map((person) => ({ ...person, isSelf: false })),
    relations: snapshot.relations,
    remarks: {},
  };
}
