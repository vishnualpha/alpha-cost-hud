// Local coding-agent usage, read from disk by the Rust `read_local_agents`
// command. Claude Code/Codex on a subscription pay a flat fee, so the token
// cost we compute is API-EQUIVALENT value, not a literal bill. The plan setting
// (below) controls how the UI frames it.

import { invoke } from "@tauri-apps/api/core";

export interface ModelUsage {
  model: string;
  tokens: number;
  cost: number;
  calls: number;
}
export interface DayUsage {
  day: string;
  tokens: number;
  cost: number;
}
export interface AgentUsage {
  agent: string; // "claude-code" | "codex"
  available: boolean;
  total_tokens: number;
  total_cost: number;
  total_calls: number;
  today_tokens: number;
  today_cost: number;
  by_model: ModelUsage[];
  by_day: DayUsage[];
  note: string | null;
}
export interface LocalAgents {
  agents: AgentUsage[];
}

export async function readLocalAgents(): Promise<LocalAgents> {
  return invoke<LocalAgents>("read_local_agents");
}

// ---- Time range ----
export type TimeRange = "today" | "week" | "month";

export const RANGE_LABEL: Record<TimeRange, string> = {
  today: "today",
  week: "this week",
  month: "this month",
};
export const RANGE_DAYS: Record<TimeRange, number> = { today: 1, week: 7, month: 30 };

// Sum an agent's cost + tokens over the selected window using its by_day series.
// "today" uses the precomputed today_* fields; week/month sum the recent tail.
export function agentWindow(agent: AgentUsage, range: TimeRange): { cost: number; tokens: number } {
  if (range === "today") return { cost: agent.today_cost, tokens: agent.today_tokens };
  const tail = agent.by_day.slice(-RANGE_DAYS[range]);
  return {
    cost: tail.reduce((s, d) => s + d.cost, 0),
    tokens: tail.reduce((s, d) => s + d.tokens, 0),
  };
}

// ---- Plan framing ----
// How the user pays for their local coding agents:
//  - "subscription" (default): flat monthly fee, so the token cost we compute is
//    API-EQUIVALENT VALUE (what it would cost at pay-as-you-go rates).
//  - "api": metered pay-as-you-go, so the cost is a REAL bill (spent).
// The value number itself (tokens × API price) is identical either way — this
// only changes the label ("value" vs "spent"). Plan price is irrelevant.
export type PlanMode = "subscription" | "api";
