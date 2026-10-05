import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createWelcomeGate, WELCOME_DURATION_MS } from "../shared/home-welcome";

const claimWelcome = createWelcomeGate();
const welcomeStyle = { "--welcome-duration": `${WELCOME_DURATION_MS}ms` } as CSSProperties;

function useWelcome(familyId?: string) {
  const [welcoming, setWelcoming] = useState(false);
  const started = useRef<string | undefined>(undefined);
  const finished = useRef(false);
  const dismiss = useCallback(() => {
    finished.current = true;
    setWelcoming(false);
  }, []);
  useEffect(() => {
    setWelcoming(false);
    if (!familyId) return;
    let timer: number | undefined;
    if (started.current !== familyId) finished.current = false;
    const showWhenVisible = () => {
      window.clearTimeout(timer);
      setWelcoming(false);
      if (finished.current || document.visibilityState !== "visible") return;
      // Claim only in the foreground. StrictMode retains this mount's claim.
      if (started.current !== familyId && !claimWelcome(familyId)) return;
      started.current = familyId;
      setWelcoming(true);
      timer = window.setTimeout(() => {
        finished.current = true;
        setWelcoming(false);
      }, WELCOME_DURATION_MS);
    };
    showWhenVisible();
    document.addEventListener("visibilitychange", showWhenVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", showWhenVisible);
    };
  }, [familyId]);

  return { welcoming, dismiss };
}

function WelcomeScreen({ onClose }: { onClose: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const root = document.getElementById("root");
    const prior = document.activeElement as HTMLElement | null;
    const priorInert = root?.inert ?? false;
    const priorOverflow = document.body.style.overflow;
    if (root) root.inert = true;
    document.body.style.overflow = "hidden";
    button.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key === "Tab") {
        event.preventDefault();
        button.current?.focus({ preventScroll: true });
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
    <div className="welcome-screen" role="dialog" aria-modal="true" aria-label="回家了，真好" style={welcomeStyle}>
      <div className="welcome-brand"><span aria-hidden="true">✧</span> 人间星图</div>
      <div className="welcome-center">
        <svg className="welcome-house" viewBox="0 0 120 120" fill="none" aria-hidden="true">
          <circle className="welcome-halo" cx="60" cy="65" r="48" fill="#f4d88c" />
          <path className="welcome-house-outline" pathLength="1" d="M16 54 60 18 104 54 M28 45V100H92V45 M50 100V72H70V100" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <rect className="welcome-window" x="45" y="46" width="30" height="20" rx="3" fill="#e5b553" />
          <path className="welcome-house-outline" pathLength="1" d="M60 46V66 M45 56H75 M18 101H102" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <div>
          <h1 className="welcome-message"><span>回家了，</span><span>真好。</span></h1>
          <p className="welcome-caption">总有一盏灯，为你留着。</p>
        </div>
      </div>
      <div className="welcome-footer">
        <button ref={button} type="button" className="welcome-enter" onClick={onClose}>进入家里 <span aria-hidden="true">→</span></button>
        <p>稍候自动进入，也可以直接点这里</p>
      </div>
    </div>, document.body,
  );
}

function WelcomeEntrance({ familyId }: { familyId?: string }) {
  const { welcoming, dismiss } = useWelcome(familyId);
  return welcoming ? <WelcomeScreen onClose={dismiss} /> : null;
}

export function ArrivalGreeting({ familyId, children }: { familyId: string; children: ReactNode }) {
  return <>{children}<WelcomeEntrance familyId={familyId} /></>;
}

export default function HomeIntro({ familyId }: { familyId?: string }) {
  return (
    <section className="home-intro">
      <WelcomeEntrance familyId={familyId} />
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
