import { useState, useEffect, useRef, useCallback } from "react";

export function usePolling<T>(
  url: string,
  intervalMs: number,
  paused: boolean = false
): { data: T | null; loading: boolean; lastUpdated: Date | null; refetch: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFetchRef = useRef<number>(0);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const json = await res.json();
      setData(json);
      lastFetchRef.current = Date.now();
      setLastUpdated(new Date());
    } catch {
      // silently fail, keep previous data
    } finally {
      setLoading(false);
    }
  }, [url]);

  // Schedule the next fetch after the current one completes
  const scheduleNext = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(async () => {
      await fetchData();
      scheduleNext();
    }, intervalMs);
  }, [fetchData, intervalMs]);

  // Main polling effect: initial fetch + setTimeout chain
  useEffect(() => {
    if (paused) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      return;
    }

    // Fetch immediately, then start the chain
    fetchData().then(() => scheduleNext());

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    };
  }, [fetchData, scheduleNext, paused]);

  // Refresh immediately when the tab becomes visible again
  // (browsers throttle/pause timers in background tabs)
  useEffect(() => {
    if (paused) return;

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        // Only re-fetch if most of the interval has elapsed since the last fetch.
        // This avoids hammering the server every time the user switches browser tabs.
        const elapsed = Date.now() - lastFetchRef.current;
        if (elapsed >= intervalMs * 0.75) {
          fetchData().then(() => scheduleNext());
        }
      }
    };

    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fetchData, scheduleNext, paused]);

  const refetch = useCallback(() => {
    setLoading(true);
    fetchData().then(() => scheduleNext());
  }, [fetchData, scheduleNext]);

  return { data, loading, lastUpdated, refetch };
}
