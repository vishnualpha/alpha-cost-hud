//! Reads local coding-agent usage directly from disk — no API, no keys.
//!
//! Claude Code writes full per-message token usage + model to
//! `~/.claude/projects/**/*.jsonl`. We aggregate real tokens and compute cost
//! from per-model pricing. Codex stores sessions under `~/.codex/sessions/**`
//! but on a plan/subscription its token_count events carry no counts, so we
//! surface it only when real data is present.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;

// Per-1M-token USD pricing (input, output, cache-write, cache-read).
fn pricing(model: &str) -> (f64, f64, f64, f64) {
    let m = model.trim_end_matches("[1m]");
    match m {
        _ if m.starts_with("claude-opus") => (15.0, 75.0, 18.75, 1.5),
        _ if m.starts_with("claude-sonnet") => (3.0, 15.0, 3.75, 0.3),
        _ if m.starts_with("claude-haiku") => (0.8, 4.0, 1.0, 0.08),
        _ if m.starts_with("claude-fable") => (0.3, 1.2, 0.375, 0.03),
        // OpenAI / Codex models (cache-read priced at the cached-input rate).
        _ if m.starts_with("gpt-5") => (1.25, 10.0, 1.25, 0.125),
        _ if m.starts_with("gpt-4o-mini") => (0.15, 0.6, 0.15, 0.075),
        _ if m.starts_with("gpt-4o") => (2.5, 10.0, 2.5, 1.25),
        _ if m.starts_with("o1") || m.starts_with("o3") => (15.0, 60.0, 15.0, 7.5),
        // Unknown model — use a mid-tier default so cost isn't silently zero.
        _ => (3.0, 15.0, 3.75, 0.3),
    }
}

#[derive(Serialize, Default, Clone)]
pub struct ModelUsage {
    pub model: String,
    pub tokens: u64,
    pub cost: f64,
    pub calls: u64,
}

#[derive(Serialize, Default, Clone)]
pub struct DayUsage {
    pub day: String, // YYYY-MM-DD
    pub tokens: u64,
    pub cost: f64,
}

#[derive(Serialize, Default)]
pub struct AgentUsage {
    pub agent: String, // "claude-code" | "codex"
    pub available: bool,
    pub total_tokens: u64,
    pub total_cost: f64,
    pub total_calls: u64,
    pub today_tokens: u64,
    pub today_cost: f64,
    pub by_model: Vec<ModelUsage>,
    pub by_day: Vec<DayUsage>, // sorted ascending, recent tail
    pub note: Option<String>,
}

#[derive(Serialize, Default)]
pub struct LocalAgents {
    pub agents: Vec<AgentUsage>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

// Recursively collect *.jsonl files under a dir (bounded depth to stay cheap).
fn jsonl_files(root: &PathBuf, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            jsonl_files(&p, depth + 1, out);
        } else if p.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            out.push(p);
        }
    }
}

fn parse_claude(today: &str) -> AgentUsage {
    let mut agent = AgentUsage {
        agent: "claude-code".into(),
        ..Default::default()
    };
    let Some(home) = home() else {
        return agent;
    };
    let root = home.join(".claude").join("projects");
    if !root.exists() {
        return agent;
    }
    agent.available = true;

    let mut files = Vec::new();
    jsonl_files(&root, 0, &mut files);

    let mut models: HashMap<String, ModelUsage> = HashMap::new();
    let mut days: HashMap<String, DayUsage> = HashMap::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for f in files {
        let Ok(file) = fs::File::open(&f) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let msg = v.get("message").unwrap_or(&v);
            let usage = msg.get("usage");
            let model = msg.get("model").and_then(|m| m.as_str());
            let (Some(usage), Some(model)) = (usage, model) else {
                continue;
            };

            // Dedupe by message id (transcripts can repeat lines).
            if let Some(id) = msg.get("id").and_then(|i| i.as_str()) {
                if !seen.insert(id.to_string()) {
                    continue;
                }
            }

            let g = |k: &str| usage.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
            let inp = g("input_tokens");
            let out = g("output_tokens");
            let cw = g("cache_creation_input_tokens");
            let cr = g("cache_read_input_tokens");
            let tok = inp + out + cw + cr;

            let (pin, pout, pcw, pcr) = pricing(model);
            let cost = inp as f64 / 1e6 * pin
                + out as f64 / 1e6 * pout
                + cw as f64 / 1e6 * pcw
                + cr as f64 / 1e6 * pcr;

            let day = v
                .get("timestamp")
                .and_then(|t| t.as_str())
                .map(|s| s.chars().take(10).collect::<String>())
                .unwrap_or_default();

            let m = models.entry(model.to_string()).or_insert_with(|| ModelUsage {
                model: model.to_string(),
                ..Default::default()
            });
            m.tokens += tok;
            m.cost += cost;
            m.calls += 1;

            if !day.is_empty() {
                let d = days.entry(day.clone()).or_insert_with(|| DayUsage {
                    day: day.clone(),
                    ..Default::default()
                });
                d.tokens += tok;
                d.cost += cost;
            }

            agent.total_tokens += tok;
            agent.total_cost += cost;
            agent.total_calls += 1;
            if day == today {
                agent.today_tokens += tok;
                agent.today_cost += cost;
            }
        }
    }

    let mut by_model: Vec<ModelUsage> = models.into_values().collect();
    by_model.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));
    agent.by_model = by_model;

    let mut by_day: Vec<DayUsage> = days.into_values().collect();
    by_day.sort_by(|a, b| a.day.cmp(&b.day));
    // Keep the recent tail (last 30 days) to bound payload size.
    if by_day.len() > 30 {
        by_day = by_day.split_off(by_day.len() - 30);
    }
    agent.by_day = by_day;

    if agent.total_calls == 0 {
        agent.note = Some("No usage recorded yet".into());
    }
    agent
}

