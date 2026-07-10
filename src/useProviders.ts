import { useEffect, useState, useCallback, useRef } from "react";
import { getProviderKey } from "./config";
import { CONNECTOR_LIST } from "./providers/connectors";
import type { ProviderResult, ProviderId } from "./providers/types";

const POLL_MS = 120_000; // provider cost data is daily-granularity; 2 min is plenty

export interface ProvidersState {
  results: ProviderResult[];
  loading: boolean;
  // Bumps whenever keys change so the caller can re-run.
  refresh: () => void;
}

// Polls every direct provider that has a key in the keychain. Skips providers
// with no key. Best-effort — a failing provider shows an error row, never
// breaks the others.
export function useProviders(): ProvidersState {
  const [results, setResults] = useState<ProviderResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (document.hidden) {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);

      // Find which providers have a stored key.
      const withKeys = (
        await Promise.all(
          CONNECTOR_LIST.map(async (c) => {
            const key = await getProviderKey(c.id).catch(() => null);
            return key ? { connector: c, key } : null;
          }),
        )
      ).filter(Boolean) as Array<{
        connector: (typeof CONNECTOR_LIST)[number];
        key: string;
      }>;

      const out = await Promise.all(
        withKeys.map(({ connector, key }) =>
          connector.fetchUsage(key, ac.signal).catch(
            (e): ProviderResult => ({
              provider: connector.id as ProviderId,
              spendToday: null,
              creditsRemaining: null,
              ok: false,
              error: e instanceof Error ? e.message : "failed",
            }),
          ),
        ),
      );

      if (cancelled || ac.signal.aborted) return;
      setResults(out);
      setLoading(false);
      timer = setTimeout(tick, POLL_MS);
    };

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [nonce]);

  return { results, loading, refresh };
}
