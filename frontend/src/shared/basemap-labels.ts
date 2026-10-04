export interface BasemapLabel {
  name: string;
  longitude: number;
  latitude: number;
  minZoom?: number;
  maxZoom?: number;
  kind?: "country" | "region" | "ocean" | "city";
  priority?: number;
}

export interface MapLabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Keep a city and its neighboring cities visible on narrower phones. */
export function cityFocusZoom(viewportWidth: number): number {
  return viewportWidth < 480 ? 7 : 8;
}

export function basemapLabelBox(
  label: BasemapLabel,
  point: { x: number; y: number },
): MapLabelBox {
  const isCity = label.kind === "city";
  const letterSpacing = isCity ? 0 : label.kind === "ocean" ? 4 : 1;
  const textWidth = Math.max(
    20,
    [...label.name].reduce(
      (width, letter) =>
        width + (letter.charCodeAt(0) <= 0x7f ? 7 : 12) + letterSpacing,
      0,
    ),
  );
  return {
    // City names sit to the right of the small dot at their real coordinates.
    x: point.x + (isCity ? 8 + textWidth / 2 : 0),
    y: point.y,
    width: textWidth + (isCity ? 24 : 14),
    height: 26,
  };
}

/** Keep overview labels readable when neighboring countries share little space. */
export function visibleBasemapLabels(
  labels: readonly BasemapLabel[],
  zoom: number,
  project: (label: BasemapLabel) => { x: number; y: number },
  size: { x: number; y: number },
  obstacles: readonly MapLabelBox[] = [],
): BasemapLabel[] {
  const occupied: MapLabelBox[] = [...obstacles];
  return [...labels]
    .sort(
      (a, b) =>
        (b.priority ?? 0) - (a.priority ?? 0) ||
        (a.minZoom ?? 2) - (b.minZoom ?? 2),
    )
    .filter((label) => {
      if (
        zoom < (label.minZoom ?? 2) ||
        zoom > (label.maxZoom ?? (label.kind === "city" ? 9 : 6))
      )
        return false;
      const point = project(label);
      const box = basemapLabelBox(label, point);
      if (
        box.x + box.width / 2 < 0 ||
        box.x - box.width / 2 > size.x ||
        box.y + box.height / 2 < 0 ||
        box.y - box.height / 2 > size.y
      )
        return false;
      if (
        occupied.some(
          (other) =>
            Math.abs(other.x - box.x) < (other.width + box.width) / 2 &&
            Math.abs(other.y - box.y) < (other.height + box.height) / 2,
        )
      )
        return false;
      occupied.push(box);
      return true;
    });
}
