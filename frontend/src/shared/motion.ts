export const motionAllowed = () =>
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A new interaction owns its frames; cancellation must never commit an old target. */
export function animateProgress(
  update: (progress: number) => void,
  duration = 240,
  request = requestAnimationFrame,
  cancel = cancelAnimationFrame,
) {
  let frame = 0;
  let start: number | undefined;
  let stopped = false;
  const tick = (time: number) => {
    if (stopped) return;
    start ??= time;
    const t = Math.min(1, (time - start) / duration);
    update(1 - (1 - t) ** 3);
    if (t < 1 && !stopped) frame = request(tick);
  };
  frame = request(tick);
  return () => {
    stopped = true;
    cancel(frame);
  };
}
