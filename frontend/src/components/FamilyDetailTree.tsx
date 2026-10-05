import { useLayoutEffect, useMemo, useRef } from "react";
import type { FamilyUnit } from "../shared/family-overview";
import type { StarRelation } from "../shared/family-layout";
import {
  buildFamilyDetail,
  DETAIL_CARD_WIDTH as W,
  DETAIL_CARD_HEIGHT as H,
} from "../shared/family-detail";
import { Avatar } from "./UI";

export default function FamilyDetailTree({
  unit,
  relations,
  onSelect,
}: {
  unit: FamilyUnit;
  relations: StarRelation[];
  onSelect: (id: string) => void;
}) {
  const tree = useMemo(
    () => buildFamilyDetail(unit, relations),
    [unit, relations],
  );
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const center = () => {
    const node =
      tree.nodes.find((node) => node.isSelf) || byId.get(unit.heads[0].id);
    const el = viewport.current;
    if (node && el)
      el.scrollTo({
        left: Math.max(0, node.x - el.clientWidth / 2),
        top: Math.max(0, node.y + H / 2 - el.clientHeight / 2),
      });
  };
  useLayoutEffect(center, [unit.id]);
  return (
    <>
      <div className="family-tree-tools">
        <p>点头像看资料；其他家庭请返回总图查看。</p>
        <button type="button" className="button secondary" onClick={center}>
          居中
        </button>
      </div>
      <div
        ref={viewport}
        className="family-detail-viewport"
        style={{ height: `min(${tree.height + 2}px, 64dvh)` }}
        role="region"
        aria-label="这一家的亲属树，可上下左右滑动"
        tabIndex={0}
        onPointerDown={(event) => {
          if (
            event.pointerType !== "mouse" ||
            event.button !== 0 ||
            (event.target as Element).closest("button")
          )
            return;
          drag.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: event.currentTarget.scrollLeft,
            top: event.currentTarget.scrollTop,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.id !== event.pointerId) return;
          event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
          event.currentTarget.scrollTop = start.top + start.y - event.clientY;
        }}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        <div
          className="family-detail-canvas"
          style={{ width: tree.width, height: tree.height }}
        >
          {tree.bands.map((band) => (
            <div
              className="family-detail-band"
              key={band.label}
              style={{ top: band.y }}
            >
              {band.label}
            </div>
          ))}
          <svg
            className="graph-connections"
            width={tree.width}
            height={tree.height}
            aria-hidden="true"
          >
            {tree.edges.map((edge, index) => {
              const a = byId.get(edge.from)!,
                b = byId.get(edge.to)!;
              let d = "";
              if (edge.type === "parent") {
                const start = a.y + H,
                  end = b.y,
                  middle = (start + end) / 2;
                d = `M ${a.x} ${start} L ${a.x} ${middle} L ${b.x} ${middle} L ${b.x} ${end}`;
              } else {
                const direction = b.x > a.x ? 1 : -1;
                d = `M ${a.x + (direction * W) / 2} ${a.y + H / 2} L ${b.x - (direction * W) / 2} ${b.y + H / 2}`;
              }
              return (
                <path
                  key={edge.id || `${edge.type}-${index}`}
                  className={`line-${edge.type}`}
                  d={d}
                  fill="none"
                  strokeWidth={1.6}
                />
              );
            })}
          </svg>
          {tree.nodes.map((node) => (
            <button
              type="button"
              key={node.id}
              data-tree-person-id={node.id}
              className={`family-detail-node${node.isSelf ? " is-self" : ""}`}
              style={{ left: node.x - W / 2, top: node.y, width: W, height: H }}
              aria-label={`${node.name}${node.isSelf ? "，我" : node.label ? `，${node.label}` : ""}，查看资料`}
              onClick={() => onSelect(node.id)}
            >
              <Avatar person={node} />
              <strong title={node.name}>{node.name}</strong>
              <span title={node.label}>
                {node.isSelf ? "我" : node.label || "家人"}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