fn parse_codex(today: &str) -> AgentUsage {
    let mut agent = AgentUsage {
        agent: "codex".into(),
        ..Default::default()
    };
    let Some(home) = home() else {
        return agent;
    };
    let root = home.join(".codex").join("sessions");
    if !root.exists() {
        return agent;
    }
    agent.available = true;

    let mut files = Vec::new();
    jsonl_files(&root, 0, &mut files);

    let mut models: HashMap<String, ModelUsage> = HashMap::new();
    let mut days: HashMap<String, DayUsage> = HashMap::new();

    // Each session file carries a CUMULATIVE total_token_usage that grows over
    // the session; we take the LAST token_count event per file as that session's
    // total, and attribute it to the session's date + model.
    for f in &files {
        let Ok(file) = fs::File::open(f) else { continue };
        let mut model = String::from("gpt-5");
        let mut day = String::new();
        let mut last_total: Option<(u64, u64, u64)> = None; // (input, cached, output)

        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if day.is_empty() {
                if let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) {
                    day = ts.chars().take(10).collect();
                }
            }
            if let Some(m) = v.get("model").and_then(|m| m.as_str()) {
                model = m.to_string();
            } else if let Some(m) = v.pointer("/payload/model").and_then(|m| m.as_str()) {
                model = m.to_string();
            }
            // token_count event carries info.total_token_usage
            if let Some(tt) = v.pointer("/payload/info/total_token_usage") {
                let g = |k: &str| tt.get(k).and_then(|n| n.as_u64()).unwrap_or(0);
                last_total = Some((g("input_tokens"), g("cached_input_tokens"), g("output_tokens")));
            }
        }

        if let Some((inp, cached, out)) = last_total {
            // input_tokens here is the total; cached is the subset priced cheaper.
            let uncached = inp.saturating_sub(cached);
            let (pin, pout, _pcw, pcr) = pricing(&model);
            let cost = uncached as f64 / 1e6 * pin
                + cached as f64 / 1e6 * pcr
                + out as f64 / 1e6 * pout;
            let tok = inp + out;

            let m = models.entry(model.clone()).or_insert_with(|| ModelUsage {
                model: model.clone(),
                ..Default::default()
            });
            m.tokens += tok;
            m.cost += cost;
            m.calls += 1;

            if !day.is_empty() {
                let d = days.entry(day.clone()).or_insert_with(|| DayUsage {
                    day: day.clone(),
                    ..Default::default()
                });
                d.tokens += tok;
                d.cost += cost;
            }

            agent.total_tokens += tok;
            agent.total_cost += cost;
            agent.total_calls += 1;
            if day == today {
                agent.today_tokens += tok;
                agent.today_cost += cost;
            }
        }
    }

    let mut by_model: Vec<ModelUsage> = models.into_values().collect();
    by_model.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));
    agent.by_model = by_model;

    let mut by_day: Vec<DayUsage> = days.into_values().collect();
    by_day.sort_by(|a, b| a.day.cmp(&b.day));
    if by_day.len() > 30 {
        by_day = by_day.split_off(by_day.len() - 30);
    }
    agent.by_day = by_day;

    if agent.total_calls == 0 {
        agent.note = Some("No metered usage recorded".into());
    }
    agent
}

#[tauri::command]
pub fn read_local_agents() -> LocalAgents {
    // Today in local time as YYYY-MM-DD, derived without extra deps.
    let today = today_local();
    LocalAgents {
        agents: vec![parse_claude(&today), parse_codex(&today)],
    }
}

// Local date as YYYY-MM-DD. Uses the system clock; good enough for daily buckets.
fn today_local() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    // Apply local UTC offset via libc-free approach: read from a formatted call.
    // Fall back to UTC date math if offset is unknown.
    let offset = local_utc_offset_secs();
    let local = secs + offset;
    ymd_from_unix(local)
}

fn ymd_from_unix(secs: i64) -> String {
    // Days since epoch -> civil date (Howard Hinnant's algorithm).
    let days = secs.div_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

// Best-effort local offset: TZ isn't trivially available without libc calls, so
// we read it from the `date` command once. Cheap and only runs per refresh.
fn local_utc_offset_secs() -> i64 {
    std::process::Command::new("date")
        .arg("+%z")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            let s = s.trim();
            if s.len() < 5 {
                return None;
            }
            let sign = if s.starts_with('-') { -1 } else { 1 };
            let h: i64 = s[1..3].parse().ok()?;
            let m: i64 = s[3..5].parse().ok()?;
            Some(sign * (h * 3600 + m * 60))
        })
        .unwrap_or(0)
}
