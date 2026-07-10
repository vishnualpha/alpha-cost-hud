import { useEffect, useState, useCallback } from "react";
import { readLocalAgents, type LocalAgents } from "./localAgents";

const POLL_MS = 30_000; // local files change as you work; 30s keeps it fresh & cheap

export interface LocalAgentsState {
  data: LocalAgents | null;
  loading: boolean;
  refresh: () => void;
}

// Reads local coding-agent usage from disk on an interval. Pauses when hidden.
export function useLocalAgents(): LocalAgentsState {
  const [data, setData] = useState<LocalAgents | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (document.hidden) {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      setLoading(true);
      try {
        const d = await readLocalAgents();
        if (!cancelled) setData(d);
      } catch {
        // best-effort; keep last good data
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(tick, POLL_MS);
        }
      }
    };

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [nonce]);

  return { data, loading, refresh };
}
