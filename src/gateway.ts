// Requests go through Tauri's HTTP plugin (Rust-side fetch), NOT the webview's
// fetch. The gateway returns no `access-control-allow-origin` header, so a
// browser/webview fetch is blocked by CORS ("load failed"). The Rust client is
// not a browser origin and bypasses CORS entirely.
import { fetch } from "@tauri-apps/plugin-http";

// Client for the Alpha AI Gateway metrics endpoints the HUD consumes.
// Endpoints (confirmed against the gateway source):
//   GET /v1/metrics/fleet?workspaceId=&window=24h  -> fleet spend + per-workload + anomalies
//   GET /v1/workloads/:id/metrics?window=24h       -> per-workload, incl. savings.estMonthlySavings
// Auth: Authorization: Bearer <api-key>

export interface FleetWorkload {
  id: string;
  name: string;
  status: string;
  requests: number;
  errorRate: number;
  p95: number;
  windowSpend: number;
  toolCalls: number;
  toolErrors: number;
  guardrailTriggers: number;
  budget: { limit: number; monthSpend: number; usagePct: number } | null;
}

export interface FleetAnomaly {
  workloadId: string;
  workloadName: string;
  severity: "critical" | "warning";
  kind: "error_spike" | "budget" | "latency_spike" | "tool_failures";
  message: string;
}

export interface Fleet {
  window: string;
  from: string;
  to: string;
  workloads: FleetWorkload[];
  anomalies: FleetAnomaly[];
  totals: {
    requests: number;
    errors: number;
    spend: number;
    activeWorkloads: number;
  };
}

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  workspaceId: string;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

