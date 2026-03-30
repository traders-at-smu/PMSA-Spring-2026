import { useState, useEffect, useRef } from "react";

type Subscriber<T> = {
  setData: (value: T | null) => void;
  setConnected: (value: boolean) => void;
};

type StreamEntry = {
  source: EventSource | null;
  connected: boolean;
  lastData: unknown | null;
  subscribers: Map<number, Subscriber<any>>;
  closeTimer: number | null;
};

const streams = new Map<string, StreamEntry>();
let nextSubscriberId = 1;
const CLOSE_GRACE_MS = 30_000;

function ensureStream(url: string): StreamEntry {
  let entry = streams.get(url);
  if (entry) return entry;

  entry = {
    source: null,
    connected: false,
    lastData: null,
    subscribers: new Map(),
    closeTimer: null,
  };
  streams.set(url, entry);
  return entry;
}

function broadcast(url: string): void {
  const entry = streams.get(url);
  if (!entry) return;
  for (const sub of entry.subscribers.values()) {
    sub.setConnected(entry.connected);
    sub.setData((entry.lastData as any) ?? null);
  }
}

function openStream(url: string): void {
  const entry = ensureStream(url);
  if (entry.source) return;

  const source = new EventSource(url);
  entry.source = source;

  source.onopen = () => {
    const live = streams.get(url);
    if (!live) return;
    live.connected = true;
    broadcast(url);
  };

  source.onmessage = (e) => {
    const live = streams.get(url);
    if (!live) return;
    try {
      live.lastData = JSON.parse(e.data);
      broadcast(url);
    } catch {
      // ignore parse errors
    }
  };

  source.onerror = () => {
    const live = streams.get(url);
    if (!live) return;
    live.connected = false;
    broadcast(url);
  };
}

function scheduleClose(url: string): void {
  const entry = streams.get(url);
  if (!entry) return;
  if (entry.closeTimer) {
    window.clearTimeout(entry.closeTimer);
  }
  entry.closeTimer = window.setTimeout(() => {
    const latest = streams.get(url);
    if (!latest) return;
    if (latest.subscribers.size > 0) return;
    latest.source?.close();
    streams.delete(url);
  }, CLOSE_GRACE_MS);
}

export function useSSE<T>(url: string, paused: boolean = false): { data: T | null; connected: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);
  const subscriberIdRef = useRef<number | null>(null);

  useEffect(() => {
    const entry = ensureStream(url);
    if (entry.closeTimer) {
      window.clearTimeout(entry.closeTimer);
      entry.closeTimer = null;
    }

    const subscriberId = nextSubscriberId++;
    subscriberIdRef.current = subscriberId;
    entry.subscribers.set(subscriberId, {
      setData: (value: T | null) => setData(value),
      setConnected,
    });

    // Immediately reuse the most recent payload for this URL.
    setConnected(entry.connected);
    setData((entry.lastData as T | null) ?? null);

    if (!paused) {
      openStream(url);
    } else {
      setConnected(false);
    }

    return () => {
      const latest = streams.get(url);
      const id = subscriberIdRef.current;
      if (latest && id != null) {
        latest.subscribers.delete(id);
        if (latest.subscribers.size === 0) {
          latest.connected = false;
          scheduleClose(url);
        }
      }
    };
  }, [url, paused]);

  return { data, connected };
}
