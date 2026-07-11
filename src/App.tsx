import { useEffect, useState, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import {
  loadSettings,
  saveSettings,
  getApiKey,
  saveApiKey,
  clearApiKey,
  toGatewayConfig,
  type Settings,
} from "./config";
import type { GatewayConfig } from "./gateway";
import { usePolling } from "./usePolling";
import { useProviders } from "./useProviders";
import { useLocalAgents } from "./useLocalAgents";
import { Hud } from "./components/Hud";
import { ConfigScreen } from "./components/ConfigScreen";
import { ProvidersScreen } from "./components/ProvidersScreen";
import { MOCK_POLL, MOCK_PROVIDERS, MOCK_LOCAL } from "./mockData";

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [showProviders, setShowProviders] = useState(false);

  // Load persisted settings + keychain key on boot.
  useEffect(() => {
    (async () => {
      const s = await loadSettings();
      const k = await getApiKey();
      setSettings(s);
      setApiKey(k);
      const cfg = toGatewayConfig(s, k);
      setConfig(cfg);
      // No usable config yet -> land on the config screen (unless demo mode,
      // which needs no gateway at all).
      if (!cfg && !s.demoMode) setShowConfig(true);
      // IMPORTANT: never restore click-through on boot. If it were on, the whole
      // window would ignore mouse events and you couldn't click the toggle to
      // turn it back off — a lockout with no recovery. Always start interactive;
      // click-through is a per-session toggle only. Force it OFF here.
      await invoke("set_click_through", { ignore: false }).catch(() => {});
      if (s.clickThrough) {
        // Heal any persisted "on" state so it doesn't come back next launch.
        await saveSettings({ ...s, clickThrough: false }).catch(() => {});
        setSettings((prev) => (prev ? { ...prev, clickThrough: false } : prev));
      }
    })();
  }, []);

  const realPoll = usePolling(config);
  const realProviders = useProviders();
  const realLocal = useLocalAgents();

  // In demo mode, feed the UI mock data. Otherwise show REAL data, falling back
  // to sample ONLY for the visual slides that would otherwise look empty
  // (providers, model breakdown) — but NEVER fake the fleet/savings, since those
  // gate the "Alpha connected" experience (real fleet slide + realized savings).
  // Demo mode → all mock data. Otherwise → REAL data only, with honest empty
  // states (no fake sample data leaking into a real session).
  const demo = settings?.demoMode ?? false;
  const poll = demo ? { ...MOCK_POLL, lastUpdated: Date.now() } : realPoll;
  const providers = demo ? MOCK_PROVIDERS : realProviders.results;
  const local = demo ? MOCK_LOCAL : realLocal.data;

  const handleSave = useCallback(
    async (next: Settings, nextKey: string) => {
      await saveSettings(next);
      await saveApiKey(nextKey);
      await invoke("set_click_through", { ignore: next.clickThrough }).catch(() => {});
      setSettings(next);
      setApiKey(nextKey);
      setConfig(toGatewayConfig(next, nextKey));
      setShowConfig(false);
    },
    [],
  );

  const toggleDemo = useCallback(
    async (on: boolean) => {
      if (!settings) return;
      const next = { ...settings, demoMode: on };
      await saveSettings(next);
      setSettings(next);
      if (on) setShowConfig(false); // demo needs no gateway — go straight to HUD
    },
    [settings],
  );

  const setPlan = useCallback(
    async (plan: Settings["planMode"]) => {
      if (!settings) return;
      const next = { ...settings, planMode: plan };
      await saveSettings(next);
      setSettings(next);
    },
    [settings],
  );

  const disconnect = useCallback(async () => {
    if (!settings) return;
    // Clear the gateway connection: key from keychain, URL/workspace from store.
    await clearApiKey().catch(() => {});
    const next = { ...settings, baseUrl: "", workspaceId: "", workspaceName: "" };
    await saveSettings(next);
    setSettings(next);
    setApiKey(null);
    setConfig(null);
    setShowConfig(false); // return to the HUD (works with local data, no gateway needed)
  }, [settings]);


  if (!settings) return null; // brief boot flash avoided

  if (showConfig) {
    return (
      <ConfigScreen
        settings={settings}
        apiKey={apiKey ?? ""}
        onSave={handleSave}
        onToggleDemo={toggleDemo}
        onSetPlan={setPlan}
        onDisconnect={disconnect}
        onCancel={() => setShowConfig(false)}
      />
    );
  }

  if (showProviders) {
    return (
      <ProvidersScreen
        onClose={() => {
          setShowProviders(false);
          realProviders.refresh(); // re-poll after key changes
        }}
      />
    );
  }

  return (
    <Hud
      poll={poll}
      providers={providers}
      local={local}
      planMode={settings.planMode}
      clickThrough={settings.clickThrough}
      demo={demo}
      gatewayUrl={config?.baseUrl ?? ""}
      onOpenConfig={() => setShowConfig(true)}
      onOpenProviders={() => setShowProviders(true)}
      onHide={() => getCurrentWindow().hide()}
    />
  );
}
