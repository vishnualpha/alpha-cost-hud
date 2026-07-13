import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "../config";
import { login, fetchWorkspacesWithToken, mintKey, type Workspace } from "../gateway";
import alphaLogo from "../assets/alpha-logo.png";

const DEFAULT_URL = "https://api.thealpha.ai";

interface ConfigScreenProps {
  settings: Settings;
  apiKey: string;
  onSave: (settings: Settings, apiKey: string) => Promise<void>;
  onToggleDemo: (on: boolean) => void;
  onSetPlan: (plan: Settings["planMode"]) => void;
  onSetBudget: (budget: number) => void;
  onDisconnect: () => void;
  onCancel?: () => void;
}

type Step = "login" | "workspace";

export function ConfigScreen({
  settings,
  apiKey,
  onSave,
  onToggleDemo,
  onSetPlan,
  onSetBudget,
  onDisconnect,
  onCancel,
}: ConfigScreenProps) {
  const [step, setStep] = useState<Step>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl || DEFAULT_URL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [token, setToken] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");

  const connected = !!settings.workspaceId && !!apiKey;

  const doLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const url = baseUrl.trim().replace(/\/+$/, "");
      const tok = await login(url, email.trim(), password);
      const ws = await fetchWorkspacesWithToken(url, tok);
      if (ws.length === 0) throw new Error("No workspaces on this account");
      setToken(tok);
      setWorkspaces(ws);
      setWorkspaceId(ws[0].id);
      setBaseUrl(url);
      setPassword(""); // never keep the password around
      setStep("workspace");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  const doConnect = async () => {
    if (busy || !token || !workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const key = await mintKey(baseUrl, token);
      const name = workspaces.find((w) => w.id === workspaceId)?.name ?? "";
      await onSave(
        { ...settings, baseUrl, workspaceId, workspaceName: name },
        key,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="config">
      <div
        className="config-bar"
        onMouseDown={(e) => e.button === 0 && getCurrentWindow().startDragging()}
      >
        <span className="hud-title">
          <img className="hud-logo" src={alphaLogo} alt="Alpha" draggable={false} />
          {step === "login" ? "Connect Alpha" : "Choose workspace"}
        </span>
        <button
          className="icon-btn"
          title="Back to HUD"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => onCancel?.()}
        >
          ×
        </button>
      </div>

      {step === "login" ? (
        <form className="config-body" onSubmit={doLogin}>
          {connected && (
            <div className="connected-banner">
              ● Connected to <b>{settings.workspaceName}</b>
            </div>
          )}
          <p className="providers-intro">
            Sign in with your Alpha account — we&apos;ll set up the connection for you.
          </p>
          <label>
            Email
            <input
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </label>
          <label>
            Password
            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <details className="adv">
            <summary>Advanced</summary>
            <label>
              Gateway URL
              <input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </label>
          </details>

          {error && <span className="hint err">{error}</span>}

          <PlanRow settings={settings} onSetPlan={onSetPlan} />
          <BudgetRow settings={settings} onSetBudget={onSetBudget} />
          <DemoRow settings={settings} onToggleDemo={onToggleDemo} />

          <div className="config-actions">
            {connected && (
              <button type="button" className="btn ghost disconnect" onClick={onDisconnect}>
                Disconnect
              </button>
            )}
            <button type="submit" className="btn" disabled={busy || !email.trim() || !password}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>
      ) : (
        <div className="config-body">
          <p className="providers-intro">Which workspace should the HUD track?</p>
          <label>
            Workspace
            <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          {error && <span className="hint err">{error}</span>}
          <div className="config-actions">
            <button type="button" className="btn ghost" onClick={() => setStep("login")}>
              Back
            </button>
            <button type="button" className="btn" disabled={busy || !workspaceId} onClick={doConnect}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function BudgetRow({
  settings,
  onSetBudget,
}: {
  settings: Settings;
  onSetBudget: (b: number) => void;
}) {
  return (
    <label>
      Daily budget (USD)
      <input
        type="number"
        min="0"
        step="1"
        placeholder="e.g. 20 — leave empty for none"
        value={settings.dailyBudget || ""}
        onChange={(e) => onSetBudget(Math.max(0, Number(e.target.value) || 0))}
      />
      <span className="hint">
        Tracks a real under-budget streak from your actual daily spend.
      </span>
    </label>
  );
}

function PlanRow({
  settings,
  onSetPlan,
}: {
  settings: Settings;
  onSetPlan: (p: Settings["planMode"]) => void;
}) {
  return (
    <label>
      How you pay for Claude Code / Codex
      <select
        value={settings.planMode}
        onChange={(e) => onSetPlan(e.target.value as Settings["planMode"])}
      >
        <option value="subscription">Subscription — show API-equivalent value</option>
        <option value="api">Pay-as-you-go API — show real spend</option>
      </select>
      <span className="hint">On a subscription the token cost is equivalent API value, not a bill.</span>
    </label>
  );
}

function DemoRow({
  settings,
  onToggleDemo,
}: {
  settings: Settings;
  onToggleDemo: (on: boolean) => void;
}) {
  return (
    <label className="demo-toggle">
      <input type="checkbox" checked={settings.demoMode} onChange={(e) => onToggleDemo(e.target.checked)} />
      <span>
        Demo mode
        <span className="hint">Show sample data — no account needed</span>
      </span>
    </label>
  );
}
