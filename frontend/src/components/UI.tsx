import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { X, LoaderCircle, AlertCircle, ArrowLeft } from "lucide-react";
import type { PersonView } from "../types";

const modalStack: Array<{ element: HTMLDivElement; lastFocused: HTMLElement }> =
  [];
let pageOverflowBeforeModals = "";
export function Alert({ message }: { message?: string }) {
  return message ? (
    <div className="alert" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
    </div>
  ) : null;
}
export function Loading({ label = "正在加载…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={22} />
      {label}
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-star">✧</div>
      <h3>{title}</h3>
      {children && <div>{children}</div>}
    </div>
  );
}
export function Avatar({
  person,
  large = false,
}: {
  person: Pick<PersonView, "name" | "photoUrl">;
  large?: boolean;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  return (
    <span className={`avatar${large ? " large" : ""}`}>
      {person.photoUrl && failedUrl !== person.photoUrl ? (
        <img
          src={person.photoUrl}
          alt=""
          loading={large ? "eager" : "lazy"}
          decoding="async"
          onError={() => setFailedUrl(person.photoUrl)}
        />
      ) : (
        person.name?.slice(-2) || "人"
      )}
    </span>
  );
}
export function Modal({
  title,
  onClose,
  children,
  busy = false,
  wide = false,
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const busyRef = useRef(busy);
  close.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const prior =
      modalStack.at(-1)?.lastFocused ||
      (document.activeElement as HTMLElement | null);
    if (!modalStack.length)
      pageOverflowBeforeModals = document.body.style.overflow;
    const entry = { element, lastFocused: element as HTMLElement };
    modalStack.push(entry);
    document.body.style.overflow = "hidden";
    element.focus();
    const trackFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && element.contains(event.target))
        entry.lastFocused = event.target;
    };
    const key = (e: KeyboardEvent) => {
      if (modalStack.at(-1) !== entry) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!busyRef.current) close.current();
      }
      if (e.key === "Tab") {
        const nodes = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            "button,input,select,textarea,a[href],summary,[tabindex]",
          ) || [],
        ).filter(
          (node) =>
            node.tabIndex >= 0 &&
            !node.matches(":disabled") &&
            node.getClientRects().length > 0 &&
            getComputedStyle(node).visibility !== "hidden",
        );
        if (!nodes.length) {
          e.preventDefault();
          ref.current?.focus();
          return;
        }
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current ||
            !ref.current?.contains(document.activeElement))
        ) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            document.activeElement === ref.current ||
            !ref.current?.contains(document.activeElement))
        ) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("focusin", trackFocus);
    document.addEventListener("keydown", key);
    return () => {
      const wasTop = modalStack.at(-1) === entry;
      const index = modalStack.indexOf(entry);
      if (index >= 0) modalStack.splice(index, 1);
      if (!modalStack.length)
        document.body.style.overflow = pageOverflowBeforeModals;
      document.removeEventListener("focusin", trackFocus);
      document.removeEventListener("keydown", key);
      if (wasTop) {
        const nextTop = modalStack.at(-1);
        // Let the underlying form finish its async busy state before restoring
        // focus to the button that opened the confirmation dialog.
        requestAnimationFrame(() => {
          if (modalStack.at(-1) !== nextTop) return;
          if (
            prior?.isConnected &&
            !prior.matches(":disabled") &&
            (!nextTop || nextTop.element.contains(prior))
          )
            prior.focus();
          else nextTop?.element.focus();
        });
      }
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal${wide ? " wide" : ""} ${className}`}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button
            className="icon-button"
            disabled={busy}
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={20} />
            <span>关闭</span>
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
export function Back({
  onClick,
  label = "返回",
}: {
  onClick: () => void;
  label?: string;
}) {
  return (
    <button className="text-button back" onClick={onClick}>
      <ArrowLeft size={16} />
      {label}
    </button>
  );
}
export function FloatingPanel({
  title,
  onClose,
  children,
  busy = false,
  anchorElement,
  anchorSelector,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
  anchorElement?: HTMLElement | null;
  anchorSelector?: string;
}) {
  const panel = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<CSSProperties>({
    visibility: "hidden",
  });
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy && !modalStack.length) onClose();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [busy, onClose]);
  useLayoutEffect(() => {
    let frame = 0;
    const place = () => {
      const element = panel.current;
      if (!element) return;
      const viewportWidth = window.innerWidth,
        viewportHeight = window.innerHeight,
        mobile =
          viewportWidth <= 680 ||
          (viewportWidth <= 1000 && viewportHeight <= 500);
      const main = document.querySelector(".main")?.getBoundingClientRect();
      const backbar = document
        .querySelector(".album-backbar")
        ?.getBoundingClientRect();
      const navigationBottom =
        backbar && backbar.top < viewportHeight && backbar.bottom > 0
          ? backbar.bottom + 12
          : 16;
      const leftEdge = mobile ? 14 : Math.max(16, (main?.left || 0) + 16),
        rightEdge = viewportWidth - 16,
        topEdge = Math.max(
          16,
          Math.min(viewportHeight - 160, navigationBottom),
        ),
        bottomEdge = viewportHeight - (mobile ? 87 : 20);
      const width = Math.min(320, rightEdge - leftEdge),
        gap = 14;
      const desiredHeight = Math.min(
        420,
        element.scrollHeight,
        bottomEdge - topEdge,
      );
      const anchor = anchorElement?.isConnected
        ? anchorElement
        : anchorSelector
          ? document.querySelector<HTMLElement>(anchorSelector)
          : null;
      let left = rightEdge - width,
        top = Math.max(topEdge, bottomEdge - desiredHeight),
        maxHeight = Math.min(420, bottomEdge - topEdge);
      if (anchor) {
        const rect = anchor.getBoundingClientRect();
        const rightSpace = rightEdge - rect.right - gap,
          leftSpace = rect.left - leftEdge - gap,
          aboveSpace = rect.top - topEdge - gap,
          belowSpace = bottomEdge - rect.bottom - gap;
        if (rightSpace >= width || leftSpace >= width) {
          left =
            rightSpace >= width ? rect.right + gap : rect.left - gap - width;
          top = Math.max(
            topEdge,
            Math.min(
              bottomEdge - desiredHeight,
              rect.top + (rect.height - desiredHeight) / 2,
            ),
          );
        } else {
          left = Math.max(
            leftEdge,
            Math.min(rightEdge - width, rect.left + (rect.width - width) / 2),
          );
          const above = aboveSpace >= desiredHeight || aboveSpace >= belowSpace;
          maxHeight = Math.max(
            100,
            Math.min(420, above ? aboveSpace : belowSpace),
          );
          const height = Math.min(desiredHeight, maxHeight);
          top = above
            ? Math.max(topEdge, rect.top - gap - height)
            : Math.max(topEdge, rect.bottom + gap);
        }
      }
      const next: CSSProperties = {
        left: Math.round(Math.max(leftEdge, Math.min(rightEdge - width, left))),
        top: Math.round(
          Math.max(
            topEdge,
            Math.min(bottomEdge - Math.min(desiredHeight, maxHeight), top),
          ),
        ),
        width: Math.round(width),
        maxHeight: Math.floor(maxHeight),
        right: "auto",
        bottom: "auto",
        visibility: "visible",
      };
      setPosition((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    place();
    const observer = new ResizeObserver(schedule);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [anchorElement, anchorSelector]);
  return (
    <aside
      ref={panel}
      style={position}
      className="floating-person"
      role="region"
      aria-label={title}
    >
      <header className="modal-header">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="关闭人物详情"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
          <span>关闭</span>
        </button>
      </header>
      {children}
    </aside>
  );
}
