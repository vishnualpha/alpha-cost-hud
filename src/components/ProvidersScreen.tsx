import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import { getProviderKey, saveProviderKey, clearProviderKey } from "../config";
import { CONNECTOR_LIST } from "../providers/connectors";
import alphaLogo from "../assets/alpha-logo.png";

interface ProvidersScreenProps {
  onClose: () => void;
}

export function ProvidersScreen({ onClose }: ProvidersScreenProps) {
  // Track a draft key per provider + whether one is already stored.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [stored, setStored] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    (async () => {
      const present: Record<string, boolean> = {};
      for (const c of CONNECTOR_LIST) {
        present[c.id] = !!(await getProviderKey(c.id).catch(() => null));
      }
      setStored(present);
    })();
  }, []);

  const save = async (id: string) => {
    const key = (drafts[id] ?? "").trim();
    if (!key) return;
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      await saveProviderKey(id, key);
      // Verify it actually round-tripped to the keychain — don't claim success
      // on a silent failure.
      const readBack = await getProviderKey(id);
      if (readBack !== key) throw new Error("key did not persist to keychain");
      setStored((s) => ({ ...s, [id]: true }));
      setDrafts((d) => ({ ...d, [id]: "" }));
    } catch (err) {
      setErrors((e) => ({
        ...e,
        [id]: err instanceof Error ? err.message : "failed to save key",
      }));
    }
  };

  const remove = async (id: string) => {
    await clearProviderKey(id).catch(() => {});
    setStored((s) => ({ ...s, [id]: false }));
    setErrors((e) => ({ ...e, [id]: "" }));
  };

  return (
    <div className="config">
      <div
        className="config-bar"
        onMouseDown={(e) => e.button === 0 && getCurrentWindow().startDragging()}
      >
        <span className="hud-title">
          <img className="hud-logo" src={alphaLogo} alt="Alpha" draggable={false} />
          Direct providers
        </span>
        <button className="icon-btn" title="Done" onClick={onClose}>
          ✓
        </button>
      </div>

      <div className="config-body">
        <p className="providers-intro">
          Connect providers directly with an API key to see spend Alpha isn&apos;t
          routing yet. Keys are stored in your OS keychain and never leave your
          device.
        </p>

        {CONNECTOR_LIST.map((c) => (
          <div key={c.id} className="provider-item">
            <div className="provider-head">
              <span className="provider-name">{c.label}</span>
              {stored[c.id] ? (
                <span className="provider-connected">● connected</span>
              ) : (
                <button
                  className="provider-getkey"
                  onClick={() => openUrl(c.keyUrl).catch(() => {})}
                >
                  get key ↗
                </button>
              )}
            </div>
            {stored[c.id] ? (
              <div className="provider-row">
                <span className="provider-masked">key saved ••••••••</span>
                <button className="btn ghost small" onClick={() => remove(c.id)}>
                  Remove
                </button>
              </div>
            ) : (
              <div className="provider-row">
                <input
                  type="password"
                  placeholder={c.keyHint}
                  value={drafts[c.id] ?? ""}
                  onChange={(e) =>
                    setDrafts((d) => ({ ...d, [c.id]: e.target.value }))
                  }
                />
                <button
                  className="btn small"
                  disabled={!(drafts[c.id] ?? "").trim()}
                  onClick={() => save(c.id)}
                >
                  Save
                </button>
              </div>
            )}
            {errors[c.id] && <span className="hint err">{errors[c.id]}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
