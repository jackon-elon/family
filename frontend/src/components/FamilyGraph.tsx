import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Minus, Plus, Scan, LocateFixed, Expand, Shrink } from "lucide-react";
import { buildStarLayout } from "../shared/family-layout";
import type {
  Person as StoredPerson,
  Relation as StoredRelation,
} from "../../../backend/src/model";
import {
  graphBounds,
  graphFit,
  graphScroll,
  GRAPH_UNIT as UNIT,
  MIN_GRAPH_ZOOM,
  MAX_GRAPH_ZOOM,
} from "../shared/graph-view";
import "./visuals.css";

type GraphPerson = Pick<StoredPerson, "id" | "name"> & {
  originalName?: string;
  photoUrl?: string;
  isDimmed?: boolean;
};
type GraphRelation = Pick<StoredRelation, "from" | "to" | "type"> & {
  id?: string;
};
interface Props {
  people: GraphPerson[];
  relations: GraphRelation[];
  selfId?: string;
  labels?: Record<string, string>;
  selectedId?: string;
  onSelect(id: string, anchor?: HTMLElement): void;
}
const CARD_WIDTH = 132;
const CARD_HEIGHT = 132;

export default function FamilyGraph({
  people,
  relations,
  selfId,
  labels = {},
  selectedId,
  onSelect,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const section = useRef<HTMLElement>(null);
  const overview = useRef(false);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
  } | null>(null);
  const suppressBackgroundClick = useRef(false);
  const layout = useMemo(
    () =>
      buildStarLayout(
        people,
        relations,
        selfId || "",
        selfId || "",
        labels,
        selectedId || "",
      ),
    [people, relations, selfId, labels, selectedId],
  );
  const bounds = graphBounds(layout.nodes);
  const width = bounds.width * zoom;
  const height = bounds.height * zoom;
  const nodeMap = new Map(layout.nodes.map((node) => [node.id, node]));
  const visibleIds = new Set(layout.nodes.map((node) => node.id));
  const omitted = people.filter((person) => !visibleIds.has(person.id));

  const positionAt = (next: number, center: { x: number; y: number }) => {
    setZoom(next);
    requestAnimationFrame(() => {
      const el = viewport.current;
      if (el)
        el.scrollTo(
          graphScroll(center, next, bounds, el.clientWidth, el.clientHeight),
        );
    });
  };
  const fit = () => {
    const el = viewport.current;
    if (!el) return;
    overview.current = true;
    positionAt(graphFit(bounds, el.clientWidth, el.clientHeight), {
      x: bounds.width / 2,
      y: bounds.height / 2,
    });
  };
  const focusNode = (node: { x: number; y: number }, next = 1) => {
    overview.current = false;
    positionAt(next, {
      x: node.x * UNIT - bounds.left,
      y: node.y * UNIT - bounds.top,
    });
  };
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const node = layout.nodes.find((n) => n.id === selfId);
    if (node)
      focusNode(
        node,
        Math.max(0.85, graphFit(bounds, el.clientWidth, el.clientHeight)),
      );
    else fit();
  }, [bounds.width, bounds.height, bounds.left, bounds.top, selfId]);

  // Retain the same person when rotating a phone or expanding the canvas.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    let previous = { width: el.clientWidth, height: el.clientHeight };
    const observer = new ResizeObserver(() => {
      const size = { width: el.clientWidth, height: el.clientHeight };
      if (size.width === previous.width && size.height === previous.height)
        return;
      const center = {
        x:
          width <= previous.width
            ? bounds.width / 2
            : (el.scrollLeft + previous.width / 2) / zoom,
        y:
          height <= previous.height
            ? bounds.height / 2
            : (el.scrollTop + previous.height / 2) / zoom,
      };
      previous = size;
      if (overview.current) fit();
      else positionAt(zoom, center);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [zoom, bounds.width, bounds.height]);
  const searchMatch = people.some((p) => p.isDimmed)
    ? people.find((p) => !p.isDimmed)?.id
    : undefined;
  useEffect(() => {
    const node = layout.nodes.find((n) => n.id === searchMatch);
    if (node) focusNode(node);
  }, [searchMatch]);
  const changeZoom = (difference: number) => {
    const el = viewport.current;
    if (!el) return;
    overview.current = false;
    positionAt(
      Math.max(MIN_GRAPH_ZOOM, Math.min(MAX_GRAPH_ZOOM, zoom + difference)),
      {
        x:
          width <= el.clientWidth
            ? bounds.width / 2
            : (el.scrollLeft + el.clientWidth / 2) / zoom,
        y:
          height <= el.clientHeight
            ? bounds.height / 2
            : (el.scrollTop + el.clientHeight / 2) / zoom,
      },
    );
  };
  const centerSelf = () => {
    const node = layout.nodes.find((item) => item.id === selfId);
    if (node) focusNode(node);
  };
  const toggleExpanded = () => {
    setExpanded((value) => !value);
    requestAnimationFrame(() =>
      section.current?.scrollIntoView({ block: "start" }),
    );
  };
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    suppressBackgroundClick.current = false;
    if (
      event.pointerType !== "mouse" ||
      event.button !== 0 ||
      (event.target as Element).closest("button")
    )
      return;
    const element = event.currentTarget;
    // Capture only after an actual drag. Capturing pointerdown can retarget the
    // subsequent click to this scroll container rather than the person's button.
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: element.scrollLeft,
      top: element.scrollTop,
      moved: false,
    };
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    if ((event.buttons & 1) === 0) {
      drag.current = null;
      return;
    }
    if (
      !start.moved &&
      Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 4
    ) {
      start.moved = true;
      suppressBackgroundClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (start.moved) {
      event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
      event.currentTarget.scrollTop = start.top + start.y - event.clientY;
    }
  };

  if (!people.length)
    return (
      <div className="visual-empty">
        还没有家人资料，添加后就能在这里看到亲缘图。
      </div>
    );

  return (
    <section
      ref={section}
      className={`family-graph${expanded ? " is-expanded" : ""}`}
      aria-label="家人亲缘图"
    >
      <div className="visual-toolbar">
        <div className="graph-legend" aria-label="连线含义">
          <span>
            <i className="line-parent" />
            亲子
          </span>
          <span>
            <i className="line-spouse" />
            夫妻
          </span>
          <span>
            <i className="line-sibling" />
            兄弟姐妹
          </span>
        </div>
        <div className="graph-tools">
          <button
            type="button"
            className="visual-icon-button"
            aria-label="缩小亲缘图"
            disabled={zoom <= MIN_GRAPH_ZOOM}
            onClick={() => changeZoom(-0.15)}
          >
            <Minus size={17} />
          </button>
          <span className="graph-zoom-label" aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            className="visual-icon-button"
            aria-label="放大亲缘图"
            disabled={zoom >= MAX_GRAPH_ZOOM}
            onClick={() => changeZoom(0.15)}
          >
            <Plus size={17} />
          </button>
          <button
            type="button"
            className="visual-text-button"
            aria-label="查看亲缘全图"
            title="查看全图"
            onClick={fit}
          >
            <Scan size={17} />
            全图
          </button>
          {selfId && nodeMap.has(selfId) && (
            <button
              type="button"
              className="visual-text-button"
              aria-label="找到我"
              title="找到我"
              onClick={centerSelf}
            >
              <LocateFixed size={18} />我
            </button>
          )}
          <button
            type="button"
            className="visual-text-button"
            aria-expanded={expanded}
            onClick={toggleExpanded}
          >
            {expanded ? <Shrink size={17} /> : <Expand size={17} />}
            {expanded ? "收起" : "展开"}
          </button>
        </div>
      </div>
      <div
        className="graph-viewport"
        ref={viewport}
        tabIndex={0}
        aria-label="可滚动的亲缘图，拖动查看，或用方向键移动"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerCancel={() => {
          drag.current = null;
          suppressBackgroundClick.current = false;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onClick={(event) => {
          if ((event.target as Element).closest("button")) return;
          if (!suppressBackgroundClick.current) onSelect("");
          suppressBackgroundClick.current = false;
        }}
      >
        <div className="graph-canvas" style={{ width, height }}>
          {layout.bands.map((band) => (
            <div
              key={band.id}
              className={`graph-generation${band.isSelf ? " is-mine" : ""}${band.isUnlinked ? " is-unlinked" : ""}`}
              style={{
                top: (band.y * UNIT - bounds.top - CARD_HEIGHT / 2 - 34) * zoom,
              }}
            >
              <span>{band.label}</span>
            </div>
          ))}
          <svg
            className="graph-connections"
            width={width}
            height={height}
            aria-hidden="true"
          >
            {relations.map((relation, index) => {
              const a = nodeMap.get(relation.from);
              const b = nodeMap.get(relation.to);
              if (!a || !b || a.id === b.id) return null;
              const x1 = (a.x * UNIT - bounds.left) * zoom;
              const x2 = (b.x * UNIT - bounds.left) * zoom;
              const y1 = (a.y * UNIT - bounds.top) * zoom;
              const y2 = (b.y * UNIT - bounds.top) * zoom;
              let d = `M ${x1} ${y1} L ${x2} ${y2}`;
              if (relation.type === "parent" && y1 !== y2) {
                const direction = y2 > y1 ? 1 : -1;
                const start = y1 + (direction * CARD_HEIGHT * zoom) / 2;
                const end = y2 - (direction * CARD_HEIGHT * zoom) / 2;
                const middle = (start + end) / 2;
                d = `M ${x1} ${start} C ${x1} ${middle}, ${x2} ${middle}, ${x2} ${end}`;
              }
              return (
                <path
                  key={
                    relation.id || `${relation.type}-${a.id}-${b.id}-${index}`
                  }
                  className={`line-${relation.type}`}
                  d={d}
                  fill="none"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>
          {layout.nodes.map((node) => (
            <button
              type="button"
              key={node.id}
              data-person-id={node.id}
              data-self={node.isSelf}
              className={`graph-person tone-${node.tone}${node.isSelf ? " is-self" : ""}${node.isSelected ? " is-selected" : ""}${node.isConflicted ? " is-conflicted" : ""}${node.isDimmed ? " is-dimmed" : ""}`}
              aria-label={`${node.name}${node.label ? `，${node.label}` : ""}`}
              aria-pressed={node.isSelected}
              style={{
                left: (node.x * UNIT - bounds.left - CARD_WIDTH / 2) * zoom,
                top: (node.y * UNIT - bounds.top - CARD_HEIGHT / 2) * zoom,
                width: CARD_WIDTH * zoom,
                height: CARD_HEIGHT * zoom,
                fontSize: Math.max(9, 14 * Math.min(zoom + 0.15, 1.3)),
                gap: zoom < 0.65 ? 1 : 4,
                padding: 10 * zoom,
              }}
              onPointerDown={(event) => {
                drag.current = null;
                suppressBackgroundClick.current = false;
                event.stopPropagation();
              }}
              onPointerUp={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(node.id, event.currentTarget);
              }}
            >
              <span
                className="graph-avatar"
                style={{
                  width: 46 * zoom,
                  height: 46 * zoom,
                  fontSize: 23 * zoom,
                  display: zoom < 0.35 ? "none" : undefined,
                }}
              >
                <span>{node.initial}</span>
                {node.photoUrl && (
                  <img
                    src={node.photoUrl}
                    alt=""
                    loading="lazy"
                    onLoad={(event) => {
                      event.currentTarget.style.display = "";
                    }}
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                )}
              </span>
              <span
                className="graph-person-name"
                style={{ display: zoom < 0.35 ? "none" : undefined }}
                title={node.name}
              >
                {node.name}
              </span>
              <span
                className="graph-person-relation"
                style={{
                  fontSize: Math.max(8, 12 * zoom),
                  display: zoom < 0.5 ? "none" : undefined,
                }}
                title={node.label}
              >
                {node.label || "家人"}
              </span>
              {node.isSelf && (
                <span className="graph-self-dot" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="graph-footer">
        <span>{people.length} 位家人</span>
        <span>
          {zoom < 0.5 ? "全图预览 · 放大看姓名" : "拖动看家人 · 点头像看资料"}
        </span>
      </div>
      {!!layout.conflictCount && (
        <p className="visual-note graph-warning">
          有 {layout.conflictCount} 位家人的关系需要核实，可在管理中调整。
        </p>
      )}
      {!!omitted.length && (
        <details className="graph-overflow">
          <summary>
            另外 {omitted.length} 位家人（图中优先显示与我相连的 160 人）
          </summary>
          <div>
            {omitted.map((person) => (
              <button
                type="button"
                key={person.id}
                onClick={(event) => onSelect(person.id, event.currentTarget)}
              >
                {person.name}
              </button>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
