// Mock data for demo mode — shows how the populated UI looks without real keys.
// Toggle from the config screen; nothing here touches the network.

import type { Fleet, CostBreakdownRow, FleetSavings } from "./gateway";
import type { PollState } from "./usePolling";
import type { ProviderResult } from "./providers/types";
import type { LocalAgents } from "./localAgents";

export const MOCK_FLEET: Fleet = {
  window: "24h",
  from: "",
  to: "",
  workloads: [
    { id: "w1", name: "Support Triage Agent", status: "ACTIVE", requests: 4820, errorRate: 0.4, p95: 1240, windowSpend: 84.12, toolCalls: 3100, toolErrors: 12, guardrailTriggers: 0, budget: { limit: 200, monthSpend: 1420, usagePct: 71 } },
    { id: "w2", name: "Sales Outbound Writer", status: "ACTIVE", requests: 2110, errorRate: 1.9, p95: 2010, windowSpend: 52.4, toolCalls: 900, toolErrors: 44, guardrailTriggers: 2, budget: { limit: 150, monthSpend: 1310, usagePct: 87 } },
    { id: "w3", name: "Doc Summarizer", status: "ACTIVE", requests: 6340, errorRate: 0.1, p95: 780, windowSpend: 41.87, toolCalls: 0, toolErrors: 0, guardrailTriggers: 0, budget: { limit: 100, monthSpend: 640, usagePct: 64 } },
    { id: "w4", name: "Code Review Bot", status: "ACTIVE", requests: 1580, errorRate: 6.2, p95: 3400, windowSpend: 22.05, toolCalls: 1580, toolErrors: 98, guardrailTriggers: 0, budget: { limit: 80, monthSpend: 71, usagePct: 89 } },
    { id: "w5", name: "Data Enrichment", status: "ACTIVE", requests: 980, errorRate: 0.0, p95: 640, windowSpend: 18.9, toolCalls: 400, toolErrors: 0, guardrailTriggers: 0, budget: null },
    { id: "w6", name: "Voice Transcription", status: "ACTIVE", requests: 3200, errorRate: 0.8, p95: 920, windowSpend: 27.6, toolCalls: 0, toolErrors: 0, guardrailTriggers: 0, budget: { limit: 120, monthSpend: 810, usagePct: 68 } },
    { id: "w7", name: "RAG Search API", status: "ACTIVE", requests: 8900, errorRate: 0.3, p95: 540, windowSpend: 33.15, toolCalls: 8900, toolErrors: 26, guardrailTriggers: 0, budget: { limit: 150, monthSpend: 990, usagePct: 66 } },
    { id: "w8", name: "Onboarding Copilot", status: "ACTIVE", requests: 640, errorRate: 3.1, p95: 2600, windowSpend: 11.4, toolCalls: 320, toolErrors: 20, guardrailTriggers: 1, budget: { limit: 60, monthSpend: 55, usagePct: 92 } },
  ],
  anomalies: [
    { workloadId: "w4", workloadName: "Code Review Bot", severity: "critical", kind: "error_spike", message: "Error rate 6.2% (3× baseline)" },
    { workloadId: "w8", workloadName: "Onboarding Copilot", severity: "warning", kind: "budget", message: "92% of monthly budget used" },
    { workloadId: "w2", workloadName: "Sales Outbound Writer", severity: "warning", kind: "budget", message: "87% of monthly budget used" },
  ],
  totals: { requests: 28570, errors: 226, spend: 291.49, activeWorkloads: 8 },
};

export const MOCK_BREAKDOWN: CostBreakdownRow[] = [
  { provider: "anthropic", model: "claude-sonnet-4-6", cost: 112.4, requests: 9200 },
  { provider: "openai", model: "gpt-4o", cost: 68.22, requests: 4600 },
  { provider: "anthropic", model: "claude-haiku-4-5", cost: 29.1, requests: 4100 },
  { provider: "google", model: "gemini-2.5-pro", cost: 24.8, requests: 1400 },
  { provider: "google", model: "gemini-2.5-flash", cost: 14.5, requests: 3100 },
  { provider: "mistral", model: "mistral-large", cost: 9.9, requests: 620 },
  { provider: "openai", model: "gpt-4o-mini", cost: 6.12, requests: 2050 },
  { provider: "meta", model: "llama-3.3-70b", cost: 3.4, requests: 900 },
];

export const MOCK_SAVINGS: FleetSavings = {
  realizedMonthly: 1284,
  complete: true,
};

// Direct-provider spend across Big-4 LLM, aggregators, and cloud-hosted. Mock
// rows carry their own `label` (not tied to a real connector). Mixed states:
// per-day spend, credit balances, and one error to show that path.
export const MOCK_PROVIDERS: ProviderResult[] = [
  { provider: "anthropic", label: "Anthropic", spendToday: 141.5, creditsRemaining: null, ok: true },
  { provider: "openai", label: "OpenAI", spendToday: 74.42, creditsRemaining: null, ok: true },
  { provider: "google-vertex", label: "Google Vertex", spendToday: 39.28, creditsRemaining: null, ok: true },
  { provider: "mistral", label: "Mistral", spendToday: 9.9, creditsRemaining: null, ok: true },
  { provider: "aws-bedrock", label: "AWS Bedrock", spendToday: 22.7, creditsRemaining: null, ok: true },
  { provider: "azure-openai", label: "Azure OpenAI", spendToday: 18.05, creditsRemaining: null, ok: true },
  { provider: "openrouter", label: "OpenRouter", spendToday: null, creditsRemaining: 342.18, ok: true },
  { provider: "together", label: "Together AI", spendToday: null, creditsRemaining: 88.4, ok: true },
  { provider: "fireworks", label: "Fireworks", spendToday: null, creditsRemaining: 41.2, ok: true },
  { provider: "groq", label: "Groq", spendToday: null, creditsRemaining: 0, ok: false, error: "Unauthorized — key expired" },
];

export const MOCK_LOCAL: LocalAgents = {
  agents: [
    {
      agent: "claude-code",
      available: true,
      total_tokens: 2_200_000_000,
      total_cost: 3938.88,
      total_calls: 6464,
      today_tokens: 7_540_000,
      today_cost: 19.67,
      by_model: [
        { model: "claude-opus-4-8", tokens: 1_910_000_000, cost: 3824.52, calls: 5268 },
        { model: "claude-fable-5", tokens: 155_000_000, cost: 58.2, calls: 373 },
        { model: "claude-haiku-4-5", tokens: 18_800_000, cost: 10.71, calls: 443 },
      ],
      by_day: [
        { day: "2026-07-07", tokens: 426_000_000, cost: 916.23 },
        { day: "2026-07-08", tokens: 335_000_000, cost: 687.87 },
        { day: "2026-07-09", tokens: 3_700_000, cost: 9.94 },
        { day: "2026-07-10", tokens: 7_540_000, cost: 19.67 },
      ],
      note: null,
    },
    {
      agent: "codex",
      available: true,
      total_tokens: 88_000_000,
      total_cost: 412.0,
      total_calls: 1240,
      today_tokens: 2_100_000,
      today_cost: 4.1,
      by_model: [{ model: "gpt-5-codex", tokens: 88_000_000, cost: 412.0, calls: 1240 }],
      by_day: [],
      note: null,
    },
  ],
};

export const MOCK_POLL: PollState = {
  fleet: MOCK_FLEET,
  savings: MOCK_SAVINGS,
  breakdown: MOCK_BREAKDOWN,
  error: null,
  loading: false,
  lastUpdated: 0, // stamped at render time so "updated" reads fresh
};
