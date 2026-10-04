import type * as Leaflet from "leaflet";

interface CanvasFrame {
  _map?: unknown;
  _ctx?: CanvasRenderingContext2D;
  _redrawRequest?: number | null;
}

/** Own only this map's canvas lifecycle; do not patch Leaflet globally. */
export function createMapCanvas(
  leaflet: typeof Leaflet,
  options: Leaflet.RendererOptions,
): Leaflet.Canvas {
  const redraw = (
    leaflet.Canvas.prototype as unknown as {
      _redraw: (this: CanvasFrame) => void;
    }
  )._redraw;
  const Canvas = leaflet.Canvas.extend({
    _redraw(this: CanvasFrame) {
      // Leaflet 1.9.4 also calls _redraw synchronously on map updates. Its
      // implementation clears the RAF handle without cancelling the queued
      // frame, which otherwise survives map.remove() and touches a deleted ctx.
      if (this._redrawRequest != null)
        leaflet.Util.cancelAnimFrame(this._redrawRequest);
      this._redrawRequest = null;
      if (this._map && this._ctx) redraw.call(this);
    },
  }) as typeof Leaflet.Canvas;
  return new Canvas(options);
}
