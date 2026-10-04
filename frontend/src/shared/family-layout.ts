/** Pure family graph geometry. Coordinates are rpx and each node is centered on x/y. */
export interface StarPerson {
  id: string;
  name: string;
  originalName?: string;
  photoUrl?: string;
  isDimmed?: boolean;
}
export interface StarRelation {
  id?: string;
  from: string;
  to: string;
  type: "parent" | "spouse" | "sibling";
}
export interface StarNode {
  id: string;
  name: string;
  initial: string;
  photoUrl: string;
  label: string;
  x: number;
  y: number;
  ring: number;
  generation: number | null;
  connected: boolean;
  isFocus: boolean;
  isSelf: boolean;
  isSelected: boolean;
  isDimmed: boolean;
  isConflicted: boolean;
  tone: number;
  style: string;
}
export interface StarEdge {
  id: string;
  type: StarRelation["type"];
  style: string;
}
export interface StarBand {
  id: string;
  label: string;
  y: number;
  style: string;
  isSelf: boolean;
  isUnlinked: boolean;
  markers: Array<{ id: string; style: string }>;
}
export interface StarOrbit {
  id: number;
  style: string;
}
export interface StarLayout {
  width: number;
  height: number;
  size: number;
  centerId: string;
  nodes: StarNode[];
  edges: StarEdge[];
  bands: StarBand[];
  orbits: StarOrbit[];
  hiddenCount: number;
  conflictCount: number;
}

const MAX_VISIBLE = 160;
const COLUMN_GAP = 175;
const ROW_GAP = 250;
const FIRST_ROW_Y = 180;
const SIDE_PADDING = 210; // Leave a gutter for generation labels.
const MIN_WIDTH = 690;

function nameOrder(
  byId: ReadonlyMap<string, StarPerson>,
  a: string,
  b: string,
): number {
  const left = byId.get(a);
  const right = byId.get(b);
  return (
    (left?.originalName || left?.name || "").localeCompare(
      right?.originalName || right?.name || "",
      "zh-CN",
    ) || a.localeCompare(b)
  );
}
function toneFor(id: string): number {
  let value = 0;
  for (let i = 0; i < id.length; i++)
    value = (value * 31 + id.charCodeAt(i)) >>> 0;
  return value % 4;
}
function bandLabel(level: number, anchored: boolean): string {
  if (!anchored)
    return level === 0
      ? "关系层级"
      : level < 0
        ? `上 ${-level} 代`
        : `下 ${level} 代`;
  if (level === 0) return "我的同辈";
  if (level === -1) return "父辈";
  if (level === -2) return "祖辈";
  if (level === 1) return "子辈";
  if (level === 2) return "孙辈";
  return level < 0 ? `上 ${-level} 辈` : `下 ${level} 辈`;
}

