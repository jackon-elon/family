import { useEffect, useRef, useState, type ReactNode } from "react";
import { createWelcomeGate } from "../shared/home-welcome";

const claimWelcome = createWelcomeGate();

function useWelcome(familyId?: string) {
  const [welcoming, setWelcoming] = useState(false);
  const started = useRef<string | undefined>(undefined);
  useEffect(() => {
    setWelcoming(false);
    if (!familyId) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (preference.matches) return;
    // React StrictMode repeats effect setup; retain this mount's claim and timer.
    if (started.current !== familyId && !claimWelcome(familyId)) return;
    started.current = familyId;
    setWelcoming(true);
    const timer = window.setTimeout(() => setWelcoming(false), 3200);
    const stop = () => setWelcoming(false);
    preference.addEventListener("change", stop);
    return () => {
      window.clearTimeout(timer);
      preference.removeEventListener("change", stop);
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
