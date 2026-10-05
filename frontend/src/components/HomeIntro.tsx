import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createWelcomeGate, WELCOME_DURATION_MS } from "../shared/home-welcome";

const claimWelcome = createWelcomeGate();
const welcomeStyle = { "--welcome-duration": `${WELCOME_DURATION_MS}ms` } as CSSProperties;

function useWelcome(familyId?: string) {
  const [welcoming, setWelcoming] = useState(false);
  const started = useRef<string | undefined>(undefined);
  useEffect(() => {
    setWelcoming(false);
    if (!familyId) return;
    let timer: number | undefined;
    let finished = false;
    const showWhenVisible = () => {
      window.clearTimeout(timer);
      setWelcoming(false);
      if (finished || document.visibilityState !== "visible") return;
      // Claim only in the foreground. StrictMode retains this mount's claim.
      if (started.current !== familyId && !claimWelcome(familyId)) return;
      started.current = familyId;
      setWelcoming(true);
      timer = window.setTimeout(() => {
        finished = true;
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

  return welcoming;
}

export function ArrivalGreeting({ familyId, children }: { familyId: string; children: ReactNode }) {
  const welcoming = useWelcome(familyId);
  return <span className={`arrival-greeting${welcoming ? " is-welcoming" : ""}`} style={welcomeStyle}>
    <span className="arrival-original">{children}</span>
    <span className="arrival-words" aria-hidden="true">回家了，真好。</span>
  </span>;
}

export default function HomeIntro({ familyId }: { familyId?: string }) {
  const welcoming = useWelcome(familyId);
  return (
    <section className={`home-intro${welcoming ? " is-welcoming" : ""}`} style={welcomeStyle}>
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
      {welcoming && <div className="welcome-scene" aria-hidden="true">
        <svg className="welcome-house" viewBox="0 0 120 120" fill="none">
          <circle className="welcome-halo" cx="60" cy="65" r="48" fill="#f4d88c" />
          <path className="welcome-house-outline" pathLength="1" d="M16 54 60 18 104 54 M28 45V100H92V45 M50 100V72H70V100" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <rect className="welcome-window" x="45" y="46" width="30" height="20" rx="3" fill="#e5b553" />
          <path className="welcome-house-outline" pathLength="1" d="M60 46V66 M45 56H75 M18 101H102" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className="welcome-message"><span>回家了，</span><span>真好。</span></span>
      </div>}
    </section>
  );
}