/** Keep same-generation relatives together; use placed parents to order child groups. */
function orderRow(
  ids: string[],
  byId: ReadonlyMap<string, StarPerson>,
  relations: readonly StarRelation[],
  placedX: ReadonlyMap<string, number>,
): string[] {
  const inRow = new Set(ids);
  const near = new Map(ids.map((id) => [id, new Set<string>()]));
  const parents = new Map(ids.map((id) => [id, [] as string[]]));
  for (const relation of relations) {
    if (relation.type === "parent") {
      if (inRow.has(relation.to) && placedX.has(relation.from))
        parents.get(relation.to)!.push(relation.from);
    } else if (inRow.has(relation.from) && inRow.has(relation.to)) {
      near.get(relation.from)!.add(relation.to);
      near.get(relation.to)!.add(relation.from);
    }
  }
  const anchor = (id: string): number | undefined => {
    const xs = parents
      .get(id)!
      .map((parent) => placedX.get(parent)!)
      .filter(Number.isFinite);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
  };
  const remaining = new Set(ids);
  const groups: string[][] = [];
  for (const first of [...ids].sort((a, b) => nameOrder(byId, a, b))) {
    if (!remaining.has(first)) continue;
    const group = [first];
    remaining.delete(first);
    for (let head = 0; head < group.length; head++) {
      for (const next of [...near.get(group[head])!].sort((a, b) =>
        nameOrder(byId, a, b),
      )) {
        if (remaining.delete(next)) group.push(next);
      }
    }
    // Starting at an endpoint makes a chain such as 伯父—爸爸—妈妈—姨妈 readable.
    const endpoints = group.filter((id) => near.get(id)!.size <= 1);
    const starts = (endpoints.length ? endpoints : group).sort((a, b) => {
      const ax = anchor(a);
      const bx = anchor(b);
      return ax !== undefined && bx !== undefined && ax !== bx
        ? ax - bx
        : nameOrder(byId, a, b);
    });
    const unused = new Set(group);
    const ordered: string[] = [];
    let current = starts[0];
    while (unused.size) {
      if (!unused.has(current))
        current = [...unused].sort((a, b) => nameOrder(byId, a, b))[0];
      ordered.push(current);
      unused.delete(current);
      const linked = [...near.get(current)!]
        .filter((id) => unused.has(id))
        .sort(
          (a, b) =>
            near.get(a)!.size - near.get(b)!.size || nameOrder(byId, a, b),
        );
      if (linked.length) current = linked[0];
    }
    groups.push(ordered);
  }
  const groupAnchor = (group: string[]): number | undefined => {
    const values = group
      .map(anchor)
      .filter((value): value is number => value !== undefined);
    return values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : undefined;
  };
  groups.sort((a, b) => {
    const ax = groupAnchor(a);
    const bx = groupAnchor(b);
    if (ax !== undefined && bx !== undefined && ax !== bx) return ax - bx;
    if (ax !== undefined && bx === undefined) return -1;
    if (ax === undefined && bx !== undefined) return 1;
    return nameOrder(byId, a[0], b[0]);
  });
  const result: string[] = [];
  for (const group of groups) result.push(...group);
  return result;
}

