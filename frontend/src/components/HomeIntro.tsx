import { useEffect, useRef, useState, type ReactNode } from "react";
import { createWelcomeGate } from "../shared/home-welcome";

const claimWelcome = createWelcomeGate();

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
      }, 6000);
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
  return <span className={`arrival-greeting${welcoming ? " is-welcoming" : ""}`}>
    <span className="arrival-original">{children}</span>
    <span className="arrival-words" aria-hidden="true">回家了，真好。</span>
  </span>;
}

export default function HomeIntro({ familyId }: { familyId?: string }) {
  const welcoming = useWelcome(familyId);
  return (
    <section className={`home-intro${welcoming ? " is-welcoming" : ""}`}>
      <div>
        <span className="home-intro-kicker">
          <span className="pill intro-original">朝夕之间 · 人间相见</span>
          <span className="intro-welcome" aria-hidden="true">回家了，真好。</span>
        </span>
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
