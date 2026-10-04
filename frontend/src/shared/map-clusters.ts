import type { CityGroup } from "./geography";

export interface CityMarkerCluster {
  groups: CityGroup[];
  x: number;
  y: number;
  count: number;
}

/** Aggregate city badges that would cover each other at the current map zoom. */
export function clusterCityMarkers(
  groups: readonly CityGroup[],
  project: (point: NonNullable<CityGroup["point"]>) => { x: number; y: number },
): CityMarkerCluster[] {
  const clusters = groups
    .filter((group) => group.point)
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((group) => ({
      groups: [group],
      ...project(group.point!),
      count: group.people.length,
    }));
  // Recheck after a merge because the new badge center may cover another badge.
  for (let index = 0; index < clusters.length; index++) {
    const current = clusters[index];
    for (
      let otherIndex = index + 1;
      otherIndex < clusters.length;
      otherIndex++
    ) {
      const other = clusters[otherIndex];
      if (
        Math.abs(current.x - other.x) >= 120 ||
        Math.abs(current.y - other.y) >= 44
      )
        continue;
      const size = current.groups.length + other.groups.length;
      current.x =
        (current.x * current.groups.length + other.x * other.groups.length) /
        size;
      current.y =
        (current.y * current.groups.length + other.y * other.groups.length) /
        size;
      current.groups.push(...other.groups);
      current.count += other.count;
      clusters.splice(otherIndex, 1);
      // Any earlier cluster may now overlap this new center.
      index = -1;
      break;
    }
  }
  return clusters;
}
