import type { StarNode, StarRelation } from "./family-layout";

export interface FamilyUnit {
  id: string;
  heads: StarNode[];
  members: StarNode[];
  title: string;
  x: number;
  y: number;
  isSelf: boolean;
  isDimmed: boolean;
}
export const FAMILY_CARD_WIDTH = 224;
export const FAMILY_CARD_HEIGHT = 142;

/** Conservative, disjoint display groups. These never create stored relatives. */
export function buildFamilyOverview(
  nodes: readonly StarNode[],
  relations: readonly StarRelation[],
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const partners = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  const parents = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  const hasChildren = new Set<string>();
  const allParents = new Map<string, Set<string>>();
  // Include links beyond the visible 160-person window: an omitted spouse or
  // parent must not make an ambiguous family look safe to merge.
  for (const edge of relations) {
    if (edge.from === edge.to) continue;
    if (edge.type === "spouse") {
      partners.get(edge.from)?.add(edge.to);
      partners.get(edge.to)?.add(edge.from);
    } else if (edge.type === "parent") {
      parents.get(edge.to)?.add(edge.from);
      hasChildren.add(edge.from);
      const recorded = allParents.get(edge.to) || new Set<string>();
      recorded.add(edge.from);
      allParents.set(edge.to, recorded);
    }
  }
  const units: FamilyUnit[] = [];
  const personUnit = new Map<string, string>();
  const makeUnit = (heads: StarNode[]) => {
    const id = `family:${JSON.stringify(heads.map((node) => node.id).sort())}`;
    const unit: FamilyUnit = {
      id,
      heads,
      members: [...heads],
      title: "",
      x: 0,
      y: 0,
      isSelf: false,
      isDimmed: false,
    };
    units.push(unit);
    heads.forEach((node) => personUnit.set(node.id, id));
    return unit;
  };
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const safe = (node: StarNode) => !node.isConflicted;
  const coParents = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const recorded of allParents.values()) {
    // More than two recorded parents is ambiguous; record all alternatives so
    // another child cannot accidentally make the same parent look exclusive.
    for (const a of recorded)
      for (const b of recorded) if (a !== b) coParents.get(a)?.add(b);
  }
  for (const node of ordered) {
    if (personUnit.has(node.id) || !safe(node)) continue;
    const spouseIds = [...partners.get(node.id)!];
    const spouse = spouseIds.length === 1 ? byId.get(spouseIds[0]) : undefined;
    if (
      spouse &&
      safe(spouse) &&
      partners.get(spouse.id)?.size === 1 &&
      node.y === spouse.y &&
      !personUnit.has(spouse.id)
    )
      makeUnit(
        [node, spouse].sort((a, b) => a.x - b.x || a.id.localeCompare(b.id)),
      );
  }
  // Explicit shared parenthood can form a display group without inventing a
  // marriage. Do not merge it with a different partner or a second co-parent.
  for (const node of ordered) {
    if (personUnit.has(node.id) || !safe(node) || partners.get(node.id)!.size)
      continue;
    const ids = [...coParents.get(node.id)!];
    const other = ids.length === 1 ? byId.get(ids[0]) : undefined;
    if (
      other &&
      safe(other) &&
      !personUnit.has(other.id) &&
      !partners.get(other.id)!.size &&
      coParents.get(other.id)!.size === 1 &&
      node.y === other.y
    )
      makeUnit(
        [node, other].sort((a, b) => a.x - b.x || a.id.localeCompare(b.id)),
      );
  }
  for (const node of ordered) {
    if (
      !personUnit.has(node.id) &&
      (hasChildren.has(node.id) ||
        partners.get(node.id)!.size > 0 ||
        !safe(node))
    )
      makeUnit([node]);
  }
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  for (const node of ordered) {
    if (personUnit.has(node.id)) continue;
    const recordedParents = [...parents.get(node.id)!];
    const candidateId = personUnit.get(recordedParents[0]);
    const candidate = candidateId ? unitById.get(candidateId) : undefined;
    // Every head must actually be a recorded parent: a parent's spouse is NOT
    // automatically this child's other parent. Half/step families stay linked.
    if (
      candidate &&
      recordedParents.length === candidate.heads.length &&
      candidate.heads.every(
        (head) =>
          recordedParents.includes(head.id) &&
          safe(head) &&
          partners.get(head.id)!.size <= 1 &&
          node.y > head.y,
      )
    ) {
      candidate.members.push(node);
      personUnit.set(node.id, candidate.id);
    } else makeUnit([node]);
  }
  const rows = new Map<number, FamilyUnit[]>();
  for (const unit of units) {
    unit.title =
      unit.heads.map((head) => head.name).join("、") +
      (unit.heads.length === 2 &&
      !partners.get(unit.heads[0].id)!.has(unit.heads[1].id)
        ? "与子女"
        : unit.members.length > 1
          ? "一家"
          : "");
    unit.isSelf = unit.members.some((node) => node.isSelf);
    unit.isDimmed = unit.members.every((node) => node.isDimmed);
    const row = Math.min(...unit.heads.map((node) => node.y));
    rows.set(row, [...(rows.get(row) || []), unit]);
  }
  const widestRow = Math.max(1, ...[...rows.values()].map((row) => row.length));
  [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .forEach(([, row], rowIndex) => {
      row.sort(
        (a, b) => a.heads[0].x - b.heads[0].x || a.id.localeCompare(b.id),
      );
      row.forEach((unit, index) => {
        unit.x = 180 + ((widestRow - row.length) / 2 + index) * 290;
        unit.y = 180 + rowIndex * 240;
      });
    });
  const edges: StarRelation[] = [];
  const seen = new Set<string>();
  for (const edge of relations) {
    const from = personUnit.get(edge.from),
      to = personUnit.get(edge.to);
    if (!from || !to || from === to) continue;
    const endpoints = edge.type === "parent" ? [from, to] : [from, to].sort();
    const key = JSON.stringify([edge.type, ...endpoints]);
    if (!seen.has(key)) {
      seen.add(key);
      edges.push({
        id: key,
        from: endpoints[0],
        to: endpoints[1],
        type: edge.type,
      });
    }
  }
  // Align parents over their own children's families instead of centering
  // every sparse row over the entire clan (which leaves a blank screen above
  // an off-centre branch on phones).
  const positioned = new Map(units.map((unit) => [unit.id, unit]));
  for (const [, row] of [...rows.entries()].sort(([a], [b]) => b - a)) {
    const targets = new Map(
      row.map((unit) => {
        const children = [
          ...new Set(
            edges
              .filter((edge) => edge.type === "parent" && edge.from === unit.id)
              .map((edge) => edge.to),
          ),
        ]
          .map((id) => positioned.get(id)!)
          .filter((child) => child.y > unit.y);
        return [
          unit.id,
          children.length
            ? children.reduce((sum, child) => sum + child.x, 0) /
              children.length
            : unit.x,
        ];
      }),
    );
    row.sort(
      (a, b) =>
        targets.get(a.id)! - targets.get(b.id)! || a.id.localeCompare(b.id),
    );
    let previous = -Infinity;
    for (const unit of row) {
      unit.x = Math.max(targets.get(unit.id)!, previous + 290);
      previous = unit.x;
    }
    const shift =
      row.reduce((sum, unit) => sum + targets.get(unit.id)! - unit.x, 0) /
      row.length;
    row.forEach((unit) => {
      unit.x += shift;
    });
  }
  return {
    nodes: units,
    edges,
    personUnit,
    hasGroups: units.some((unit) => unit.members.length > 1),
  };
}

/** Hysteresis uses projected name size + actual viewport space, not headcount. */
export function shouldShowFamilies(
  wasCollapsed: boolean,
  zoom: number,
  bounds: { width: number; height: number },
  viewport: { width: number; height: number },
  hasGroups: boolean,
) {
  if (!hasGroups) return false;
  const namePixels = 16 * zoom;
  if (wasCollapsed) return namePixels < 12;
  const crowded =
    bounds.width * zoom > viewport.width ||
    bounds.height * zoom > viewport.height;
  return namePixels < 8 || (namePixels < 11 && crowded);
}
