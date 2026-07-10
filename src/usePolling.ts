import { useEffect, useRef, useState } from "react";
import {
  fetchFleet,
  fetchFleetSavings,
  fetchCostBreakdown,
  type Fleet,
  type FleetSavings,
  type CostBreakdownRow,
  type GatewayConfig,
} from "./gateway";

const POLL_MS = 20_000; // ~20s base; feels live for a HUD without hammering the gateway
const JITTER_MS = 5_000; // spread requests so many widgets don't sync up
// Savings is a 30-day figure — refreshing it every few minutes is plenty, and it
// costs one request per workload, so we don't want it on the fast loop.
const SAVINGS_EVERY = 9; // ~every 9th tick (~3 min)

export interface PollState {
  fleet: Fleet | null;
  savings: FleetSavings | null;
  breakdown: CostBreakdownRow[] | null;
  error: string | null;
  loading: boolean;
  lastUpdated: number | null;
}

// Polls /v1/metrics/fleet on an interval. Pauses when the window is hidden
// (tray-collapsed / display asleep) so a backgrounded HUD costs nothing.
export function usePolling(config: GatewayConfig | null): PollState {
  const [state, setState] = useState<PollState>({
    fleet: null,
    savings: null,
    breakdown: null,
    error: null,
    loading: false,
    lastUpdated: null,
  });
  const abortRef = useRef<AbortController | null>(null);
  const tickCount = useRef(0);

  useEffect(() => {
    if (!config) {
      setState({
        fleet: null,
        savings: null,
        breakdown: null,
        error: null,
        loading: false,
        lastUpdated: null,
      });
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    tickCount.current = 0;

    const tick = async () => {
      if (document.hidden) {
        schedule(); // stay parked but keep the loop alive
        return;
      }
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setState((s) => ({ ...s, loading: true }));
      try {
        const fleet = await fetchFleet(config, "24h", ac.signal);
        if (cancelled) return;
        setState((s) => ({
          ...s,
          fleet,
          error: null,
          loading: false,
          lastUpdated: Date.now(),
        }));

        // Refresh savings + breakdown on the first tick and periodically after —
        // both are slow-moving and best-effort; they never break the HUD.
        const n = tickCount.current++;
        if (n === 0 || n % SAVINGS_EVERY === 0) {
          fetchFleetSavings(
            config,
            fleet.workloads.map((w) => w.id),
            ac.signal,
          )
            .then((savings) => {
              if (!cancelled) setState((s) => ({ ...s, savings }));
            })
            .catch(() => {});
          fetchCostBreakdown(config, "day", ac.signal)
            .then((breakdown) => {
              if (!cancelled) setState((s) => ({ ...s, breakdown }));
            })
            .catch(() => {});
        }
      } catch (e) {
        if (cancelled || ac.signal.aborted) return;
        setState((s) => ({
          ...s,
          error: e instanceof Error ? e.message : "unknown error",
          loading: false,
        }));
      } finally {
        if (!cancelled) schedule();
      }
    };

    const schedule = () => {
      timer = setTimeout(tick, POLL_MS + Math.random() * JITTER_MS);
    };

    // Fire immediately when the window becomes visible again.
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      abortRef.current?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [config?.baseUrl, config?.apiKey, config?.workspaceId]);

  return state;
}
