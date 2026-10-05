/** Web geometry excludes the large gutters used by the original mini program. */
export const GRAPH_UNIT = 0.88;
export const GRAPH_CARD = 132;
export const MIN_GRAPH_ZOOM = 0.4;
export const MAX_GRAPH_ZOOM = 1.6;

/** Family cards render at twice the personal scale; keep names at least 12px. */
export function minimumGraphZoom(hasGroups: boolean) {
  return hasGroups ? MIN_GRAPH_ZOOM : 0.75;
}

export function clampGraphZoom(zoom: number, hasGroups: boolean) {
  return Math.max(minimumGraphZoom(hasGroups), Math.min(MAX_GRAPH_ZOOM, zoom));
}

export function graphBounds(
  nodes: ReadonlyArray<{ x: number; y: number }>,
  cardWidth = GRAPH_CARD,
  cardHeight = GRAPH_CARD,
) {
  if (!nodes.length) return { left: 0, top: 0, width: 200, height: 200 };
  const left =
    Math.min(...nodes.map((n) => n.x * GRAPH_UNIT)) - cardWidth / 2 - 22;
  const top =
    Math.min(...nodes.map((n) => n.y * GRAPH_UNIT)) - cardHeight / 2 - 46;
  return {
    left,
    top,
    width:
      Math.max(...nodes.map((n) => n.x * GRAPH_UNIT)) +
      cardWidth / 2 +
      22 -
      left,
    height:
      Math.max(...nodes.map((n) => n.y * GRAPH_UNIT)) +
      cardHeight / 2 +
      22 -
      top,
  };
}

export function graphScroll(
  center: { x: number; y: number },
  zoom: number,
  bounds: { width: number; height: number },
  width: number,
  height: number,
) {
  return {
    left: Math.max(
      0,
      Math.min(bounds.width * zoom - width, center.x * zoom - width / 2),
    ),
    top: Math.max(
      0,
      Math.min(bounds.height * zoom - height, center.y * zoom - height / 2),
    ),
  };
}
