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

// ---- Budget streak ----
export interface BudgetStatus {
  /** No budget set — nothing to track. */
  unset: boolean;
  /** Consecutive COMPLETED days (most recent first, excluding today) under budget. */
  streak: number;
  /** Today's spend so far. */
  todaySpend: number;
  /** Is today's spend already over the daily budget? */
  overToday: boolean;
}

/**
 * A real streak, computed from actual daily spend.
 *
 * Merges every agent's by_day series into one daily total, then walks backwards
 * from the most recent COMPLETED day counting days under budget. Today is
 * excluded from the streak (it's still in progress — you could still go over),
 * and reported separately so the UI can show "on track" vs "over".
 */
export function budgetStatus(
  agents: AgentUsage[],
  dailyBudget: number,
  todayISO: string,
): BudgetStatus {
  const todaySpend = agents.reduce((s, a) => s + a.today_cost, 0);
  if (!dailyBudget || dailyBudget <= 0) {
    return { unset: true, streak: 0, todaySpend, overToday: false };
  }

  // Merge all agents' daily costs into one map: day -> total spend.
  const byDay = new Map<string, number>();
  for (const a of agents) {
    for (const d of a.by_day) {
      byDay.set(d.day, (byDay.get(d.day) ?? 0) + d.cost);
    }
  }
  if (byDay.size === 0) {
    return { unset: false, streak: 0, todaySpend, overToday: todaySpend > dailyBudget };
  }

  // Walk backwards over CALENDAR days from yesterday. A day with no recorded
  // usage simply has zero spend (you didn't code) — that's under budget, so it
  // continues the streak rather than breaking it. Stop at the first day over.
  // Bound the walk by the oldest day we have data for.
  const oldest = [...byDay.keys()].sort()[0];
  let streak = 0;
  const cursor = new Date(`${todayISO}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() - 1); // start at yesterday
  while (true) {
    const day = cursor.toISOString().slice(0, 10);
    if (day < oldest) break; // no data older than this — stop counting
    if ((byDay.get(day) ?? 0) <= dailyBudget) streak++;
    else break;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  return { unset: false, streak, todaySpend, overToday: todaySpend > dailyBudget };
}

// ---- Plan framing ----
// How the user pays for their local coding agents:
//  - "subscription" (default): flat monthly fee, so the token cost we compute is
//    API-EQUIVALENT VALUE (what it would cost at pay-as-you-go rates).
//  - "api": metered pay-as-you-go, so the cost is a REAL bill (spent).
// The value number itself (tokens × API price) is identical either way — this
// only changes the label ("value" vs "spent"). Plan price is irrelevant.
export type PlanMode = "subscription" | "api";
