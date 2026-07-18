//! Reads local coding-agent usage directly from disk — no API, no keys.
//!
//! Claude Code writes full per-message token usage + model to
//! `~/.claude/projects/**/*.jsonl`. We aggregate real tokens and compute cost
//! from per-model pricing. Codex stores sessions under `~/.codex/sessions/**`
//! but on a plan/subscription its token_count events carry no counts, so we
//! surface it only when real data is present.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::OnceLock;

// ---- Pricing (data-driven, editable via JSON) ----
// Prices live in pricing.json (bundled) so contributors can update them via PR
// and users can override locally without rebuilding. See load_pricing().

#[derive(Deserialize, Clone)]
struct PriceRule {
    prefix: String,
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

#[derive(Deserialize, Clone)]
struct PriceDefault {
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

#[derive(Deserialize, Clone)]
struct PriceTable {
    rules: Vec<PriceRule>,
    default: PriceDefault,
}

// Bundled defaults, embedded at compile time so pricing works offline.
const BUNDLED_PRICING: &str = include_str!("../pricing.json");

// Load the price table once: prefer a user override at
// ~/.config/alpha-cost-hud/pricing.json, else fall back to the bundled table.
// A malformed override is ignored (bundled wins) so a bad edit can't break cost.
fn price_table() -> &'static PriceTable {
    static TABLE: OnceLock<PriceTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        if let Some(dir) = home() {
            let user = dir.join(".config/alpha-cost-hud/pricing.json");
            if let Ok(text) = fs::read_to_string(&user) {
                if let Ok(t) = serde_json::from_str::<PriceTable>(&text) {
                    return t;
                }
            }
        }
        serde_json::from_str::<PriceTable>(BUNDLED_PRICING)
            .expect("bundled pricing.json must be valid")
    })
}

