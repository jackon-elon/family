export function personSpeechText({
  name,
  city,
  isSelf,
  readOnly,
  remark,
  relationship,
}: {
  name: string;
  city?: string;
  isSelf?: boolean;
  readOnly?: boolean;
  remark?: string;
  relationship?: { label: string; status?: string };
}): string {
  const parts = [
    !readOnly && isSelf ? `这是你自己，${name}。` : `这是${name}。`,
  ];
  if (!readOnly && !isSelf) {
    if (remark?.trim() && remark.trim() !== name)
      parts.push(`你备注的是${remark.trim()}。`);
    if (relationship?.status === "resolved")
      parts.push(`是你的${relationship.label}。`);
    else if (relationship?.status === "unrelated")
      parts.push("你们的关系还待补充。");
    else if (relationship) parts.push("具体称呼请查看关系说明。");
  }
  if (city?.trim()) parts.push(`目前在${city.trim()}。`);
  return parts.join("");
}

export type SpeechState = { playing: boolean; message: string };
type Engine = Pick<SpeechSynthesis, "speak" | "cancel" | "getVoices">;

/** One current utterance; late callbacks from a cancelled one cannot update UI. */
export function createPersonSpeaker(
  engine: Engine,
  utterance: (text: string) => SpeechSynthesisUtterance,
  onState: (state: SpeechState) => void,
) {
  let current: SpeechSynthesisUtterance | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    if (current) {
      current.onstart = null;
      current.onend = null;
      current.onerror = null;
      current = undefined;
      try {
        engine.cancel();
      } catch {
        /* Already unavailable. */
      }
    }
  };
  const finish = (message = "") => {
    clear();
    if (!disposed) onState({ playing: false, message });
  };
  return {
    play(text: string) {
      if (disposed) return;
      clear();
      try {
        const speech = utterance(text);
        current = speech;
        speech.lang = "zh-CN";
        speech.rate = 0.85;
        const voices = engine
          .getVoices()
          .filter((v) => /^zh(?:[-_]|$)/i.test(v.lang));
        speech.voice =
          voices.find((v) => v.localService && /^zh[-_]CN$/i.test(v.lang)) ||
          voices.find((v) => v.localService) ||
          voices.find((v) => /^zh[-_]CN$/i.test(v.lang)) ||
          voices[0] ||
          null;
        speech.onstart = () => {
          if (current !== speech) return;
          clearTimeout(timer);
          timer = setTimeout(
            () => finish("朗读已停止，可以再点一次听一听。"),
            60000,
          );
        };
        speech.onend = () => {
          if (current === speech) finish();
        };
        speech.onerror = (event) => {
          if (current !== speech) return;
          finish(
            event.error === "canceled" || event.error === "interrupted"
              ? ""
              : "暂时无法朗读，请检查手机的中文语音设置，或换浏览器试试。",
          );
        };
        timer = setTimeout(
          () => finish("没有开始朗读，请再试一次，或换浏览器打开。"),
          10000,
        );
        onState({ playing: true, message: "" });
        engine.speak(speech);
      } catch {
        finish("这个浏览器暂时无法朗读，请换浏览器试试。");
      }
    },
    stop() {
      finish();
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}
