import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  Minus,
  Plus,
  RotateCcw,
  LocateFixed,
  Expand,
  Shrink,
} from "lucide-react";
import { buildStarLayout } from "../shared/family-layout";
import {
  buildFamilyOverview,
  shouldShowFamilies,
  FAMILY_CARD_WIDTH,
  FAMILY_CARD_HEIGHT,
} from "../shared/family-overview";
import { Modal } from "./UI";
import type {
  Person as StoredPerson,
  Relation as StoredRelation,
} from "../../../backend/src/model";
import {
  graphBounds,
  graphScroll,
  GRAPH_UNIT as UNIT,
  MIN_GRAPH_ZOOM,
  MAX_GRAPH_ZOOM,
} from "../shared/graph-view";
import "./visuals.css";
import { Link } from "react-router-dom";

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
  relationHref?: (personId: string) => string;
}
const CARD_WIDTH = 132;
const CARD_HEIGHT = 132;
function GraphPhoto({ url, initial }: { url?: string; initial: string }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  return url && failedUrl !== url ? (
    <img src={url} alt="" loading="lazy" onError={() => setFailedUrl(url)} />
  ) : (
    <span>{initial}</span>
  );
}

export default function FamilyGraph({
  people,
  relations,
  selfId,
  labels = {},
  selectedId,
  onSelect,
  relationHref,
}: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [overview, setOverview] = useState(false);
  const [openFamilyId, setOpenFamilyId] = useState("");
  const familyAnchor = useRef<HTMLElement | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const section = useRef<HTMLElement>(null);
  const pendingScroll = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const scroll = pendingScroll.current;
    pendingScroll.current = null;
    scroll?.();
  });
  useLayoutEffect(() => {
    if (expanded)
      section.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [expanded]);
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
  const families = useMemo(
    () => buildFamilyOverview(layout.nodes, relations),
    [layout, relations],
  );
  const personalBounds = graphBounds(layout.nodes);
  const familyBounds = graphBounds(
    families.nodes,
    FAMILY_CARD_WIDTH,
    FAMILY_CARD_HEIGHT,
  );
  const bounds = overview ? familyBounds : personalBounds;
  // Semantic zoom: grouped cards have their own readable size at the switch.
  // Zoom itself is still unrestricted from 1% to 160%.
  const scale = overview ? zoom * 2 : zoom;
  const width = bounds.width * scale;
  const height = bounds.height * scale;
  const viewNodes = overview ? families.nodes : layout.nodes;
  const viewNodeMap = new Map<string, { id: string; x: number; y: number }>(
    viewNodes.map((node) => [node.id, node]),
  );
  const viewEdges = overview ? families.edges : relations;
  const openFamily = overview
    ? families.nodes.find((unit) => unit.id === openFamilyId)
    : undefined;
  const nodeMap = new Map(layout.nodes.map((node) => [node.id, node]));
  const visibleIds = new Set(layout.nodes.map((node) => node.id));
  const omitted = people.filter((person) => !visibleIds.has(person.id));
  const unlinked = layout.nodes.filter((node) => node.generation === null);

  const positionAt = (
    next: number,
    center: { x: number; y: number },
    personId?: string,
  ) => {
    const el = viewport.current;
    if (!el) return;
    const nextOverview = shouldShowFamilies(
      overview,
      next,
      personalBounds,
      { width: el.clientWidth, height: el.clientHeight },
      families.hasGroups,
    );
    const nextBounds = nextOverview ? familyBounds : personalBounds;
    const nextScale = nextOverview ? next * 2 : next;
    let anchorId = personId;
    if (nextOverview !== overview && !anchorId) {
      const nearest = [...viewNodes].sort(
        (a, b) =>
          Math.hypot(
            a.x * UNIT - bounds.left - center.x,
            a.y * UNIT - bounds.top - center.y,
          ) -
          Math.hypot(
            b.x * UNIT - bounds.left - center.x,
            b.y * UNIT - bounds.top - center.y,
          ),
      )[0];
      anchorId =
        nearest &&
        ("members" in nearest
          ? nearest.members.find((member) => member.isSelf)?.id ||
            nearest.heads[0].id
          : nearest.id);
    }
    if (anchorId) {
      const target = nextOverview
        ? families.nodes.find(
            (unit) => unit.id === families.personUnit.get(anchorId!),
          )
        : nodeMap.get(anchorId);
      if (target)
        center = {
          x: target.x * UNIT - nextBounds.left,
          y: target.y * UNIT - nextBounds.top,
        };
    }
    if (nextOverview !== overview) {
      setOpenFamilyId("");
      onSelect("");
    }
    const scroll = () => {
      const el = viewport.current;
      if (el)
        el.scrollTo(
          graphScroll(
            center,
            nextScale,
            nextBounds,
            el.clientWidth,
            el.clientHeight,
          ),
        );
      if (expanded)
        section.current?.scrollIntoView({
          block: "start",
          behavior: "instant",
        });
    };
    if (next === zoom && nextOverview === overview) scroll();
    else pendingScroll.current = scroll;
    setOverview(nextOverview);
    setZoom(next);
  };
  const focusNode = (node: { id: string; x: number; y: number }, next = 1) => {
    positionAt(
      next,
      {
        x: node.x * UNIT - bounds.left,
        y: node.y * UNIT - bounds.top,
      },
      node.id,
    );
  };
  const resetView = () => {
    const node =
      layout.nodes.find((n) => n.id === (selfId || layout.centerId)) ||
      layout.nodes.find((n) => n.connected) ||
      layout.nodes[0];
    if (node) focusNode(node);
  };
  useEffect(() => {
    resetView();
  }, [
    selfId,
    layout.centerId,
    layout.nodes
      .map((node) => node.id)
      .sort()
      .join("|"),
  ]);

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
            : (el.scrollLeft + previous.width / 2) / scale,
        y:
          height <= previous.height
            ? bounds.height / 2
            : (el.scrollTop + previous.height / 2) / scale,
      };
      previous = size;
      positionAt(zoom, center);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [zoom, overview, bounds.width, bounds.height]);
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
    positionAt(
      Math.max(MIN_GRAPH_ZOOM, Math.min(MAX_GRAPH_ZOOM, zoom + difference)),
      {
        x:
          width <= el.clientWidth
            ? bounds.width / 2
            : (el.scrollLeft + el.clientWidth / 2) / scale,
        y:
          height <= el.clientHeight
            ? bounds.height / 2
            : (el.scrollTop + el.clientHeight / 2) / scale,
      },
    );
  };
  const centerSelf = () => {
    const node = layout.nodes.find((item) => item.id === selfId);
    if (node) focusNode(node);
  };
  const toggleExpanded = () => {
    setExpanded((value) => !value);
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
            aria-label="重置亲缘图"
            title="恢复初始大小和位置"
            onClick={resetView}
          >
            <RotateCcw size={17} />
            重置
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
      {overview && (
        <div className="graph-family-notice" role="status">
          已收成家庭卡片 · 点一家看成员{scale < 0.65 ? " · 放大可看清姓名" : ""}
        </div>
      )}
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
          {!overview &&
            layout.bands.map((band) => (
              <div
                key={band.id}
                className={`graph-generation${band.isSelf ? " is-mine" : ""}${band.isUnlinked ? " is-unlinked" : ""}`}
                style={{
                  top:
                    (band.y * UNIT - bounds.top - CARD_HEIGHT / 2 - 34) * zoom,
                  fontSize: 11 * zoom,
                  gap: 12 * zoom,
                }}
              >
                <span
                  style={{
                    padding: `${3 * zoom}px ${9 * zoom}px`,
                    borderRadius: 5 * zoom,
                  }}
                >
                  {band.label}
                </span>
              </div>
            ))}
          <svg
            className="graph-connections"
            width={width}
            height={height}
            aria-hidden="true"
          >
            {viewEdges.map((relation, index) => {
              const a = viewNodeMap.get(relation.from);
              const b = viewNodeMap.get(relation.to);
              if (!a || !b || a.id === b.id) return null;
              const x1 = (a.x * UNIT - bounds.left) * scale;
              const x2 = (b.x * UNIT - bounds.left) * scale;
              const y1 = (a.y * UNIT - bounds.top) * scale;
              const y2 = (b.y * UNIT - bounds.top) * scale;
              let d = `M ${x1} ${y1} L ${x2} ${y2}`;
              if (relation.type === "parent" && y1 !== y2) {
                const direction = y2 > y1 ? 1 : -1;
                const cardHeight = overview ? FAMILY_CARD_HEIGHT : CARD_HEIGHT;
                const start = y1 + (direction * cardHeight * scale) / 2;
                const end = y2 - (direction * cardHeight * scale) / 2;
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
                  strokeWidth={1.5 * scale}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>
          {overview
            ? families.nodes.map((unit) => (
                <button
                  type="button"
                  key={unit.id}
                  data-family-id={unit.id}
                  data-self={unit.isSelf}
                  className={`graph-family-card${unit.isSelf ? " is-self" : ""}${unit.isDimmed ? " is-dimmed" : ""}`}
                  aria-label={
                    unit.members.length > 1
                      ? `${unit.title}，${unit.members.length}位家人，展开成员`
                      : `${unit.title}，${unit.heads[0].label}`
                  }
                  style={{
                    left:
                      (unit.x * UNIT - bounds.left - FAMILY_CARD_WIDTH / 2) *
                      scale,
                    top:
                      (unit.y * UNIT - bounds.top - FAMILY_CARD_HEIGHT / 2) *
                      scale,
                    width: FAMILY_CARD_WIDTH,
                    height: FAMILY_CARD_HEIGHT,
                    transform: `scale(${scale})`,
                    transformOrigin: "top left",
                  }}
                  onPointerDown={(event) => {
                    drag.current = null;
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (unit.members.length === 1) {
                      onSelect(unit.heads[0].id, event.currentTarget);
                      return;
                    }
                    onSelect("");
                    familyAnchor.current = event.currentTarget;
                    setOpenFamilyId(unit.id);
                  }}
                >
                  <span className="graph-family-photos">
                    {unit.members.slice(0, 3).map((member) => (
                      <span key={member.id} className="graph-avatar">
                        <GraphPhoto
                          url={member.photoUrl}
                          initial={member.initial}
                        />
                      </span>
                    ))}
                  </span>
                  <strong title={unit.title}>{unit.title}</strong>
                  <span>
                    {unit.isSelf ? "我在这里 · " : ""}
                    {unit.members.length > 1
                      ? `${unit.members.length}位家人 · 点开看`
                      : unit.heads[0].label}
                  </span>
                </button>
              ))
            : layout.nodes.map((node) => (
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
                    width: CARD_WIDTH,
                    height: CARD_HEIGHT,
                    transform: `scale(${zoom})`,
                    transformOrigin: "top left",
                    fontSize: 16,
                    gap: 3,
                    padding: 8,
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
                      width: 62,
                      height: 62,
                      fontSize: 23,
                    }}
                  >
                    <GraphPhoto url={node.photoUrl} initial={node.initial} />
                  </span>
                  <span className="graph-person-name" title={node.name}>
                    {node.name}
                  </span>
                  <span
                    className="graph-person-relation"
                    style={{
                      fontSize: 14,
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
          {overview ? "拖动看各家 · 放大看个人" : "拖动看家人 · 点头像看资料"}
        </span>
      </div>
      {openFamily && (
        <Modal title={openFamily.title} onClose={() => setOpenFamilyId("")}>
          <p className="family-members-intro">
            点头像查看资料；关闭后回到刚才的位置。
          </p>
          <div className="family-members-grid">
            {openFamily.members.map((member) => (
              <button
                type="button"
                key={member.id}
                className={member.isSelf ? "is-self" : ""}
                onClick={() => {
                  setOpenFamilyId("");
                  onSelect(member.id, familyAnchor.current);
                }}
              >
                <span className="graph-avatar">
                  <GraphPhoto url={member.photoUrl} initial={member.initial} />
                </span>
                <strong>
                  {member.name}
                  {member.isSelf ? "（我）" : ""}
                </strong>
                <span>{member.label}</span>
              </button>
            ))}
          </div>
          {(() => {
            const ids = new Set(openFamily.members.map((member) => member.id));
            const outward = relations.filter(
              (edge) =>
                edge.type === "parent" &&
                ids.has(edge.from) !== ids.has(edge.to),
            );
            return (
              !!outward.length && (
                <div className="family-external-links">
                  <h3>相连的家人</h3>
                  {outward.map((edge, index) => {
                    const personId = ids.has(edge.from) ? edge.to : edge.from;
                    const person = nodeMap.get(personId);
                    const local = nodeMap.get(
                      ids.has(edge.from) ? edge.from : edge.to,
                    );
                    if (!person || !local) return null;
                    return (
                      <button
                        type="button"
                        key={edge.id || index}
                        onClick={() => {
                          setOpenFamilyId("");
                          focusNode(person);
                          onSelect(person.id);
                        }}
                      >
                        {local.name}的{ids.has(edge.from) ? "子女" : "父母"}：
                        {person.name} →
                      </button>
                    );
                  })}
                </div>
              )
            );
          })()}
        </Modal>
      )}
      {!!unlinked.length && relationHref && (
        <div className="relation-next-step graph-relation-prompt">
          <strong>{unlinked.length} 位家人的关系待补充</strong>
          <Link className="button primary" to={relationHref(unlinked[0].id)}>
            去补充关系
          </Link>
        </div>
      )}
      {!!unlinked.length && (
        <details className="graph-overflow">
          <summary>关系待补充 · {unlinked.length} 位家人</summary>
          <p className="visual-note">
            这些家人已记录，暂时单独放在图中。管理员补好关系后会自动连接。
          </p>
          <div>
            {unlinked.map((node) => (
              <div key={node.id} className="unlinked-person-actions">
                <button
                  type="button"
                  onClick={(event) => {
                    focusNode(node);
                    onSelect(node.id, event.currentTarget);
                  }}
                >
                  {node.name}
                </button>
                {relationHref && (
                  <Link
                    className="button secondary"
                    to={relationHref(node.id)}
                    aria-label={`为${node.name}补充关系`}
                  >
                    补充关系
                  </Link>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
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
