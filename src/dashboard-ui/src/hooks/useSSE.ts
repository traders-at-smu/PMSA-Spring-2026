import { useState, useEffect, useRef } from "react";

export function useSSE<T>(url: string, paused: boolean = false): { data: T | null; connected: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (paused) {
      sourceRef.current?.close();
      sourceRef.current = null;
      setConnected(false);
      return;
    }

    const source = new EventSource(url);
    sourceRef.current = source;

    source.onopen = () => setConnected(true);
    source.onmessage = (e) => {
      try {
        setData(JSON.parse(e.data));
      } catch {
        // ignore parse errors
      }
    };
    source.onerror = () => setConnected(false);

    return () => {
      source.close();
      sourceRef.current = null;
    };
  }, [url, paused]);

  return { data, connected };
}
