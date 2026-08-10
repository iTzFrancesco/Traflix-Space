import { useEffect, useState } from "react";
import {
  Check,
  KeyRound,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { Modal } from "../ui/Modal";
import { useJarvisStore } from "../../stores/jarvisStore";
import {
  defaultJarvisSettings,
  ownerModeJarvisSettings,
} from "../../lib/jarvis/settings";
import {
  ttsListVoices,
  voiceListInputDevices,
} from "../../lib/jarvis/client";
import {
  jarvisClearSecret,
  jarvisSecretStatus,
  jarvisSetSecret,
  type JarvisSecretId,
  type JarvisSecretStatus,
} from "../../lib/jarvis/secrets";
import {
  inputDeviceOptions,
  italianVoices,
  sanitizedVoiceError,
} from "../../lib/jarvis/voiceSettings";
import type {
  AppSettings,
  TtsVoice,
  VoiceInputDevice,
} from "../../lib/jarvis/types";
import { JarvisAdvancedSettings, CodexSettingsSection } from "../jarvis/JarvisAdvancedSettings";
import type { JarvisAdvancedSettingsProps } from "../jarvis/JarvisAdvancedSettings";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  advanced?: Omit<JarvisAdvancedSettingsProps, "providerStatus">;
}

const EMPTY_SECRET_STATUS: JarvisSecretStatus = {
  openCodeZenConfigured: false,
  groqConfigured: false,
  persistent: false,
};

type VoiceInputSettings = AppSettings["jarvis"]["voiceInput"];
type VoiceOutputSettings = AppSettings["jarvis"]["voiceOutput"];
type VoiceActivationMode = VoiceInputSettings["activationMode"];
type ShortcutBehavior = VoiceInputSettings["shortcutBehavior"];

