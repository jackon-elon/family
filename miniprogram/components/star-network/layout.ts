/** Geometry only. The same layout can be tested without a WeChat runtime. */
export interface StarPerson {
  id: string;
  name: string;
  photoUrl?: string;
}

export interface StarRelation {
  id?: string;
  from: string;
  to: string;
  type: 'parent' | 'spouse' | 'sibling';
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
  connected: boolean;
  isFocus: boolean;
  isSelf: boolean;
  tone: number;
  style: string;
}

export interface StarEdge {
  id: string;
  type: StarRelation['type'];
  style: string;
}

export interface StarOrbit { id: number; style: string }

export interface StarLayout {
  size: number;
  centerId: string;
  nodes: StarNode[];
  edges: StarEdge[];
  orbits: StarOrbit[];
  hiddenCount: number;
}

const RING_GAP = 225;
const NODE_SPACING = 175;
const MAX_VISIBLE = 160;
const COMPACT_SIZE = 650;
const COMPACT_RADIUS = 210;

function ringCapacity(ring: number): number {
  return Math.max(8, Math.floor((2 * Math.PI * RING_GAP * ring) / NODE_SPACING));
}

function toneFor(id: string): number {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n * 31 + id.charCodeAt(i)) >>> 0;
  return n % 4;
}

/** Breadth-first order puts known close relations nearest the center. */
export function buildStarLayout(
  persons: readonly StarPerson[],
  relations: readonly StarRelation[],
  focusId = '',
  selfId = '',
  relationLabels: Readonly<Record<string, string>> = {}
): StarLayout {
  const byId = new Map<string, StarPerson>();
  for (const person of persons || []) {
    if (person && typeof person.id === 'string' && person.id && !byId.has(person.id)) byId.set(person.id, person);
  }
  const all = Array.from(byId.values());
  const focus = byId.get(focusId) || byId.get(selfId) || all[0];
  if (!focus) return { size: 730, centerId: '', nodes: [], edges: [], orbits: [], hiddenCount: 0 };

  const neighbors = new Map<string, Set<string>>();
  for (const id of byId.keys()) neighbors.set(id, new Set<string>());
  for (const relation of relations || []) {
    if (!relation || relation.from === relation.to || !byId.has(relation.from) || !byId.has(relation.to)) continue;
    neighbors.get(relation.from)!.add(relation.to);
    neighbors.get(relation.to)!.add(relation.from);
  }

  const depth = new Map<string, number>([[focus.id, 0]]);
  const connected: string[] = [focus.id];
  for (let head = 0; head < connected.length; head++) {
    const source = connected[head];
    const sorted = Array.from(neighbors.get(source) || []).sort((a, b) => {
      const nameA = byId.get(a)!.name || '';
      const nameB = byId.get(b)!.name || '';
      return nameA.localeCompare(nameB, 'zh-CN') || a.localeCompare(b);
    });
    for (const target of sorted) {
      if (depth.has(target)) continue;
      depth.set(target, depth.get(source)! + 1);
      connected.push(target);
    }
  }
  const disconnected = all.filter(person => !depth.has(person.id))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN') || a.id.localeCompare(b.id))
    .map(person => person.id);
  const ordered = connected.concat(disconnected).slice(0, MAX_VISIBLE);
  const hiddenCount = all.length - ordered.length;
  const selected = new Set(ordered);

  const rings: string[][] = [];
  let maxRing = 0;
  function addToRing(id: string, preferred: number): void {
    let ring = preferred;
    while (rings[ring] && rings[ring].length >= ringCapacity(ring)) ring++;
    if (!rings[ring]) rings[ring] = [];
    rings[ring].push(id);
    maxRing = Math.max(maxRing, ring);
  }
  const compact = ordered.length <= 9;
  if (compact) {
    // A household of a few people should be readable on the first screen.
    // Links still show the recorded relationships; orbit radius need not mean kinship distance.
    if (ordered.length > 1) { rings[1] = ordered.slice(1); maxRing = 1; }
  } else {
    for (const id of ordered.slice(1)) {
      if (depth.has(id)) addToRing(id, Math.min(depth.get(id)!, 4));
    }
    const disconnectedStart = maxRing + 1;
    for (const id of disconnected) {
      if (selected.has(id)) addToRing(id, disconnectedStart || 1);
    }
  }

  const radiusStep = compact ? COMPACT_RADIUS : RING_GAP;
  const size = compact ? COMPACT_SIZE : Math.max(730, 2 * (RING_GAP * maxRing + 135));
  const center = size / 2;
  const positions = new Map<string, {x: number; y: number; ring: number}>();
  positions.set(focus.id, {x: center, y: center, ring: 0});
  for (let ring = 1; ring <= maxRing; ring++) {
    const ids = rings[ring] || [];
    for (let i = 0; i < ids.length; i++) {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / ids.length + (ring % 2 === 0 ? Math.PI / ids.length : 0);
      positions.set(ids[i], {
        x: Math.round(center + radiusStep * ring * Math.cos(angle)),
        y: Math.round(center + radiusStep * ring * Math.sin(angle)),
        ring
      });
    }
  }

  const nodes: StarNode[] = ordered.map(id => {
    const person = byId.get(id)!;
    const place = positions.get(id)!;
    const isSelf = !!selfId && id === selfId;
    return {
      id,
      name: person.name || '未命名',
      initial: (person.name || '人').slice(-1),
      photoUrl: person.photoUrl || '',
      label: isSelf ? '我' : relationLabels[id] || (depth.has(id) ? '' : '待补关系'),
      x: place.x,
      y: place.y,
      ring: place.ring,
      connected: depth.has(id),
      isFocus: id === focus.id,
      isSelf,
      tone: toneFor(id),
      style: `left:${place.x}rpx;top:${place.y}rpx;`
    };
  });

  const edges: StarEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const relation of relations || []) {
    if (!relation || !positions.has(relation.from) || !positions.has(relation.to) || relation.from === relation.to) continue;
    const a = positions.get(relation.from)!;
    const b = positions.get(relation.to)!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const key = [relation.type, relation.from < relation.to ? relation.from : relation.to, relation.from < relation.to ? relation.to : relation.from].join(':');
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({
      id: relation.id || key,
      type: relation.type,
      style: `left:${a.x}rpx;top:${a.y}rpx;width:${Math.round(Math.sqrt(dx * dx + dy * dy))}rpx;transform:rotate(${(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(2)}deg);`
    });
  }
  const orbits: StarOrbit[] = [];
  for (let ring = 1; ring <= maxRing; ring++) {
    const diameter = 2 * radiusStep * ring;
    orbits.push({id: ring, style: `left:${center - radiusStep * ring}rpx;top:${center - radiusStep * ring}rpx;width:${diameter}rpx;height:${diameter}rpx;`});
  }
  return {size, centerId: focus.id, nodes, edges, orbits, hiddenCount};
}
