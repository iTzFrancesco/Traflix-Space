import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Key, Eye, EyeOff, Trash2, Check, AlertCircle } from "lucide-react";
import { Modal } from "../ui/Modal";
import { AGENTS } from "../../lib/agents";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaved(false);
    invoke<Record<string, string>>("get_api_keys")
      .then((keys) => {
        setApiKeys(keys || {});
      })
      .catch((err) => setError(`Errore caricamento chiavi: ${err}`));
  }, [open]);

  const requiredKeys = AGENTS.filter((a) => a.requiresApiKey && a.apiKeyEnv);

  function updateKey(key: string, value: string) {
    setApiKeys((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      for (const agent of requiredKeys) {
        const envKey = agent.apiKeyEnv!;
        const value = apiKeys[envKey] || "";
        if (value) {
          await invoke("set_api_key", { key: envKey, value });
        } else {
          await invoke("remove_api_key", { key: envKey }).catch(() => {});
        }
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(`Errore salvataggio: ${err}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(key: string) {
    setApiKeys((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      await invoke("remove_api_key", { key });
    } catch {
      // ignore
    }
  }

  function toggleVisible(key: string) {
    setVisibleKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <Modal open={open} onClose={onClose} title="Impostazioni" width="max-w-lg">
      <div className="space-y-6">
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
            <AlertCircle size={16} />
            {error}
          </div>
        )}

        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-neutral-text mb-3">
            <Key size={16} className="text-primary" />
            API Keys
          </h3>
          <p className="text-xs text-neutral-text-muted mb-4">
            Le chiavi API vengono salvate localmente e usate per lanciare gli agenti nei terminali.
          </p>

          <div className="space-y-3">
            {requiredKeys.map((agent) => {
              const envKey = agent.apiKeyEnv!;
              const isVisible = visibleKeys[envKey];
              const hasValue = !!apiKeys[envKey];

              return (
                <div key={envKey}>
                  <label className="flex items-center gap-2 text-xs font-medium text-neutral-text-dim mb-1.5">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: agent.color }}
                    />
                    {agent.name}
                    <span className="text-neutral-text-muted">({envKey})</span>
                    {hasValue && (
                      <span className="text-[0.6rem] text-green-500 ml-auto">
                        salvata
                      </span>
                    )}
                  </label>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <input
                        type={isVisible ? "text" : "password"}
                        value={apiKeys[envKey] || ""}
                        onChange={(e) => updateKey(envKey, e.target.value)}
                        placeholder={`Inserisci ${envKey}...`}
                        className="w-full px-3 py-2 pr-16 text-xs rounded-lg bg-neutral-bg border text-neutral-text outline-none transition-colors placeholder:text-neutral-text-muted/50"
                        style={{ borderColor: "rgba(255,255,255,0.06)" }}
                      />
                      <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
                        <button
                          onClick={() => toggleVisible(envKey)}
                          className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-white/5 transition-colors"
                        >
                          {isVisible ? <EyeOff size={14} className="text-neutral-text-muted" /> : <Eye size={14} className="text-neutral-text-muted" />}
                        </button>
                        {hasValue && (
                          <button
                            onClick={() => handleRemove(envKey)}
                            className="flex items-center justify-center w-7 h-7 rounded-md hover:bg-red-500/10 transition-colors"
                          >
                            <Trash2 size={14} className="text-red-400" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center justify-between pt-4 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
          <p className="text-[0.65rem] text-neutral-text-muted">
            Le chiavi sono salvate in <span className="font-mono">settings.json</span>
          </p>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg transition-all disabled:opacity-40"
            style={{
              backgroundColor: saved ? "rgba(34,197,94,0.15)" : "var(--color-primary, #e85d04)",
              color: saved ? "#22c55e" : "white",
              border: saved ? "1px solid rgba(34,197,94,0.3)" : "none",
            }}
          >
            {saved ? (
              <>
                <Check size={14} />
                Salvato
              </>
            ) : saving ? (
              <>
                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Salvataggio...
              </>
            ) : (
              "Salva Chiavi"
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
