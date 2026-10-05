import { useEffect, useRef, useState } from "react";
import { Volume2, Square } from "lucide-react";
import { createPersonSpeaker, type SpeechState } from "../shared/person-speech";

export default function PersonSpeech({ text }: { text: string }) {
  const [state, setState] = useState<SpeechState>({
    playing: false,
    message: "",
  });
  const speaker = useRef<ReturnType<typeof createPersonSpeaker> | null>(null);
  useEffect(() => {
    if (
      typeof window.speechSynthesis === "undefined" ||
      typeof window.SpeechSynthesisUtterance === "undefined"
    )
      return;
    const player = createPersonSpeaker(
      window.speechSynthesis,
      (value) => new SpeechSynthesisUtterance(value),
      setState,
    );
    speaker.current = player;
    // Some mobile browsers initialise their voice list asynchronously.
    try {
      window.speechSynthesis.getVoices();
    } catch {
      /* Retry on click. */
    }
    const hide = () => {
      if (document.hidden) player.stop();
    };
    const leave = () => player.stop();
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", leave);
    return () => {
      speaker.current = null;
      player.dispose();
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", leave);
    };
  }, []);
  return (
    <div className="person-speech">
      <button
        type="button"
        className="button secondary"
        aria-pressed={state.playing}
        onClick={() => {
          if (!speaker.current) {
            setState({
              playing: false,
              message: "这个浏览器不支持朗读，请换手机浏览器试试。",
            });
          } else if (state.playing) speaker.current.stop();
          else speaker.current.play(text);
        }}
      >
        {state.playing ? <Square size={21} /> : <Volume2 size={23} />}
        {state.playing ? "停止朗读" : "听一听"}
      </button>
      {state.message && (
        <p role="status" className="contact-feedback">
          {state.message}
        </p>
      )}
    </div>
  );
}