// Per-1M-token USD pricing (input, output, cache-write, cache-read), matched by
// the first rule whose prefix the model ID starts with; else the default.
fn pricing(model: &str) -> (f64, f64, f64, f64) {
    let m = model.trim_end_matches("[1m]");
    let table = price_table();
    for r in &table.rules {
        if m.starts_with(&r.prefix) {
            return (r.input, r.output, r.cache_write, r.cache_read);
        }
    }
    let d = &table.default;
    (d.input, d.output, d.cache_write, d.cache_read)
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

// Reliability metrics, ported from skillops's retry analysis. A "retry" is a
// user re-prompt after the agent started (a back-and-forth); a "correction" is
// a re-prompt containing a fix/broken/doesn't-work cue. A conversation
// "stabilized" if it ended on the assistant with <=2 retries.
#[derive(Serialize, Default, Clone)]
pub struct Reliability {
    pub conversations: u64,
    pub avg_retry_depth: f64,
    pub max_retry_depth: u64,
    pub high_friction: u64,     // conversations with retryDepth >= 3
    pub stabilization_rate: f64, // 0..1
    pub recurring_failures: u64,
    pub score: u8,              // 0..100 reliability score
    // Two actionable insight lists (phrase, count across sessions):
    // errors your agent repeatedly fails → fix the root cause;
    // requests you repeatedly make → turn into a reusable skill.
    pub errors_to_fix: Vec<(String, u64)>,
    // Skill-worthy WORKFLOWS: substantial sessions (real task title, multi-turn)
    // that used NO skill — you did it the hard way. count = repeats of that task.
    pub skill_candidates: Vec<(String, u64)>,
    pub skill_worthy_total: u64,
}

// A session used a skill if it invoked the Skill tool or a slash-command.
fn uses_skill(v: &serde_json::Value) -> bool {
    let msg = v.get("message").unwrap_or(v);
    match msg.get("content") {
        Some(serde_json::Value::Array(arr)) => arr.iter().any(|b| {
            b.get("type").and_then(|t| t.as_str()) == Some("tool_use")
                && b.get("name")
                    .and_then(|n| n.as_str())
                    .map(|n| n.eq_ignore_ascii_case("skill"))
                    .unwrap_or(false)
        }),
        Some(serde_json::Value::String(s)) => s.contains("<command-name>"),
        _ => false,
    }
}

// The per-session ai-title, if this line is one.
fn ai_title(v: &serde_json::Value) -> Option<String> {
    if v.get("type").and_then(|t| t.as_str()) != Some("ai-title") {
        return None;
    }
    v.get("aiTitle")
        .and_then(|t| t.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// Is a session title a real, skill-worthy TASK (vs. a trivial exchange)?
fn is_task_title(title: &str) -> bool {
    let t = title.to_lowercase();
    // Skip trivial / conversational titles.
    const TRIVIAL: &[&str] = &[
        "single word", "confirmation", "response", "greeting", "acknowledg",
        "question about", "clarif", "chat", "casual", "unknown", "help with a",
    ];
    if TRIVIAL.iter().any(|x| t.contains(x)) {
        return false;
    }
    if title.split_whitespace().count() < 2 {
        return false;
    }
    // Prefer titles that start with a build/task verb.
    const VERBS: &[&str] = &[
        "create", "build", "set up", "setup", "add", "implement", "write",
        "configure", "make", "generate", "deploy", "refactor", "migrate", "wire",
        "integrate", "automate", "design", "fix", "debug",
    ];
    VERBS.iter().any(|v| t.starts_with(v))
}

// Normalize a title for grouping repeats (lowercase, drop trailing detail).
fn title_key(title: &str) -> String {
    title
        .to_lowercase()
        .split_whitespace()
        .take(6)
        .collect::<Vec<_>>()
        .join(" ")
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
    pub reliability: Option<Reliability>,
    pub note: Option<String>,
}

const CORRECTION_CUES: &[&str] = &[
    "fix", "handle", "correct", "update", "change", "include", "missing", "wrong",
    "fails", "broken", "error", "doesn't work", "not working", "still broken",
    "still failing", "didn't handle", "forgot to", "undo", "revert", "instead",
];

fn contains_correction_cue(text: &str) -> bool {
    let lower = text.to_lowercase();
    CORRECTION_CUES.iter().any(|cue| lower.contains(cue))
}

// True if a sentence looks like injected instruction/config text rather than a
// real user correction. These slip in from skill/system prompts embedded in
// "user" turns and pollute the correction list.
fn looks_like_instruction(s: &str) -> bool {
    // code/config refs, path/command fragments, or sentence fragments that start
    // mid-clause (a real correction is usually an imperative).
    s.contains('`')
        || s.contains('/')
        || s.contains('_')
        || s.contains('{')
        || s.contains("skill")
        || s.contains("gstack")
        || s.contains("instruction")
        || s.contains("prefix")
        || s.starts_with("if ")
        || s.starts_with("when ")
        || s.starts_with(", ")
        || s.starts_with("- ")
}

// Pull a few short correction phrases from a real user message.
fn extract_corrections(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut out = Vec::new();
    for sentence in lower.split(['.', '!', '?', '\n']) {
        let s = sentence.trim();
        // Real corrections are short & imperative; skip long or instruction-like.
        if s.len() < 6 || s.split_whitespace().count() > 12 {
            continue;
        }
        if !contains_correction_cue(s) || looks_like_instruction(s) {
            continue;
        }
        let phrase: String = s.split_whitespace().take(8).collect::<Vec<_>>().join(" ");
        if phrase.len() >= 6 {
            out.push(phrase);
        }
        if out.len() >= 3 {
            break;
        }
    }
    out
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

    // Second pass: reliability (retries/corrections/stabilization) per conversation.
    agent.reliability = compute_reliability(&root);

    if agent.total_calls == 0 {
        agent.note = Some("No usage recorded yet".into());
    }
    agent
}

// Flatten a Claude Code message's `content` to plain text, DROPPING tool_result
// blocks (ported from skillops normalize.ts flattenTextContent). Returns None if
// there's no real text (e.g. tool-result-only turns).
fn flatten_content(content: &serde_json::Value) -> Option<String> {
    match content {
        serde_json::Value::String(s) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        serde_json::Value::Array(arr) => {
            let mut toks: Vec<String> = Vec::new();
            for item in arr {
                let ty = item.get("type").and_then(|t| t.as_str());
                if ty == Some("tool_result") {
                    continue; // tool output is not user speech
                }
                if let Some(s) = item.get("text").and_then(|x| x.as_str()) {
                    let clean = sanitize_text(s);
                    if !clean.is_empty() {
                        toks.push(clean);
                    }
                }
            }
            let joined = toks.join(" ");
            (!joined.trim().is_empty()).then(|| joined.trim().to_string())
        }
        _ => None,
    }
}

// Strip tags/code-fences/whitespace; blank out injected context blocks.
fn sanitize_text(text: &str) -> String {
    let lower = text.to_lowercase();
    if lower.contains("<ide_opened_file>")
        || lower.contains("<environment_context>")
        || lower.contains("<permissions instructions>")
    {
        return String::new();
    }
    // crude tag + fenced-code strip
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

// Is this user message noise (system-injected, not an actual re-prompt)?
// Ported from skillops isNoiseMessage.
fn is_noise_user(text: &str) -> bool {
    let t = text.to_lowercase();
    if t.trim().len() < 2 {
        return true;
    }
    t.contains("<ide_opened_file>")
        || t.contains("<environment_context>")
        || t.contains("# agents.md instructions for")
        || t.contains("<permissions instructions>")
        || t.contains("this may or may not be related")
        || t.contains("request interrupted")
        || t.contains("tool use")
        || t.contains("tool result")
        || t.starts_with("bash ")
        || t.contains("[system notification")
        || t.contains("caveat: the messages below")
        || t.contains("<system-reminder>")
}

// Real user text from a Claude Code JSONL row, or None if it's a tool-result
// turn or system-injected noise.
fn user_text(v: &serde_json::Value) -> Option<String> {
    let msg = v.get("message").unwrap_or(v);
    if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
        return None;
    }
    let content = msg.get("content")?;
    // Skip tool-result-only turns.
    if let serde_json::Value::Array(arr) = content {
        if !arr.is_empty()
            && arr
                .iter()
                .all(|e| e.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
        {
            return None;
        }
    }
    let text = flatten_content(content)?;
    if is_noise_user(&text) {
        return None;
    }
    Some(text)
}

fn is_assistant(v: &serde_json::Value) -> bool {
    v.get("message")
        .unwrap_or(v)
        .get("role")
        .and_then(|r| r.as_str())
        == Some("assistant")
}

// Extract REAL tool failures from a message: tool_result blocks with
// is_error:true. Returns short, normalized error signatures (first line, capped)
// so the same failure recurring across sessions groups together.
fn tool_errors(v: &serde_json::Value) -> Vec<String> {
    let msg = v.get("message").unwrap_or(v);
    let mut out = Vec::new();
    if let Some(serde_json::Value::Array(arr)) = msg.get("content") {
        for b in arr {
            if b.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                continue;
            }
            if b.get("is_error").and_then(|e| e.as_bool()) != Some(true) {
                continue;
            }
            let raw = match b.get("content") {
                Some(serde_json::Value::String(s)) => s.clone(),
                Some(serde_json::Value::Array(a)) => a
                    .iter()
                    .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => continue,
            };
            let sig = normalize_error(&raw);
            if !sig.is_empty() {
                out.push(sig);
            }
        }
    }
    out
}

// Turn a raw error into a stable signature: first meaningful line, strip
// volatile bits (paths, numbers, hashes) so recurrences group.
fn normalize_error(raw: &str) -> String {
    // Strip the <tool_use_error> wrapper and tags first.
    let cleaned = raw.replace("<tool_use_error>", "").replace("</tool_use_error>", "");
    let first = cleaned
        .lines()
        .map(|l| l.trim())
        .find(|l| l.len() > 3)
        .unwrap_or("")
        .to_lowercase();
    // Skip non-failures and too-vague signatures.
    if first.contains("requires approval")
        || first.contains("user rejected")
        || first.contains("doesn't want to proceed")
        || first.starts_with("exit code")
        || first.starts_with("command failed")
    {
        return String::new();
    }
    let mut sig = String::with_capacity(first.len());
    for ch in first.chars() {
        if ch.is_ascii_digit() {
            continue;
        }
        sig.push(ch);
    }
    // Cap length; strip a trailing "note:..." tail.
    let sig = sig.split(" note:").next().unwrap_or(&sig);
    let sig: String = sig.split_whitespace().take(9).collect::<Vec<_>>().join(" ");
    if sig.len() < 8 {
        String::new()
    } else {
        sig
    }
}

// Reliability analysis, ported from skillops. Each conversation file: retryDepth
// = user messages after the first assistant reply; corrections = those with a
// fix/broken cue; stabilized = ended on assistant with retryDepth <= 2.
fn compute_reliability(root: &std::path::Path) -> Option<Reliability> {
    let mut files = Vec::new();
    jsonl_files(&std::path::PathBuf::from(root), 0, &mut files);
    if files.is_empty() {
        return None;
    }

    let mut retry_depths: Vec<u64> = Vec::new();
    let mut stabilized_count: u64 = 0;
    let mut correction_freq: HashMap<String, u64> = HashMap::new();
    // Real tool failures, deduped per conversation, counted across sessions.
    let mut error_freq: HashMap<String, u64> = HashMap::new();
    // Skill-worthy workflows: (normalized title -> [display title, repeat count]).
    let mut skill_titles: HashMap<String, (String, u64)> = HashMap::new();

    for f in &files {
        let Ok(file) = fs::File::open(f) else { continue };
        // Roles in order, plus per-conversation correction set.
        let mut roles: Vec<char> = Vec::new(); // 'u' | 'a'
        let mut first_assistant: Option<usize> = None;
        let mut convo_corrections: std::collections::HashSet<String> = Default::default();
        let mut convo_errors: std::collections::HashSet<String> = Default::default();
        let mut session_title: Option<String> = None;
        let mut session_used_skill = false;

        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if let Some(t) = ai_title(&v) {
                session_title = Some(t); // last title wins (final summary)
            }
            if uses_skill(&v) {
                session_used_skill = true;
            }
            // Real tool failures (from either role's tool_result blocks).
            for e in tool_errors(&v) {
                convo_errors.insert(e);
            }
            if is_assistant(&v) {
                if first_assistant.is_none() {
                    first_assistant = Some(roles.len());
                }
                roles.push('a');
            } else if let Some(text) = user_text(&v) {
                // Only count corrections from user turns AFTER the agent started.
                if first_assistant.is_some() {
                    for c in extract_corrections(&text) {
                        convo_corrections.insert(c);
                    }
                }
                roles.push('u');
            }
        }
        for e in convo_errors {
            *error_freq.entry(e).or_insert(0) += 1;
        }

        let Some(fa) = first_assistant else { continue };
        // retryDepth = user turns after the first assistant reply.
        let retry_depth = roles[fa + 1..].iter().filter(|&&r| r == 'u').count() as u64;
        let last_is_assistant = roles.last() == Some(&'a');
        if last_is_assistant && retry_depth <= 2 {
            stabilized_count += 1;
        }
        retry_depths.push(retry_depth);
        for c in convo_corrections {
            *correction_freq.entry(c).or_insert(0) += 1;
        }

        // Skill-worthy = a substantial task (real title, several turns) done WITHOUT
        // using any skill. That's the "you should make a skill for this" signal.
        let turns = roles.len() as u64;
        if !session_used_skill && turns >= 4 {
            if let Some(title) = session_title {
                if is_task_title(&title) {
                    let key = title_key(&title);
                    let e = skill_titles.entry(key).or_insert((title.clone(), 0));
                    e.1 += 1;
                }
            }
        }
    }

    let total = retry_depths.len() as u64;
    if total == 0 {
        return None;
    }
    let sum: u64 = retry_depths.iter().sum();
    let avg = sum as f64 / total as f64;
    let max = *retry_depths.iter().max().unwrap_or(&0);
    let high_friction = retry_depths.iter().filter(|&&d| d >= 3).count() as u64;
    let stabilization_rate = stabilized_count as f64 / total as f64;
    let recurring = correction_freq.values().filter(|&&c| c >= 2).count() as u64;
    let failure_recurrence_rate = if correction_freq.is_empty() {
        0.0
    } else {
        recurring as f64 / correction_freq.len() as f64
    };

    // Compounding score (skillops baseline formula): retry (100=zero retries,
    // 0=5+ avg), failure-recurrence (100=none), stabilization (direct %).
    let retry_component = (100.0 - avg * 20.0).clamp(0.0, 100.0);
    let recurrence_component = ((1.0 - failure_recurrence_rate) * 100.0).clamp(0.0, 100.0);
    let stabilization_component = (stabilization_rate * 100.0).clamp(0.0, 100.0);
    let score = (retry_component * 0.4 + recurrence_component * 0.3 + stabilization_component * 0.3)
        .round() as u8;

    // errors_to_fix = REAL tool failures (is_error:true) recurring across >=2
    // sessions. skill_candidates = whole skill-worthy WORKFLOWS (a real task done
    // without any skill), sorted by repeats then recency of collection.
    let mut errors: Vec<(String, u64)> = error_freq
        .into_iter()
        .filter(|(_, c)| *c >= 2)
        .collect();
    let skill_worthy_total = skill_titles.len() as u64;
    let mut skills: Vec<(String, u64)> = skill_titles.into_values().collect();
    // Recurring tasks (count>1) first, then the rest; cap the count for display.
    skills.sort_by(|a, b| b.1.cmp(&a.1));
    errors.sort_by(|a, b| b.1.cmp(&a.1));
    errors.truncate(3);
    skills.truncate(3);

    Some(Reliability {
        conversations: total,
        avg_retry_depth: (avg * 100.0).round() / 100.0,
        max_retry_depth: max,
        high_friction,
        stabilization_rate: (stabilization_rate * 1000.0).round() / 1000.0,
        recurring_failures: recurring,
        score,
        errors_to_fix: errors,
        skill_candidates: {
            skills.truncate(3);
            skills
        },
        skill_worthy_total,
    })
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
