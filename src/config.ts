// Config persistence. Non-secret bits (URL, workspaceId, UI prefs) go in the
// Tauri JS store; the API key goes in the OS keychain via Rust commands.

import { load, Store } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import type { GatewayConfig } from "./gateway";

const STORE_FILE = "settings.json";

let storePromise: Promise<Store> | null = null;
function store(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE);
  return storePromise;
}

export interface Settings {
  baseUrl: string;
  workspaceId: string;
  workspaceName: string;
  clickThrough: boolean;
  demoMode: boolean;
  planMode: "subscription" | "api";
  /** Daily spend budget in USD. 0 = not set (no budget tracking). */
  dailyBudget: number;
  windowSize: "24h" | "7d";
}

const DEFAULTS: Settings = {
  baseUrl: "",
  workspaceId: "",
  workspaceName: "",
  clickThrough: false,
  demoMode: false,
  planMode: "subscription",
  dailyBudget: 0,
  windowSize: "24h",
};

export async function loadSettings(): Promise<Settings> {
  const s = await store();
  const saved = (await s.get<Partial<Settings>>("settings")) ?? {};
  return { ...DEFAULTS, ...saved };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const s = await store();
  await s.set("settings", settings);
}

// ---- Direct provider keys (keychain, one account per provider) ----
function providerAccount(id: string): string {
  return `provider:${id}`;
}

export async function getProviderKey(id: string): Promise<string | null> {
  return invoke<string | null>("get_provider_key", { account: providerAccount(id) });
}

export async function saveProviderKey(id: string, key: string): Promise<void> {
  await invoke("save_provider_key", { account: providerAccount(id), key });
}

export async function clearProviderKey(id: string): Promise<void> {
  await invoke("clear_provider_key", { account: providerAccount(id) });
}

export async function getApiKey(): Promise<string | null> {
  return invoke<string | null>("get_api_key");
}

export async function saveApiKey(key: string): Promise<void> {
  await invoke("save_api_key", { key });
}

export async function clearApiKey(): Promise<void> {
  await invoke("clear_api_key");
}

// A config is only usable once all three pieces are present.
export function toGatewayConfig(
  settings: Settings,
  apiKey: string | null,
): GatewayConfig | null {
  if (!settings.baseUrl || !settings.workspaceId || !apiKey) return null;
  return {
    // Normalize the scheme to lowercase — a capital "Https://" fails the Tauri
    // http-plugin capability URL match, silently blocking every gateway request.
    baseUrl: settings.baseUrl.replace(/^(https?):\/\//i, (_m, s) => `${s.toLowerCase()}://`),
    workspaceId: settings.workspaceId,
    apiKey,
  };
}
