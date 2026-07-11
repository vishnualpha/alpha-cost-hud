import { fetch } from "@tauri-apps/plugin-http";
import type { ProviderConnector, ProviderResult, ProviderId } from "./types";

// Start-of-today as a UNIX timestamp (seconds), local time.
function startOfTodayUnix(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

async function safe<T>(fn: () => Promise<T>): Promise<T | { __err: string }> {
  try {
    return await fn();
  } catch (e) {
    return { __err: e instanceof Error ? e.message : "request failed" };
  }
}

function fail(provider: ProviderId, error: string): ProviderResult {
  return { provider, spendToday: null, creditsRemaining: null, ok: false, error };
}

// ---- Anthropic: Usage & Cost Admin API ----
// GET /v1/organizations/cost_report — needs an Admin key (sk-ant-admin-…).
// Docs: platform.claude.com/docs/en/api/admin/cost_report
const anthropic: ProviderConnector = {
  id: "anthropic",
  label: "Anthropic",
  keyHint: "Admin key — sk-ant-admin-…",
  keyUrl: "https://platform.claude.com/settings/admin-keys",
  async fetchUsage(apiKey, signal) {
    const start = startOfTodayUnix();
    const url = `https://api.anthropic.com/v1/organizations/cost_report?starting_at=${start}&bucket_width=1d`;
    const res = await safe(() =>
      fetch(url, {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal,
      }),
    );
    if ("__err" in res) return fail("anthropic", res.__err);
    if (res.status === 401 || res.status === 403)
      return fail("anthropic", "Unauthorized — needs an Admin key");
    if (!res.ok) return fail("anthropic", `HTTP ${res.status}`);

    const body = (await res.json()) as {
      data?: Array<{ results?: Array<{ amount?: number; cost?: number }> }>;
    };
    // Sum cost across buckets/results (amounts are USD).
    let spend = 0;
    for (const bucket of body.data ?? []) {
      for (const r of bucket.results ?? []) {
        spend += Number(r.amount ?? r.cost ?? 0);
      }
    }
    return {
      provider: "anthropic",
      spendToday: spend,
      creditsRemaining: null,
      ok: true,
    };
  },
};

// ---- OpenAI: Costs API ----
// GET /v1/organization/costs — needs an Admin key (sk-admin-…).
const openai: ProviderConnector = {
  id: "openai",
  label: "OpenAI",
  keyHint: "Admin key — sk-admin-…",
  keyUrl: "https://platform.openai.com/settings/organization/admin-keys",
  async fetchUsage(apiKey, signal) {
    // OpenAI buckets are UTC-day aligned. Start from 00:00 UTC of the current
    // day and request a few buckets so we capture the whole day regardless of
    // the user's timezone offset. amount.value comes back as a STRING.
    const now = new Date();
    const utcMidnight = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
    const url = `https://api.openai.com/v1/organization/costs?start_time=${utcMidnight}&bucket_width=1d&limit=2`;
    const res = await safe(() =>
      fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal }),
    );
    if ("__err" in res) return fail("openai", res.__err);
    if (res.status === 401 || res.status === 403)
      return fail("openai", "Unauthorized — needs an Admin key");
    if (!res.ok) return fail("openai", `HTTP ${res.status}`);

    const body = (await res.json()) as {
      data?: Array<{ results?: Array<{ amount?: { value?: string | number } }> }>;
    };
    let spend = 0;
    for (const bucket of body.data ?? []) {
      for (const r of bucket.results ?? []) {
        spend += Number(r.amount?.value ?? 0);
      }
    }
    return { provider: "openai", spendToday: spend, creditsRemaining: null, ok: true };
  },
};

// ---- OpenRouter: credits/key ----
// GET /api/v1/credits — total_credits & total_usage; balance = difference.
const openrouter: ProviderConnector = {
  id: "openrouter",
  label: "OpenRouter",
  keyHint: "Any API key — sk-or-… (works without admin)",
  keyUrl: "https://openrouter.ai/keys",
  async fetchUsage(apiKey, signal) {
    const res = await safe(() =>
      fetch("https://openrouter.ai/api/v1/credits", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      }),
    );
    if ("__err" in res) return fail("openrouter", res.__err);
    if (res.status === 401 || res.status === 403)
      return fail("openrouter", "Unauthorized — check the key");
    if (!res.ok) return fail("openrouter", `HTTP ${res.status}`);

    const body = (await res.json()) as {
      data?: { total_credits?: number; total_usage?: number };
    };
    const credits = Number(body.data?.total_credits ?? 0);
    const usage = Number(body.data?.total_usage ?? 0);
    return {
      provider: "openrouter",
      // OpenRouter's credits endpoint is lifetime, not per-day; expose the
      // remaining balance rather than a bogus "today" number.
      spendToday: null,
      creditsRemaining: Math.max(0, credits - usage),
      ok: true,
    };
  },
};

export const CONNECTORS: Record<ProviderId, ProviderConnector> = {
  anthropic,
  openai,
  openrouter,
};

export const CONNECTOR_LIST = Object.values(CONNECTORS);
