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

// ---- Plan framing ----
// How the user pays for their local coding agents:
//  - "subscription" (default): flat monthly fee, so the token cost we compute is
//    API-EQUIVALENT VALUE (what it would cost at pay-as-you-go rates).
//  - "api": metered pay-as-you-go, so the cost is a REAL bill (spent).
// The value number itself (tokens × API price) is identical either way — this
// only changes the label ("value" vs "spent"). Plan price is irrelevant.
export type PlanMode = "subscription" | "api";
