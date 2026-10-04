/** Treat server cooldown as a delay, never as a client/server clock timestamp. */
export function retryDelay(value: unknown): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(86400, Math.ceil(seconds))
    : 900;
}

export function retryRemaining(until: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

export function retryLabel(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 后可重试`;
}