async function get<T>(
  cfg: GatewayConfig,
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(path, cfg.baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal,
    });
  } catch (e) {
    throw new GatewayError(
      e instanceof Error ? e.message : "network error — is the gateway reachable?",
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new GatewayError("Unauthorized — check your API key", res.status);
  }
  if (!res.ok) {
    throw new GatewayError(`Gateway returned ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export interface Workspace {
  id: string;
  name: string;
}

// ---- In-app login: email/password → JWT → workspaces → minted gw- key ----
// The end user shouldn't need to hand-copy a workspace ID or API key. They log
// in with their Alpha account; the app fetches workspaces and mints a key.

async function post<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
  signal?: AbortSignal,
): Promise<T> {
  const url = baseUrl.replace(/^(https?):\/\//i, (_m, s) => `${s.toLowerCase()}://`).replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new GatewayError(e instanceof Error ? e.message : "network error");
  }
  if (res.status === 401) throw new GatewayError("Invalid email or password", 401);
  if (!res.ok) throw new GatewayError(`Server returned ${res.status}`, res.status);
  return (await res.json()) as T;
}

export async function login(
  baseUrl: string,
  email: string,
  password: string,
  signal?: AbortSignal,
): Promise<string> {
  const body = await post<{ token: string }>(baseUrl, "/v1/auth/login", { email, password }, undefined, signal);
  if (!body.token) throw new GatewayError("Login succeeded but no token returned");
  return body.token;
}

export async function fetchWorkspacesWithToken(
  baseUrl: string,
  token: string,
  signal?: AbortSignal,
): Promise<Workspace[]> {
  const url = baseUrl.replace(/^(https?):\/\//i, (_m, s) => `${s.toLowerCase()}://`).replace(/\/+$/, "");
  const res = await fetch(`${url}/v1/workspaces`, { headers: { Authorization: `Bearer ${token}` }, signal });
  if (!res.ok) throw new GatewayError(`Could not load workspaces (${res.status})`, res.status);
  const body = (await res.json()) as { workspaces: Workspace[] };
  return (body.workspaces || []).map((w) => ({ id: w.id, name: w.name }));
}

// Mints a gw- API key using the login JWT. Returns the raw key (shown once).
export async function mintKey(
  baseUrl: string,
  token: string,
  name = "Alpha Cost HUD",
  signal?: AbortSignal,
): Promise<string> {
  const body = await post<{ apiKey: { key: string } }>(baseUrl, "/v1/keys", { name }, token, signal);
  if (!body.apiKey?.key) throw new GatewayError("Key created but not returned");
  return body.apiKey.key;
}

// Lists the workspaces this key/user can see. Works with a personal gw- key —
// no separate JWT login needed. Used to populate the workspace picker.
export async function fetchWorkspaces(
  cfg: Pick<GatewayConfig, "baseUrl" | "apiKey">,
  signal?: AbortSignal,
): Promise<Workspace[]> {
  const body = await get<{ workspaces: Workspace[] }>(
    { ...cfg, workspaceId: "" },
    "/v1/workspaces",
    {},
    signal,
  );
  return (body.workspaces || []).map((w) => ({ id: w.id, name: w.name }));
}

export async function fetchFleet(
  cfg: GatewayConfig,
  window: "24h" | "7d" = "24h",
  signal?: AbortSignal,
): Promise<Fleet> {
  // The gateway wraps the payload as { fleet: {...} }.
  const body = await get<{ fleet: Fleet }>(
    cfg,
    "/v1/metrics/fleet",
    { workspaceId: cfg.workspaceId, window },
    signal,
  );
  return body.fleet;
}

// Realized savings live on the per-workload endpoint as
// savings.estMonthlySavings (+ savings.fineTune.saved). There is no fleet-wide
// rollup yet, so we fan out across workloads and sum client-side.
export interface WorkloadSavings {
  estMonthlySavings: number;
  fineTune: { saved: number } | null;
}

export async function fetchWorkloadSavings(
  cfg: GatewayConfig,
  workloadId: string,
  signal?: AbortSignal,
): Promise<WorkloadSavings> {
  const body = await get<{ metrics: { savings: WorkloadSavings } }>(
    cfg,
    `/v1/workloads/${encodeURIComponent(workloadId)}/metrics`,
    { window: "24h" },
    signal,
  );
  return body.metrics.savings;
}

export interface CostBreakdownRow {
  provider: string;
  model: string;
  cost: number;
  requests: number;
}

// Provider/model cost split for the expanded panel. The gateway returns cost as
// a string, so we coerce to number here.
export async function fetchCostBreakdown(
  cfg: GatewayConfig,
  range: "day" | "week" | "month" = "day",
  signal?: AbortSignal,
): Promise<CostBreakdownRow[]> {
  const body = await get<{ breakdown: Array<Record<string, string | number>> }>(
    cfg,
    "/v1/platform/cost/breakdown",
    { workspaceId: cfg.workspaceId, range },
    signal,
  );
  return (body.breakdown || []).map((r) => ({
    provider: String(r.provider ?? "?"),
    model: String(r.model ?? "?"),
    cost: Number(r.cost) || 0,
    requests: Number(r.requests) || 0,
  }));
}

export interface FleetSavings {
  // Realized monthly savings Alpha has already delivered across the fleet
  // (cost-per-success improvement vs. baseline + fine-tune counterfactuals).
  realizedMonthly: number;
  // Whether every workload reported; if some calls failed the number is partial.
  complete: boolean;
}

// Fans out per-workload savings and sums them. Skips workloads that error so a
// single bad call never blanks the whole number. Concurrency-capped so a large
// fleet doesn't fire dozens of requests at once.
export async function fetchFleetSavings(
  cfg: GatewayConfig,
  workloadIds: string[],
  signal?: AbortSignal,
): Promise<FleetSavings> {
  if (workloadIds.length === 0) return { realizedMonthly: 0, complete: true };

  const CONCURRENCY = 5;
  let realizedMonthly = 0;
  let failures = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < workloadIds.length) {
      const id = workloadIds[cursor++];
      try {
        const s = await fetchWorkloadSavings(cfg, id, signal);
        realizedMonthly += (s.estMonthlySavings || 0) + (s.fineTune?.saved || 0);
      } catch {
        failures++;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, workloadIds.length) }, worker),
  );

  return { realizedMonthly, complete: failures === 0 };
}
