export const WELCOME_DURATION_MS = 3000;

type WelcomeClock = {
  now: () => number;
  schedule: (callback: () => void, delay: number) => number;
  cancel: (id: number) => void;
};

/** Count foreground time only; the entry is independent of account/family requests. */
export function createWelcomeTimer(onFinish: () => void, clock: WelcomeClock) {
  let remaining = WELCOME_DURATION_MS;
  let startedAt: number | undefined;
  let timer: number | undefined;
  let finished = false;
  const pause = () => {
    if (timer !== undefined) clock.cancel(timer);
    timer = undefined;
    if (startedAt !== undefined) remaining = Math.max(0, remaining - (clock.now() - startedAt));
    startedAt = undefined;
  };
  return {
    setVisible(visible: boolean) {
      if (finished || (visible && startedAt !== undefined)) return;
      pause();
      if (!visible) return;
      startedAt = clock.now();
      timer = clock.schedule(() => {
        finished = true;
        timer = undefined;
        startedAt = undefined;
        onFinish();
      }, remaining);
    },
    dispose() {
      pause();
      finished = true;
    },
  };
}