export function SettingsModal({ open, onClose, advanced }: SettingsModalProps) {
  const settings = useJarvisStore((state) => state.settings);
  const settingsLoaded = useJarvisStore((state) => state.settingsLoaded);
  const settingsLoading = useJarvisStore((state) => state.settingsLoading);
  const settingsError = useJarvisStore((state) => state.settingsError);
  const providerStatus = useJarvisStore((state) => state.providerStatus);
  const codexRuntime = useJarvisStore((state) => state.codexRuntime);
  const codexAccount = useJarvisStore((state) => state.codexAccount);
  const codexAccountLoading = useJarvisStore((state) => state.codexAccountLoading);
  const codexLoginBusy = useJarvisStore((state) => state.codexLoginBusy);
  const codexError = useJarvisStore((state) => state.codexError);
  const codexModels = useJarvisStore((state) => state.codexModels);
  const codexModelsLoading = useJarvisStore((state) => state.codexModelsLoading);
  const codexUsage = useJarvisStore((state) => state.codexUsage);
  const codexThreads = useJarvisStore((state) => state.codexThreads);
  const loadSettings = useJarvisStore((state) => state.loadSettings);
  const saveSettings = useJarvisStore((state) => state.saveSettings);

  const [draft, setDraft] = useState<AppSettings>({
    ...settings,
    jarvis: ownerModeJarvisSettings(settings.jarvis),
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secretStatus, setSecretStatus] =
    useState<JarvisSecretStatus>(EMPTY_SECRET_STATUS);
  const [secretDrafts, setSecretDrafts] = useState<Record<JarvisSecretId, string>>({
    open_code_zen: "",
    groq: "",
  });
  const [secretBusy, setSecretBusy] = useState<JarvisSecretId | null>(null);

  useEffect(() => {
    if (open && !settingsLoaded && !settingsLoading) void loadSettings();
  }, [loadSettings, open, settingsLoaded, settingsLoading]);

  useEffect(() => {
    if (!open) return;
    setDraft({
      ...settings,
      jarvis: ownerModeJarvisSettings(settings.jarvis),
    });
    setError(null);
    setSaved(false);
    setSecretDrafts({ open_code_zen: "", groq: "" });
    void jarvisSecretStatus()
      .then(setSecretStatus)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    void useJarvisStore.getState().loadCodexRuntime();
    void useJarvisStore.getState().loadCodexAccount();
    void useJarvisStore.getState().loadCodexModels();
    void useJarvisStore.getState().loadCodexUsage();
    void useJarvisStore.getState().loadCodexThreads();
  }, [open, settings]);

  const updateJarvis = (
    updater: (jarvis: AppSettings["jarvis"]) => AppSettings["jarvis"],
  ) => {
    setDraft((current) => ({
      ...current,
      jarvis: ownerModeJarvisSettings(updater(current.jarvis)),
    }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const normalized = {
        ...draft,
        jarvis: ownerModeJarvisSettings(draft.jarvis),
      };
      await saveSettings(normalized);
      useJarvisStore.getState().clearVoiceError();
      setDraft(normalized);
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const handleSecretSave = async (secret: JarvisSecretId) => {
    const value = secretDrafts[secret].trim();
    if (!value) return;
    setSecretBusy(secret);
    setError(null);
    try {
      const next = await jarvisSetSecret(secret, value);
      setSecretStatus(next);
      useJarvisStore.getState().clearVoiceError();
      setSecretDrafts((current) => ({ ...current, [secret]: "" }));
      await useJarvisStore.getState().loadProviderStatus();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSecretBusy(null);
    }
  };

  const handleSecretClear = async (secret: JarvisSecretId) => {
    setSecretBusy(secret);
    setError(null);
    try {
      const next = await jarvisClearSecret(secret);
      setSecretStatus(next);
      useJarvisStore.getState().clearVoiceError();
      setSecretDrafts((current) => ({ ...current, [secret]: "" }));
      await useJarvisStore.getState().loadProviderStatus();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSecretBusy(null);
    }
  };

  const handleReset = () => {
    setDraft((current) => ({
      ...current,
      jarvis: ownerModeJarvisSettings(defaultJarvisSettings()),
    }));
    setSaved(false);
  };

  const jarvis = draft.jarvis;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Impostazioni Jarvis"
      width="max-w-[700px]"
    >
      <div className="space-y-7">
        <header>
          <p className="text-sm font-semibold text-neutral-text">
            La voce è l'interfaccia principale
          </p>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-neutral-text-muted">
            Jarvis resta pronto in ascolto. Quando rileva la tua voce avvia il turno,
            riconosce automaticamente il silenzio finale, invia la richiesta e risponde a voce.
          </p>
        </header>

        <SettingsSection
          title="Connessioni"
          description="Le chiavi sono salvate fuori da settings.json e non vengono più mostrate dopo il salvataggio."
        >
          <div className="divide-y divide-neutral-border border-y border-neutral-border">
            <CredentialField
              label="OpenCode Zen"
              description="Conversazione e pianificazione"
              configured={secretStatus.openCodeZenConfigured}
              value={secretDrafts.open_code_zen}
              busy={secretBusy === "open_code_zen"}
              onChange={(value) =>
                setSecretDrafts((current) => ({
                  ...current,
                  open_code_zen: value,
                }))
              }
              onSave={() => void handleSecretSave("open_code_zen")}
              onClear={() => void handleSecretClear("open_code_zen")}
            />
            <CredentialField
              label="Groq"
              description="Whisper large-v3-turbo"
              configured={secretStatus.groqConfigured}
              value={secretDrafts.groq}
              busy={secretBusy === "groq"}
              onChange={(value) =>
                setSecretDrafts((current) => ({ ...current, groq: value }))
              }
              onSave={() => void handleSecretSave("groq")}
              onClear={() => void handleSecretClear("groq")}
            />
          </div>
        </SettingsSection>

        <VoiceOptions
          input={jarvis.voiceInput}
          output={jarvis.voiceOutput}
          onInputChange={(voiceInput) =>
            updateJarvis((current) => ({ ...current, voiceInput }))
          }
          onOutputChange={(voiceOutput) =>
            updateJarvis((current) => ({ ...current, voiceOutput }))
          }
        />

        <details className="details-panel">
          <summary>Instradamento modelli</summary>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <TextField
              label="Modello principale"
              value={jarvis.textModel.primaryModel}
              placeholder="deepseek-v4-flash-free"
              onChange={(primaryModel) =>
                updateJarvis((current) => ({
                  ...current,
                  textModel: { ...current.textModel, primaryModel },
                }))
              }
            />
            <TextField
              label="Modello di fallback"
              value={jarvis.textModel.fallbackModel}
              placeholder="longcat-2.0-free"
              onChange={(fallbackModel) =>
                updateJarvis((current) => ({
                  ...current,
                  textModel: { ...current.textModel, fallbackModel },
                }))
              }
            />
          </div>
          <div className="mt-3">
            <ToggleRow
              label="Consenti fallback del modello"
              checked={jarvis.textModel.fallbackEnabled}
              onChange={(fallbackEnabled) =>
                updateJarvis((current) => ({
                  ...current,
                  textModel: { ...current.textModel, fallbackEnabled },
                }))
              }
            />
          </div>
        </details>

        <details className="details-panel">
          <summary>Diagnostica avanzata</summary>
          <div className="mt-3">
            <ToggleRow
              label="Mostra diagnostica agenti"
              description="Dettagli del registry e del Context Broker. Non vengono mostrati nell'interfaccia normale di Jarvis."
              checked={jarvis.advancedViewEnabled}
              onChange={(advancedViewEnabled) =>
                updateJarvis((current) => ({
                  ...current,
                  advancedViewEnabled,
                }))
              }
            />
          </div>
          {jarvis.advancedViewEnabled && advanced && (
            <div className="mt-4">
              <CodexSettingsSection
                runtime={codexRuntime}
                account={codexAccount}
                accountLoading={codexAccountLoading}
                loginBusy={codexLoginBusy}
                error={codexError}
                models={codexModels}
                modelsLoading={codexModelsLoading}
                usage={codexUsage}
                modelSettings={jarvis.codex}
                threads={codexThreads}
                onModelSettingsChange={(codex) =>
                  updateJarvis((current) => ({ ...current, codex }))
                }
                onDeleteThread={(workspaceId) =>
                  void useJarvisStore.getState().deleteCodexThread(workspaceId)
                }
                onLoadAccount={() => void useJarvisStore.getState().loadCodexAccount()}
                onLogin={() => void useJarvisStore.getState().startCodexLogin()}
                onLogout={() => void useJarvisStore.getState().logoutCodex()}
                onRestart={() => void useJarvisStore.getState().restartCodex()}
              />
              <JarvisAdvancedSettings
                {...advanced}
                providerStatus={providerStatus}
              />
            </div>
          )}
        </details>

        {(settingsError || error) && (
          <p
            role="alert"
            className="border-l-2 border-danger px-3 py-2 text-xs leading-relaxed text-danger"
          >
            {error ?? settingsError}
          </p>
        )}
        {saved && (
          <p className="flex items-center gap-2 text-xs text-signal" role="status">
            <Check size={14} aria-hidden="true" /> Impostazioni salvate
          </p>
        )}

        <footer className="flex items-center justify-between border-t border-neutral-border pt-4">
          <button type="button" onClick={handleReset} className="secondary-button">
            <RotateCcw size={14} /> Ripristina predefiniti
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="secondary-button">
              Chiudi
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className="primary-button"
            >
              <Save size={14} /> {saving ? "Salvataggio…" : "Salva"}
            </button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-neutral-text">{title}</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-neutral-text-muted">
        {description}
      </p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function CredentialField({
  label,
  description,
  configured,
  value,
  busy,
  onChange,
  onSave,
  onClear,
}: {
  label: string;
  description: string;
  configured: boolean;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  return (
    <div className="grid gap-3 py-3 sm:grid-cols-[170px_1fr] sm:items-center">
      <div className="flex min-w-0 items-center gap-2.5">
        <KeyRound size={14} className="shrink-0 text-neutral-text-muted" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-xs font-medium text-neutral-text">{label}</p>
            <span
              className={configured ? "status-dot status-dot--ok" : "status-dot"}
              title={configured ? "Configurata" : "Non configurata"}
              aria-hidden="true"
            />
          </div>
          <p className="truncate text-[10px] text-neutral-text-muted">
            {description} · {configured ? "configurata" : "non configurata"}
          </p>
        </div>
      </div>

      <div className="flex min-w-0 gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={
            configured ? "Incolla una nuova chiave per sostituirla" : "Incolla API key"
          }
          aria-label={`API key ${label}`}
          className="field-input min-w-0 flex-1"
        />
        <button
          type="button"
          disabled={busy || !value.trim()}
          onClick={onSave}
          className="primary-button px-3"
        >
          Salva
        </button>
        {configured && (
          <button
            type="button"
            disabled={busy}
            onClick={onClear}
            className="ui-icon-button h-9 w-9 hover:text-danger"
            title={`Rimuovi ${label}`}
            aria-label={`Rimuovi ${label}`}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function VoiceOptions({
  input,
  output,
  onInputChange,
  onOutputChange,
}: {
  input: VoiceInputSettings;
  output: VoiceOutputSettings;
  onInputChange: (value: VoiceInputSettings) => void;
  onOutputChange: (value: VoiceOutputSettings) => void;
}) {
  const [devices, setDevices] = useState<VoiceInputDevice[]>([]);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voiceSettingsError, setVoiceSettingsError] = useState<string | null>(null);

  const normalizedInput: VoiceInputSettings = {
    ...input,
    enabled: true,
    autoSubmitTranscript: true,
    vadEnabled: input.activationMode !== "hold_to_talk",
  };
  const normalizedOutput: VoiceOutputSettings = {
    ...output,
    enabled: true,
    autoSpeak: true,
    stopOnUserSpeech: true,
  };

  const loadDevices = async () => {
    setLoadingDevices(true);
    setVoiceSettingsError(null);
    try {
      setDevices(await voiceListInputDevices());
    } catch (reason) {
      setVoiceSettingsError(sanitizedVoiceError(reason));
    } finally {
      setLoadingDevices(false);
    }
  };

  const loadVoices = async () => {
    setLoadingVoices(true);
    setVoiceSettingsError(null);
    try {
      setVoices(italianVoices(await ttsListVoices()));
    } catch (reason) {
      setVoiceSettingsError(sanitizedVoiceError(reason));
    } finally {
      setLoadingVoices(false);
    }
  };

  const setActivationMode = (activationMode: VoiceActivationMode) => {
    onInputChange({
      ...normalizedInput,
      activationMode,
      vadEnabled: activationMode !== "hold_to_talk",
    });
  };

  return (
    <SettingsSection
      title="Voce"
      description="La modalità predefinita resta sempre pronta e usa il VAD locale per rilevare l'inizio e la fine della frase."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5 text-xs text-neutral-text-muted">
          <span>Microfono</span>
          <div className="flex gap-2">
            <select
              value={normalizedInput.selectedInputDeviceId ?? ""}
              onChange={(event) =>
                onInputChange({
                  ...normalizedInput,
                  selectedInputDeviceId: event.target.value || null,
                })
              }
              className="field-input min-w-0 flex-1"
            >
              <option value="">Predefinito di Windows</option>
              {inputDeviceOptions(devices).map((device) => (
                <option key={device.id} value={device.id}>
                  {device.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadDevices()}
              disabled={loadingDevices}
              className="ui-icon-button h-9 w-9"
              title="Aggiorna microfoni"
              aria-label="Aggiorna microfoni"
            >
              <RefreshCw
                size={14}
                className={loadingDevices ? "status-icon--spin" : ""}
              />
            </button>
          </div>
        </label>

        <label className="space-y-1.5 text-xs text-neutral-text-muted">
          <span>Voce di Jarvis</span>
          <div className="flex gap-2">
            <select
              value={normalizedOutput.voice}
              onChange={(event) =>
                onOutputChange({ ...normalizedOutput, voice: event.target.value })
              }
              className="field-input min-w-0 flex-1"
            >
              {voices.length === 0 && (
                <option value={normalizedOutput.voice}>
                  {normalizedOutput.voice}
                </option>
              )}
              {voices.map((voice) => (
                <option key={voice.shortName} value={voice.shortName}>
                  {voice.shortName}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadVoices()}
              disabled={loadingVoices}
              className="ui-icon-button h-9 w-9"
              title="Aggiorna voci"
              aria-label="Aggiorna voci"
            >
              <RefreshCw
                size={14}
                className={loadingVoices ? "status-icon--spin" : ""}
              />
            </button>
          </div>
        </label>
      </div>

      <details className="details-panel mt-4">
        <summary>Altre opzioni voce</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr]">
          <TextField
            label="Scorciatoia globale"
            value={normalizedInput.globalShortcut}
            onChange={(globalShortcut) =>
              onInputChange({ ...normalizedInput, globalShortcut })
            }
          />
          <ToggleRow
            label="Abilita scorciatoia"
            checked={normalizedInput.globalShortcutEnabled}
            onChange={(globalShortcutEnabled) =>
              onInputChange({ ...normalizedInput, globalShortcutEnabled })
            }
          />
        </div>
      </details>

      <details className="details-panel mt-3">
        <summary>Sensibilità e comportamento</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Modalità di interazione"
            value={normalizedInput.activationMode}
            onChange={(value) => setActivationMode(value as VoiceActivationMode)}
            options={[
              { value: "vad", label: "Sempre in ascolto" },
              { value: "hold_to_talk", label: "Tieni premuto per parlare" },
            ]}
          />
          <SelectField
            label="Comportamento scorciatoia"
            value={normalizedInput.shortcutBehavior}
            onChange={(value) =>
              onInputChange({
                ...normalizedInput,
                shortcutBehavior: value as ShortcutBehavior,
              })
            }
            options={[
              { value: "toggle", label: "Premi per attivare/disattivare" },
              { value: "hold", label: "Tieni premuto per parlare" },
            ]}
          />

          {normalizedInput.activationMode !== "hold_to_talk" && (
            <>
              <TextField
                label="Sensibilità VAD"
                value={String(normalizedInput.vadSpeechThreshold)}
                onChange={(value) => {
                  const parsed = Number(value);
                  if (Number.isFinite(parsed)) {
                    onInputChange({
                      ...normalizedInput,
                      vadSpeechThreshold: Math.max(0.001, Math.min(1, parsed)),
                    });
                  }
                }}
              />
              <TextField
                label="Silenzio prima dell'invio (ms)"
                value={String(normalizedInput.vadPostSpeechMs)}
                onChange={(value) => {
                  const parsed = Number(value);
                  if (Number.isFinite(parsed)) {
                    onInputChange({
                      ...normalizedInput,
                      vadPostSpeechMs: Math.max(100, Math.min(5000, Math.floor(parsed))),
                    });
                  }
                }}
              />
            </>
          )}

          {normalizedInput.activationMode === "vad" && (
            <TextField
              label="Attesa massima della voce (s)"
              value={String(normalizedInput.maxArmedSeconds)}
              onChange={(value) => {
                const parsed = Number(value);
                if (Number.isFinite(parsed)) {
                  onInputChange({
                    ...normalizedInput,
                    maxArmedSeconds: Math.max(2, Math.min(120, Math.floor(parsed))),
                  });
                }
              }}
            />
          )}
        </div>
        <p className="mt-3 text-[10px] leading-relaxed text-neutral-text-muted">
          Sempre in ascolto usa il VAD per aprire il turno solo quando rileva la voce.
          Tieni premuto per parlare termina invece il turno al rilascio.
        </p>
      </details>

      {voiceSettingsError && (
        <p
          role="alert"
          className="mt-3 border-l-2 border-danger px-3 py-2 text-xs text-danger"
        >
          {voiceSettingsError}
        </p>
      )}
    </SettingsSection>
  );
}

function TextField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <label className="space-y-1.5">
      <span className="text-xs text-neutral-text-muted">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange?.(event.target.value)}
        className="field-input w-full"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1.5">
      <span className="text-xs text-neutral-text-muted">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="field-input w-full"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3 border-y border-neutral-border px-1 py-2.5">
      <span>
        <span className="block text-xs font-medium text-neutral-text">{label}</span>
        {description && (
          <span className="mt-0.5 block text-[10px] leading-relaxed text-neutral-text-muted">
            {description}
          </span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-[20px] w-9 shrink-0 rounded-full border transition-colors ${
          checked
            ? "border-primary/55 bg-primary/25"
            : "border-neutral-border bg-neutral-darkest"
        }`}
      >
        <span
          className={`absolute top-[3px] h-3 w-3 rounded-full transition-[left,background-color] ${
            checked ? "left-[19px] bg-primary" : "left-[3px] bg-neutral-text-muted"
          }`}
        />
      </button>
    </div>
  );
}
