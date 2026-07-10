import { useState, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import type { PollState } from "../usePolling";
import type { ProviderResult } from "../providers/types";
import type { LocalAgents, PlanMode } from "../localAgents";
import { useCountUp } from "../useCountUp";
import alphaLogo from "../assets/alpha-logo.png";
import "../carousel.css";

// ============================================================================
// This is a 1:1 port of mockups/v2.html — same HTML strings, same class names,
// same CSS. It renders via innerHTML exactly like the mockup so the output is
// byte-identical. Real data is injected through the same helper functions the
// mockup used (money/tk/provRow). DO NOT reinterpret — match the mockup.
// ============================================================================

// Marketing site for prospects; the logged-in app for connected users.
const MARKETING_URL = "https://thealpha.ai";
const APP_URL = "https://app.thealpha.ai";

function money(v: number): string {
  const d = Math.floor(v);
  const c = Math.round((v - d) * 100)
    .toString()
    .padStart(2, "0");
  return `$${d.toLocaleString()}<span class="c">.${c}</span>`;
}
function tk(v: number): string {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}
function provRow(name: string, color: string, icon: string, pct: number, val: string, sub: string): string {
  return `<div class="row">
    <div class="ico" style="background:${color}">${icon}</div>
    <div class="rname">${name}<small>${sub}</small></div>
    <div class="track"><div class="fill" style="width:${pct}%;background:${color}"></div></div>
    <div class="rval">${val}</div>
  </div>`;
}

const BRAND: Record<string, { color: string; icon: string }> = {
  openai: { color: "#10a37f", icon: "AI" },
  anthropic: { color: "#d0782f", icon: "A" },
  google: { color: "#4285f4", icon: "G" },
  "google-vertex": { color: "#4285f4", icon: "G" },
  "aws-bedrock": { color: "#ff9900", icon: "B" },
  "azure-openai": { color: "#0078d4", icon: "Az" },
  mistral: { color: "#f54e42", icon: "M" },
  meta: { color: "#0668e1", icon: "L" },
  openrouter: { color: "#8b5cf6", icon: "OR" },
  together: { color: "#0f6fff", icon: "T" },
  fireworks: { color: "#ff6b35", icon: "F" },
  groq: { color: "#f55036", icon: "Gq" },
};
function brand(id: string) {
  return BRAND[id.toLowerCase()] ?? { color: "#8b8778", icon: id.slice(0, 2).toUpperCase() };
}

// The note under the local-agent rows. The value is tokens × API price either
// way; the plan only changes whether we call it a bill (api) or value (sub).
function localAgentsNote(plan: PlanMode): string {
  return plan === "api"
    ? "Real API spend · read locally · zero setup"
    : "API-equivalent value · what this usage would cost at API rates";
}

// Stable sparkline (mockup used random; fixed here so it doesn't jump).
const SPARK = [38, 30, 52, 44, 60, 48, 72, 55, 40, 66, 50, 78, 58, 46, 70, 62, 54, 82, 68, 48, 60, 74, 56, 44, 66, 52, 76, 60, 50, 64];

interface Slide {
  name: string;
  list?: boolean;
  alpha?: string;
  html: string;
}

interface CarouselProps {
  poll: PollState;
  providers: ProviderResult[];
  local: LocalAgents | null;
  planMode: PlanMode;
  demo: boolean;
  gatewayUrl: string; // the connected gateway base URL ("" if not connected)
  onOpenConfig: () => void;
  onOpenProviders: () => void;
  onHide: () => void;
}

// Derive the dashboard URL from the connected gateway. Deployed api.thealpha.ai
// → app.thealpha.ai; a localhost/custom gateway → its own origin.
function dashboardUrl(gatewayUrl: string): string {
  if (!gatewayUrl) return MARKETING_URL;
  try {
    const u = new URL(gatewayUrl);
    if (u.hostname === "api.thealpha.ai") return APP_URL;
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return `${u.protocol}//${u.host}`;
    // Custom gateway: swap a leading "api." for "app." if present, else use origin.
    const host = u.hostname.startsWith("api.") ? u.hostname.replace(/^api\./, "app.") : u.hostname;
    return `${u.protocol}//${host}`;
  } catch {
    return MARKETING_URL;
  }
}

function buildSlides(
  poll: PollState,
  providers: ProviderResult[],
  local: LocalAgents | null,
  planMode: PlanMode,
  gatewayUrl: string,
  heroSpend?: number,
  heroTok?: number,
): Slide[] {
  // ----- derived numbers -----
  const providerSpend = providers.filter((p) => p.ok && p.spendToday != null).reduce((s, p) => s + (p.spendToday ?? 0), 0);
  const gatewaySpend = poll.fleet?.totals.spend ?? 0;
  const localCost = (local?.agents ?? []).reduce((s, a) => s + a.today_cost, 0);
  const localTokRaw = (local?.agents ?? []).reduce((s, a) => s + a.today_tokens, 0);
  const spendRaw = providerSpend + gatewaySpend + localCost;
  // Hero uses animated (count-up) values when provided.
  const spend = heroSpend ?? spendRaw;
  const localTok = heroTok ?? localTokRaw;

  // 1) TODAY
  const today: Slide = {
    name: "Today · all sources",
    alpha: "Cut this bill <b>24%</b> — same models, smarter routing",
    html: `
    <div class="top">
      <div class="ring"><span class="grade">A–</span></div>
      <div>
        <div class="money">${money(spend)}</div>
        <div class="toks">${tk(localTok)} tokens <span>today</span></div>
        <div class="streak">🔥 7-day under-budget streak</div>
      </div>
    </div>
    <div class="spark">${SPARK.map((h, k) => {
      const delay = (k * 0.02).toFixed(2);
      // last 3 bars keep a gentle live pulse after growing in
      const pulse = k >= SPARK.length - 3 ? `,sparkpulse 1.8s ${(0.6 + k * 0.02).toFixed(2)}s infinite` : "";
      return `<i style="height:${h}%;animation:sparkgrow .6s ${delay}s ease backwards${pulse}"></i>`;
    }).join("")}</div>`,
  };

  // 2) PROVIDERS
  const provs = providers
    .filter((p) => p.ok)
    .map((p) => ({ id: p.provider, label: p.label ?? p.provider, val: p.spendToday ?? p.creditsRemaining ?? 0, credit: p.spendToday == null && p.creditsRemaining != null }))
    .sort((a, b) => b.val - a.val);
  const pMax = Math.max(...provs.map((p) => p.val), 1);
  const providersHtml =
    provs.length === 0
      ? `<div class="stitle">Providers <span class="sub">spend · today</span></div><div style="font-size:11px;color:var(--muted);padding:6px 0">No providers connected — add one in settings</div>`
      : `<div class="stitle">Providers <span class="sub">spend · today</span></div>` +
        provs
          .slice(0, 5)
          .map((p) => {
            const b = brand(p.id);
            const val = p.credit ? `$${Math.round(p.val)} left` : money(p.val).replace(/<[^>]+>/g, "");
            return provRow(p.label, b.color, b.icon, (p.val / pMax) * 100, val, p.credit ? "credit balance" : "today");
          })
          .join("");

  // 3) TOP MODELS
  const models = (poll.breakdown ?? []).slice().sort((a, b) => b.cost - a.cost).slice(0, 5);
  const mMax = Math.max(...models.map((m) => m.cost), 1);
  const modelsHtml =
    models.length === 0
      ? `<div class="stitle">Top models <span class="sub">by cost · today</span></div><div style="font-size:11px;color:var(--muted);padding:6px 0">No model spend today</div>`
      : `<div class="stitle">Top models <span class="sub">by cost · today</span></div>` +
        models.map((m) => provRow(m.model, brand(m.provider).color, "◆", (m.cost / mMax) * 100, `$${m.cost.toFixed(1)}`, m.provider)).join("");

  // 4) LOCAL AGENTS
  const agents = (local?.agents ?? []).filter((a) => a.available);
  const kind = planMode === "api" ? "spent" : "value";
  const localHtml =
    agents.length === 0
      ? `<div class="stitle">Local coding agents <span class="live-pill">● LIVE</span></div><div style="font-size:11px;color:var(--muted);padding:6px 0">No Claude Code / Codex usage found</div>`
      : `<div class="stitle">Local coding agents <span class="live-pill">● LIVE</span></div>` +
        agents
          .map((a) => {
            const isCC = a.agent === "claude-code";
            const ico = isCC
              ? `<div class="ico" style="background:linear-gradient(135deg,#f2c771,#e6b450);color:#0e0d0b">CC</div>`
              : `<div class="ico" style="background:linear-gradient(135deg,#10a37f,#0d8a6a)">CX</div>`;
            const name = isCC ? "Claude Code" : "Codex";
            const sub = a.by_model[0]?.model ? `${a.by_model[0].model} · ${tk(a.total_tokens)} tok` : `${tk(a.total_tokens)} tok`;
            const dollars = money(a.total_cost).replace(/<[^>]+>/g, "");
            return `<div class="row">${ico}<div class="rname">${name}<small>${sub}</small></div><div class="rval">${dollars}<small>${kind}</small></div></div>`;
          })
          .join("") +
        `<div class="projnote">${localAgentsNote(planMode)}</div>`;

  // Is Alpha (the gateway) connected with real fleet data?
  const connected = !!gatewayUrl && !!poll.fleet && (poll.fleet.workloads.length > 0 || poll.fleet.totals.requests > 0);
  const realized = poll.savings?.realizedMonthly ?? 0;
  const f = (v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(1)}K` : `$${Math.round(v)}`);

  // 5) SAVINGS. Connected users ALWAYS see realized savings (a status report of
  // their own account) — never the prospect pitch, even when it's $0. Only
  // non-connected prospects see the projected "you could save" framing.
  let savingsHtml: string;
  if (connected) {
    const yr = realized * 12;
    const cap =
      realized > 0
        ? "Alpha has saved you this — from your real traffic"
        : "Alpha is active on your fleet — savings grow as traffic routes through it";
    savingsHtml = `
    <div class="save-hero">
      <div class="save-big">${f(realized)}<span style="font-size:20px;opacity:.7">/mo</span></div>
      <div class="save-cap">${cap}</div>
    </div>
    <div class="proj">
      <div><b>${f(realized)}</b><small>saved /mo</small></div>
      <div><b>${f(yr)}</b><small>saved /year</small></div>
      <div><b>${poll.fleet?.workloads.length ?? 0}</b><small>agents routed</small></div>
    </div>
    <div class="cta" id="tryalpha">Open your dashboard →</div>
    <div class="projnote">Realized savings · cost-per-success vs. baseline</div>`;
  } else {
    const daily = spend * 0.24;
    const yr = daily * 365;
    savingsHtml = `
    <div class="save-hero">
      <div class="save-big">${f(daily)}<span style="font-size:20px;opacity:.7">/day</span></div>
      <div class="save-cap">you could save with smarter routing</div>
    </div>
    <div class="proj">
      <div><b>${f(daily * 30)}</b><small>/month</small></div>
      <div><b>${f(yr)}</b><small>/year</small></div>
      <div><b>${f(yr * 3 * 1.15)}</b><small>3-yr compounded</small></div>
    </div>
    <div class="cta" id="tryalpha">Try thealpha.ai →</div>
    <div class="projnote">Projected from your real daily spend · illustrative</div>`;
  }

  // 6) FLEET — only when Alpha is connected.
  let fleetSlide: Slide | null = null;
  if (connected && poll.fleet) {
    const wl = poll.fleet.workloads.slice().sort((a, b) => b.windowSpend - a.windowSpend);
    const wlMax = Math.max(...wl.map((w) => w.windowSpend), 1);
    const anomByWl = new Set(poll.fleet.anomalies.map((a) => a.workloadId));
    const fleetHtml =
      wl.length === 0
        ? `<div class="stitle">Your Alpha fleet <span class="sub">spend · 24h</span></div><div style="font-size:11px;color:var(--muted);padding:6px 0">No agents yet</div>`
        : `<div class="stitle">Your Alpha fleet <span class="sub">spend · 24h</span></div>` +
          wl
            .slice(0, 5)
            .map((w) => {
              const dot = anomByWl.has(w.id) ? `<span style="color:var(--red)">●</span> ` : "";
              return provRow(w.name, "#e6b450", w.name.slice(0, 2).toUpperCase(), (w.windowSpend / wlMax) * 100, `${dot}$${w.windowSpend.toFixed(2)}`, `${w.requests} req`);
            })
            .join("");
    fleetSlide = { name: "Alpha fleet", list: true, alpha: "Set budgets &amp; get anomaly alerts per agent", html: fleetHtml };
  }

  // Footer messages: sell Alpha when NOT connected; reflect active use when connected.
  const msg = connected
    ? {
        today: "Alpha is <b>routing this traffic</b> — savings applied",
        providers: "All providers running through <b>one Alpha key</b>",
        models: "Alpha is <b>auto-routing</b> to cheaper models",
        local: "Route local agents through Alpha for <b>even cheaper</b>",
      }
    : {
        today: "Cut this bill <b>24%</b> — same models, smarter routing",
        providers: "One key for all providers — <b>no per-provider setup</b>",
        models: "Auto-swap to a <b>cheaper model</b> at equal quality",
        local: "Overflow to <b>cheaper API</b> when you hit rate limits",
      };
  today.alpha = msg.today;

  const base: Slide[] = [
    today,
    { name: "By provider", list: true, alpha: msg.providers, html: providersHtml },
    { name: "Top models", list: true, alpha: msg.models, html: modelsHtml },
    { name: "Local agents", list: true, alpha: msg.local, html: localHtml },
  ];
  if (fleetSlide) base.push(fleetSlide);
  base.push({ name: "Savings", html: savingsHtml });
  return base;
}

export function Carousel({ poll, providers, local, planMode, demo, gatewayUrl, onOpenConfig, onOpenProviders, onHide }: CarouselProps) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const slideRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setInterval>>();

  // Hero targets, animated with a count-up so the numbers tick when data changes.
  const spendTarget =
    providers.filter((p) => p.ok && p.spendToday != null).reduce((s, p) => s + (p.spendToday ?? 0), 0) +
    (poll.fleet?.totals.spend ?? 0) +
    (local?.agents ?? []).reduce((s, a) => s + a.today_cost, 0);
  const tokTarget = (local?.agents ?? []).reduce((s, a) => s + a.today_tokens, 0);
  const spendAnim = useCountUp(spendTarget);
  const tokAnim = useCountUp(tokTarget);

  // Connected requires a live gateway config AND real fleet data.
  const connected = !!gatewayUrl && !!poll.fleet && (poll.fleet.workloads.length > 0 || poll.fleet.totals.requests > 0);
  // Connected users go to their gateway's dashboard; prospects to the marketing site.
  const alphaTarget = connected ? dashboardUrl(gatewayUrl) : MARKETING_URL;
  const footLabel = connected ? "your dashboard ↗" : "thealpha.ai ↗";

  const slides = buildSlides(poll, providers, local, planMode, gatewayUrl, spendAnim, tokAnim);
  const n = slides.length;
  const i = Math.min(idx, n - 1);
  const cur = slides[i];

  // Rebuild slide HTML only when the slide CHANGES (index or list layout) — not
  // on every count-up frame — so the sparkline animation plays once, not 60×/s.
  useEffect(() => {
    const el = slideRef.current;
    if (!el) return;
    el.className = "slide" + (cur.list ? " list" : "");
    el.innerHTML = cur.html;
    const cta = el.querySelector("#tryalpha");
    if (cta) cta.addEventListener("click", () => openUrl(alphaTarget).catch(() => {}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  // During count-up, patch ONLY the hero money/tokens text nodes (Today slide),
  // leaving the sparkline and everything else untouched.
  useEffect(() => {
    if (i !== 0) return;
    const el = slideRef.current;
    if (!el) return;
    const moneyEl = el.querySelector(".money");
    const toksEl = el.querySelector(".toks");
    if (moneyEl) moneyEl.innerHTML = money(spendAnim);
    if (toksEl) toksEl.innerHTML = `${tk(tokAnim)} tokens <span>today</span>`;
  }, [i, spendAnim, tokAnim]);

  useEffect(() => {
    if (paused) return;
    timer.current = setInterval(() => setIdx((x) => (x + 1) % n), 7000);
    return () => clearInterval(timer.current);
  }, [paused, n]);

  const startDrag = (e: React.MouseEvent) => {
    if (e.button === 0) getCurrentWindow().startDragging();
  };
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div className="widget" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <div className="bar" onMouseDown={startDrag}>
        <span className="brand">
          <img className="logo" src={alphaLogo} alt="Alpha" draggable={false} />
          <span className="dot" /> <span>{cur.name}</span>
          {demo && (
            <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: ".06em", color: "#0e0d0b", background: "var(--brand)", borderRadius: 3, padding: "1px 4px" }}>DEMO</span>
          )}
        </span>
        <span className="actions">
          <span onClick={() => setIdx((x) => (x - 1 + n) % n)} onMouseDown={stop}>‹</span>
          <span onClick={() => setIdx((x) => (x + 1) % n)} onMouseDown={stop}>›</span>
          <span onClick={onOpenProviders} onMouseDown={stop}>⊕</span>
          <span onClick={onOpenConfig} onMouseDown={stop}>⚙</span>
          <span onClick={onHide} onMouseDown={stop}>–</span>
          <span onClick={() => invoke("quit_app")} onMouseDown={stop}>×</span>
        </span>
      </div>

      <div className="slides">
        <div className="slide" ref={slideRef} />
      </div>

      <div
        className="alpha-foot"
        style={{ visibility: cur.alpha ? "visible" : "hidden" }}
        onClick={() => openUrl(alphaTarget).catch(() => {})}
      >
        <span className="atxt" dangerouslySetInnerHTML={{ __html: cur.alpha ?? "" }} />
        <span className="aarrow">{footLabel}</span>
      </div>

      <div className="dots">
        {slides.map((_, di) => (
          <i key={di} className={di === i ? "on" : ""} onClick={() => setIdx(() => di)} />
        ))}
      </div>
    </div>
  );
}
