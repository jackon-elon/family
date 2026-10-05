import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { createWelcomeTimer, WELCOME_DURATION_MS } from "../shared/home-welcome";

const welcomeStyle = { "--welcome-duration": `${WELCOME_DURATION_MS}ms` } as CSSProperties;

function useWelcome() {
  // The first React render already contains the overlay, before App can paint.
  const [welcoming, setWelcoming] = useState(true);
  const [paused, setPaused] = useState(() => document.visibilityState !== "visible");
  const dismiss = useCallback(() => setWelcoming(false), []);
  useEffect(() => {
    if (!welcoming) return;
    const timer = createWelcomeTimer(dismiss, {
      now: () => performance.now(),
      schedule: (callback, delay) => window.setTimeout(callback, delay),
      cancel: (id) => window.clearTimeout(id),
    });
    const updateVisibility = () => {
      const visible = document.visibilityState === "visible";
      setPaused(!visible);
      timer.setVisible(visible);
    };
    updateVisibility();
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      timer.dispose();
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, [welcoming, dismiss]);
  return { welcoming, paused, dismiss };
}

function WelcomeScreen({ onClose, paused }: { onClose: () => void; paused: boolean }) {
  const screen = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.getElementById("root");
    const prior = document.activeElement as HTMLElement | null;
    const priorInert = root?.inert ?? false;
    const priorOverflow = document.body.style.overflow;
    if (root) root.inert = true;
    document.body.style.overflow = "hidden";
    screen.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") {
        event.preventDefault();
        screen.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      if (root) root.inert = priorInert;
      document.body.style.overflow = priorOverflow;
      document.removeEventListener("keydown", onKey);
      if (prior?.isConnected) prior.focus({ preventScroll: true });
    };
  }, [onClose]);

  return createPortal(
    <div ref={screen} tabIndex={-1} className="welcome-screen" data-paused={paused} role="dialog" aria-modal="true" aria-label="回家了，真好" style={welcomeStyle}>
      <div className="welcome-sky" aria-hidden="true">
        <i /><i /><i /><i /><i /><i /><i /><i />
      </div>
      <div className="welcome-brand"><span aria-hidden="true">✧</span> 人间星图</div>
      <div className="welcome-center">
        <svg className="welcome-constellation" viewBox="0 0 320 280" fill="none" aria-hidden="true">
          <defs>
            <radialGradient id="welcome-star-glow">
              <stop stopColor="#e9ca82" stopOpacity=".55" />
              <stop offset="1" stopColor="#e9ca82" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle className="welcome-star-glow" cx="160" cy="140" r="85" fill="url(#welcome-star-glow)" />
          <g className="welcome-orbits" stroke="#849174" strokeWidth=".7">
            <ellipse cx="160" cy="140" rx="137" ry="83" transform="rotate(-28 160 140)" />
            <ellipse cx="160" cy="140" rx="104" ry="120" transform="rotate(25 160 140)" strokeDasharray="2 7" />
            <circle cx="160" cy="140" r="109" strokeDasharray="1 10" />
          </g>
          <g className="welcome-star-links" stroke="#859774" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
            <path pathLength="1" d="M51 130 92 65 172 40 251 92 160 140 51 130 105 213 160 140 216 226 272 178 251 92" />
            <path pathLength="1" d="M92 65 160 140 172 40 M105 213 216 226 M160 140 272 178" strokeOpacity=".45" />
          </g>
          {[[51, 130], [92, 65], [172, 40], [251, 92], [272, 178], [216, 226], [105, 213]].map(([x, y], index) => (
            <g className="welcome-star-node" key={index} style={{ "--star-delay": `${index * 85}ms` } as CSSProperties}>
              <circle cx={x} cy={y} r="10" fill="#d7deca" fillOpacity=".65" />
              <circle cx={x} cy={y} r="4" fill="#8c9d77" stroke="#fffdf5" strokeWidth="1.5" />
            </g>
          ))}
          <g className="welcome-star-dust" fill="#b09b70">
            <circle cx="40" cy="69" r="1.6" /><circle cx="232" cy="34" r="1.8" />
            <circle cx="286" cy="116" r="1.5" /><circle cx="54" cy="218" r="1.7" />
            <circle cx="145" cy="248" r="1.5" /><circle cx="288" cy="223" r="1.3" />
            <path d="m60 37 2 6 6 2-6 2-2 6-2-6-6-2 6-2Z M282 56l2 6 6 2-6 2-2 6-2-6-6-2 6-2Z" />
          </g>
          <g className="welcome-heart-star">
            <circle cx="160" cy="140" r="27" fill="#fff9e9" fillOpacity=".8" />
            <path d="M160 115Q165 135 185 140Q165 145 160 165Q155 145 135 140Q155 135 160 115Z" fill="#b99b5f" />
            <path d="M160 124Q163 137 176 140Q163 143 160 156Q157 143 144 140Q157 137 160 124Z" fill="#fff2bf" />
          </g>
        </svg>
        <div>
          <h1 className="welcome-message"><span>回家了，</span><span>真好。</span></h1>
          <p className="welcome-caption">天南海北，彼此相连。</p>
        </div>
      </div>
    </div>, document.body,
  );
}

export function WelcomeEntrance() {
  const { welcoming, paused, dismiss } = useWelcome();
  return welcoming ? <WelcomeScreen onClose={dismiss} paused={paused} /> : null;
}

export default function HomeIntro() {
  return (
    <section className="home-intro">
      <div className="intro-copy">
        <span className="pill">朝夕之间 · 人间相见</span>
        <h2>把身边的人，<br />好好记在心上。</h2>
        <p>亲缘有迹，近况可知。<br />让天南海北的联系，近一些。</p>
      </div>
      <div className="intro-art" aria-hidden="true">
        <div className="intro-ring ring-one" />
        <div className="intro-ring ring-two" />
        <span className="art-node node-one">亲</span>
        <span className="art-node node-two">友</span>
        <span className="art-node node-three">家</span>
        <span className="art-star">✧</span>
      </div>
    </section>
  );
}
