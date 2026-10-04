import { useCallback, useEffect, useRef, useState } from "react";
import { rpc, errorText } from "./api";
import type { GuestBirthdays } from "./types";
import { birthdayRefreshDelay } from "./shared/guest-birthdays";

type Snapshot = {
  birthdays: GuestBirthdays;
  serverTime: number;
  receivedAt: number;
};
export function useFamilyBirthdays(
  circleId: string | undefined,
  people: unknown,
) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const load = useCallback(async () => {
    if (!people) return;
    const version = ++generation.current;
    setLoading(true);
    try {
      const result = await rpc<GuestBirthdays & { serverTime: number }>(
        "birthday.upcoming",
        { circleId, days: 30 },
      );
      if (version === generation.current)
        setSnapshot({
          birthdays: result,
          serverTime: result.serverTime,
          receivedAt: Date.now(),
        });
    } catch (error) {
      if (version === generation.current)
        setSnapshot({
          birthdays: {
            events: [],
            asOf: "",
            refreshAt: 0,
            error: errorText(error),
          },
          serverTime: 0,
          receivedAt: Date.now(),
        });
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [circleId, people]);
  useEffect(() => {
    setSnapshot(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    if (!snapshot || snapshot.birthdays.error) return;
    const refresh = () => {
      if (birthdayRefreshDelay(snapshot) === 0) void load();
    };
    const visible = () => {
      if (!document.hidden) refresh();
    };
    const delay = birthdayRefreshDelay(snapshot);
    const timer =
      delay === null ? undefined : window.setTimeout(refresh, delay + 25);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [snapshot, load]);
  return { birthdays: snapshot?.birthdays, loading, load };
}
