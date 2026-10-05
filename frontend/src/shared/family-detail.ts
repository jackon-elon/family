import type { FamilyUnit } from "./family-overview";
import type { StarNode, StarRelation } from "./family-layout";

export const DETAIL_CARD_WIDTH = 88;
export const DETAIL_CARD_HEIGHT = 112;

/** Expand exactly this display group; relatives in other groups stay on the overview. */
export function buildFamilyDetail(
  unit: FamilyUnit,
  relations: readonly StarRelation[],
) {
  const byId = new Map(unit.members.map((person) => [person.id, person]));
  const heads = new Set(unit.heads.map((person) => person.id));
  const lower = new Set(
    unit.members
      .filter((person) => !heads.has(person.id))
      .map((person) => person.id),
  );
  const rows = [
    { label: "这一家", ids: [...heads] },
    { label: "子女", ids: [...lower] },
  ].filter((row) => row.ids.length);
  const stepX = DETAIL_CARD_WIDTH + 12;
  const width = Math.max(
    240,
    Math.max(...rows.map((row) => row.ids.length)) * stepX + 12,
  );
  const nodes: StarNode[] = [];
  const bands = rows.map((row, index) => {
    row.ids.sort(
      (a, b) => byId.get(a)!.x - byId.get(b)!.x || a.localeCompare(b),
    );
    row.ids.forEach((id, column) =>
      nodes.push({
        ...byId.get(id)!,
        x: width / 2 + (column - (row.ids.length - 1) / 2) * stepX,
        y: 40 + index * 172,
      }),
    );
    return { label: row.label, y: 12 + index * 172 };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  const edges = relations.filter((edge) => {
    if (
      !nodeIds.has(edge.from) ||
      !nodeIds.has(edge.to) ||
      edge.from === edge.to
    )
      return false;
    const ends =
      edge.type === "parent"
        ? [edge.from, edge.to]
        : [edge.from, edge.to].sort();
    const key = JSON.stringify([edge.type, ...ends]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { nodes, edges, bands, width, height: rows.length * 172 + 8 };
}