/** Parent goes one row above child; spouse and sibling remain in the same row. */
export function buildStarLayout(
  persons: readonly StarPerson[],
  relations: readonly StarRelation[],
  focusId = "",
  selfId = "",
  relationLabels: Readonly<Record<string, string>> = {},
  selectedId = "",
): StarLayout {
  const byId = new Map<string, StarPerson>();
  for (const person of persons || []) {
    if (
      person &&
      typeof person.id === "string" &&
      person.id &&
      !byId.has(person.id)
    )
      byId.set(person.id, person);
  }
  const allIds = [...byId.keys()].sort((a, b) => nameOrder(byId, a, b));
  const focus = byId.get(focusId) || byId.get(selfId);
  const anchorId = focus?.id || allIds[0];
  if (!anchorId)
    return {
      width: MIN_WIDTH,
      height: 330,
      size: MIN_WIDTH,
      centerId: "",
      nodes: [],
      edges: [],
      bands: [],
      orbits: [],
      hiddenCount: 0,
      conflictCount: 0,
    };
  const clean = (relations || [])
    .filter(
      (relation) =>
        relation &&
        byId.has(relation.from) &&
        byId.has(relation.to) &&
        relation.from !== relation.to &&
        (relation.type === "parent" ||
          relation.type === "spouse" ||
          relation.type === "sibling"),
    )
    .slice()
    .sort(
      (a, b) =>
        a.type.localeCompare(b.type) ||
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to),
    );

  // Collapse all zero-generation links first. This makes spouse/sibling equality
  // independent of relation input order and reveals impossible parent cycles.
  const union = new Map(allIds.map((id) => [id, id]));
  function find(id: string): string {
    let root = id;
    while (union.get(root) !== root) root = union.get(root)!;
    while (id !== root) {
      const next = union.get(id)!;
      union.set(id, root);
      id = next;
    }
    return root;
  }
  for (const relation of clean) {
    if (relation.type === "parent") continue;
    const a = find(relation.from);
    const b = find(relation.to);
    if (a !== b) union.set(a < b ? b : a, a < b ? a : b);
  }
  const roots = [...new Set(allIds.map(find))].sort();
  const adjacency = new Map(
    roots.map((root) => [root, [] as Array<{ to: string; delta: number }>]),
  );
  const impossible = new Set<string>();
  for (const relation of clean) {
    if (relation.type !== "parent") continue;
    const parent = find(relation.from);
    const child = find(relation.to);
    if (parent === child) {
      impossible.add(parent);
      continue;
    }
    adjacency.get(parent)!.push({ to: child, delta: 1 });
    adjacency.get(child)!.push({ to: parent, delta: -1 });
  }
  for (const links of adjacency.values())
    links.sort((a, b) => a.to.localeCompare(b.to) || a.delta - b.delta);
  const component = new Map<string, string>();
  const offset = new Map<string, number>();
  const conflicted = new Set<string>();
  for (const start of roots) {
    if (component.has(start)) continue;
    const queue = [start];
    component.set(start, start);
    offset.set(start, 0);
    for (let head = 0; head < queue.length; head++) {
      const source = queue[head];
      if (impossible.has(source)) conflicted.add(start);
      for (const link of adjacency.get(source)!) {
        const expected = offset.get(source)! + link.delta;
        if (!component.has(link.to)) {
          component.set(link.to, start);
          offset.set(link.to, expected);
          queue.push(link.to);
        } else if (offset.get(link.to) !== expected) conflicted.add(start);
      }
    }
  }
  const focusComponent = component.get(find(anchorId))!;
  const focusOffset = offset.get(find(anchorId))!;
  const anchorHasRelation = clean.some(
    (relation) => relation.from === anchorId || relation.to === anchorId,
  );
  const isConflicted = (id: string) => conflicted.has(component.get(find(id))!);
  const generation = (id: string): number | null =>
    (Boolean(focus) || anchorHasRelation) &&
    component.get(find(id)) === focusComponent &&
    !isConflicted(id)
      ? offset.get(find(id))! - focusOffset
      : null;

  const near = new Map(allIds.map((id) => [id, new Set<string>()]));
  for (const relation of clean) {
    near.get(relation.from)!.add(relation.to);
    near.get(relation.to)!.add(relation.from);
  }
  const seen = new Set<string>([anchorId]);
  const connectedOrder = [anchorId];
  for (let head = 0; head < connectedOrder.length; head++) {
    for (const next of [...near.get(connectedOrder[head])!].sort((a, b) =>
      nameOrder(byId, a, b),
    )) {
      if (!seen.has(next)) {
        seen.add(next);
        connectedOrder.push(next);
      }
    }
  }
  const selected = connectedOrder
    .concat(allIds.filter((id) => !seen.has(id)))
    .slice(0, MAX_VISIBLE);
  const selectedSet = new Set(selected);
  const rows = new Map<number, string[]>();
  const unknown: string[] = [];
  for (const id of selected) {
    const level = generation(id);
    if (level === null) unknown.push(id);
    else {
      const row = rows.get(level) || [];
      row.push(id);
      rows.set(level, row);
    }
  }
  const levels = [...rows.keys()].sort((a, b) => a - b);
  // A new member may not yet be linked to the existing family. Keep each other
  // connected family's known parent/child rows, without inferring its relation
  // to this member. Only genuinely isolated or conflicting nodes share the
  // pending row below these independent branches.
  const branches = new Map<string, string[]>();
  const pending: string[] = [];
  for (const id of unknown) {
    if (isConflicted(id) || !near.get(id)!.size) {
      pending.push(id);
      continue;
    }
    const key = component.get(find(id))!;
    const branch = branches.get(key) || [];
    branch.push(id);
    branches.set(key, branch);
  }
  const branchRows: Array<{ id: string; people: string[]; label: string }> = [];
  [...branches.entries()].forEach(([key, ids], branchIndex) => {
    const localRows = new Map<number, string[]>();
    for (const id of ids) {
      const level = offset.get(find(id))!;
      const row = localRows.get(level) || [];
      row.push(id);
      localRows.set(level, row);
    }
    const localLevels = [...localRows.keys()].sort((a, b) => a - b);
    for (const level of localLevels) {
      branchRows.push({
        id: `branch-${key}-${level}`,
        people: localRows.get(level)!,
        label: `家人分组 ${branchIndex + 1} · 第 ${level - localLevels[0] + 1} 代${focus ? " · 与我关系待补充" : ""}`,
      });
    }
  });
  const rowCount = levels.length + branchRows.length + (pending.length ? 1 : 0);
  const maxRowLength = Math.max(
    1,
    ...[...rows.values()].map((row) => row.length),
    ...branchRows.map((row) => row.people.length),
    pending.length,
  );
  const width = Math.max(
    MIN_WIDTH,
    (maxRowLength - 1) * COLUMN_GAP + SIDE_PADDING * 2,
  );
  const height = FIRST_ROW_Y + Math.max(0, rowCount - 1) * ROW_GAP + 180;
  const positions = new Map<
    string,
    { x: number; y: number; level: number | null }
  >();
  const placedX = new Map<string, number>();
  const bands: StarBand[] = [];
  function place(
    ids: string[],
    index: number,
    level: number | null,
    label: string,
    bandId = level === null ? "unknown" : `generation-${level}`,
  ): void {
    const y = FIRST_ROW_Y + index * ROW_GAP;
    const sorted = orderRow(ids, byId, clean, placedX);
    const left = (width - (sorted.length - 1) * COLUMN_GAP) / 2;
    for (let col = 0; col < sorted.length; col++) {
      const x = Math.round(left + col * COLUMN_GAP);
      positions.set(sorted[col], { x, y, level });
      placedX.set(sorted[col], x);
    }
    const markers: StarBand["markers"] = [];
    for (let x = 300; x < width; x += 620) {
      markers.push({ id: `${index}-${x}`, style: `left:${x}rpx;top:17rpx;` });
    }
    bands.push({
      id: bandId,
      label,
      y,
      // Keep the generation heading in the gap above the person's card.
      // The heading is about 34rpx tall and the card starts at y - 87rpx.
      style: `left:0;top:${y - 145}rpx;width:${width}rpx;height:235rpx;`,
      isSelf: level === 0 && !!selfId && byId.has(selfId),
      isUnlinked: level === null,
      markers,
    });
  }
  levels.forEach((level, index) =>
    place(
      rows.get(level)!,
      index,
      level,
      focus ? bandLabel(level, true) : `第 ${index + 1} 代`,
    ),
  );
  branchRows.forEach((row, index) =>
    place(row.people, levels.length + index, null, row.label, row.id),
  );
  if (pending.length) {
    const hasConflict = pending.some(isConflicted);
    const hasMissing = pending.some((id) => !isConflicted(id));
    place(
      pending,
      levels.length + branchRows.length,
      null,
      hasConflict && hasMissing
        ? "关系待补充／核实"
        : hasConflict
          ? "待核实关系"
          : "关系待补充",
    );
  }
  const nodes: StarNode[] = selected.map((id) => {
    const person = byId.get(id)!;
    const point = positions.get(id)!;
    const self = !!selfId && id === selfId;
    const bad = isConflicted(id);
    const connected = component.get(find(id)) === focusComponent;
    return {
      id,
      name: person.name || "未命名",
      initial: (person.name || "人").slice(-1),
      photoUrl: person.photoUrl || "",
      label: self
        ? "我"
        : bad
          ? "待核实关系"
          : !focus
            ? near.get(id)!.size
              ? "家人"
              : "关系待补充"
            : point.level !== null && connected
              ? relationLabels[id] || ""
              : "关系待补充",
      x: point.x,
      y: point.y,
      ring: point.level ?? 99,
      generation: point.level,
      connected,
      isFocus: !!focus && id === focus.id,
      isSelf: self,
      isSelected: !!selectedId && id === selectedId,
      isDimmed: !!person.isDimmed,
      isConflicted: bad,
      tone: toneFor(id),
      style: `left:${point.x}rpx;top:${point.y}rpx;`,
    };
  });
  const edges: StarEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const relation of clean) {
    if (!selectedSet.has(relation.from) || !selectedSet.has(relation.to))
      continue;
    const a = positions.get(relation.from)!;
    const b = positions.get(relation.to)!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const ends = [relation.from, relation.to].sort();
    const key = `${relation.type}:${ends[0]}:${ends[1]}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({
      id: relation.id || key,
      type: relation.type,
      style: `left:${a.x}rpx;top:${a.y}rpx;width:${Math.round(Math.hypot(dx, dy))}rpx;transform:rotate(${((Math.atan2(dy, dx) * 180) / Math.PI).toFixed(2)}deg);`,
    });
  }
  return {
    width,
    height,
    size: Math.max(width, height),
    centerId: focus?.id || "",
    nodes,
    edges,
    bands,
    orbits: [],
    hiddenCount: allIds.length - selected.length,
    conflictCount: nodes.filter((node) => node.isConflicted).length,
  };
}
