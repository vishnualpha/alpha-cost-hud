// Pluggable direct-provider connectors. Each provider (Anthropic, OpenAI,
// OpenRouter, …) implements this interface. Keys live in the OS keychain; all
// calls go through Tauri's HTTP plugin (Rust-side) so there's no CORS problem,
// exactly like the gateway client. Modeled on how CostGoat/CodexBar connect:
// local API keys, no consumer OAuth (no cost API exists behind those logins).

export type ProviderId = "anthropic" | "openai" | "openrouter";

export interface ProviderResult {
  // Real connectors use ProviderId; demo/mock rows may carry any label string.
  provider: ProviderId | string;
  // Optional display name — overrides the connector lookup when set (demo rows).
  label?: string;
  // Spend for the current window (today, in USD). null if the provider only
  // exposes a credit balance, not per-window spend.
  spendToday: number | null;
  // Remaining prepaid credit balance in USD, if the provider exposes one.
  creditsRemaining: number | null;
  // Optional per-model split for the expanded panel.
  byModel?: Array<{ model: string; cost: number }>;
  // True if the call succeeded; on failure `error` explains why.
  ok: boolean;
  error?: string;
}

export interface ProviderConnector {
  id: ProviderId;
  label: string;
  // Human hint for the key field (e.g. "Admin key — sk-ant-admin-…").
  keyHint: string;
  // Where to get the key.
  keyUrl: string;
  fetchUsage(apiKey: string, signal?: AbortSignal): Promise<ProviderResult>;
}
