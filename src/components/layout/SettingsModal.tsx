import { useEffect, useState } from "react";
import { Check, KeyRound, RotateCcw, Save, Trash2 } from "lucide-react";
import { Modal } from "../ui/Modal";
import { useJarvisStore } from "../../stores/jarvisStore";
import { defaultJarvisSettings, ownerModeJarvisSettings } from "../../lib/jarvis/settings";
import { ttsListVoices, voiceListInputDevices } from "../../lib/jarvis/client";
import {
  jarvisClearSecret,
  jarvisSecretStatus,
  jarvisSetSecret,
  type JarvisSecretId,
  type JarvisSecretStatus,
} from "../../lib/jarvis/secrets";
import { inputDeviceOptions, italianVoices, sanitizedVoiceError } from "../../lib/jarvis/voiceSettings";
import type { AppSettings, TtsVoice, VoiceInputDevice } from "../../lib/jarvis/types";
import { JarvisAdvancedSettings } from "../jarvis/JarvisAdvancedSettings";
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

// Compatibility modes remain implemented in the voice backend. The normal UI
// intentionally uses click_toggle + VAD locale so the owner gets one-click,
// automatic end-of-turn voice control. hold_to_talk and vad remain available
// to diagnostics/tests without cluttering the primary product flow.
const SUPPORTED_ACTIVATION_MODES = ["click_toggle", "hold_to_talk", "vad"] as const;
void SUPPORTED_ACTIVATION_MODES;

export function SettingsModal({ open, onClose, advanced }: SettingsModalProps) {
  const settings = useJarvisStore((state) => state.settings);
  const settingsLoaded = useJarvisStore((state) => state.settingsLoaded);
  const settingsLoading = useJarvisStore((state) => state.settingsLoading);
  const settingsError = useJarvisStore((state) => state.settingsError);
  const providerStatus = useJarvisStore((state) => state.providerStatus);
  const loadSettings = useJarvisStore((state) => state.loadSettings);
  const saveSettings = useJarvisStore((state) => state.saveSettings);
  const [draft, setDraft] = useState<AppSettings>({ ...settings, jarvis: ownerModeJarvisSettings(settings.jarvis) });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secretStatus, setSecretStatus] = useState<JarvisSecretStatus>(EMPTY_SECRET_STATUS);
  const [secretDrafts, setSecretDrafts] = useState<Record<JarvisSecretId, string>>({ open_code_zen: "", groq: "" });
  const [secretBusy, setSecretBusy] = useState<JarvisSecretId | null>(null);

  useEffect(() => {
    if (open && !settingsLoaded && !settingsLoading) void loadSettings();
  }, [loadSettings, open, settingsLoaded, settingsLoading]);

  useEffect(() => {
    if (!open) return;
    setDraft({ ...settings, jarvis: ownerModeJarvisSettings(settings.jarvis) });
    setError(null);
    setSaved(false);
    setSecretDrafts({ open_code_zen: "", groq: "" });
    void jarvisSecretStatus()
      .then(setSecretStatus)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
  }, [open, settings]);

  const updateJarvis = (updater: (jarvis: AppSettings["jarvis"]) => AppSettings["jarvis"]) => {
    setDraft((current) => ({ ...current, jarvis: ownerModeJarvisSettings(updater(current.jarvis)) }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const normalized = { ...draft, jarvis: ownerModeJarvisSettings(draft.jarvis) };
      await saveSettings(normalized);
      setDraft(normalized);
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
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
      setSecretDrafts((current) => ({ ...current, [secret]: "" }));
      await useJarvisStore.getState().loadProviderStatus();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
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
      setSecretDrafts((current) => ({ ...current, [secret]: "" }));
      await useJarvisStore.getState().loadProviderStatus();
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError));
    } finally {
      setSecretBusy(null);
    }
  };

  const handleReset = () => {
    setDraft((current) => ({ ...current, jarvis: defaultJarvisSettings() }));
    setSaved(false);
  };

  const jarvis = draft.jarvis;

  return (
    <Modal open={open} onClose={onClose} title="Jarvis" width="max-w-[720px]">
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4 border-b border-neutral-border pb-4">
          <div>
            <p className="text-sm font-semibold text-neutral-text">Voice-first assistant</p>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-neutral-text-dim">
              Premi il microfono una volta, parla e fermati: Jarvis chiude il turno, trascrive, agisce e risponde a voce automaticamente.
            </p>
          </div>
          <span className="status-chip status-chip--ok">Owner mode</span>
        </div>

        <section className="space-y-3">
          <SectionHeading title="Connections" description="Le chiavi vengono salvate fuori da settings.json e non vengono mostrate dopo il salvataggio." />
          <div className="divide-y divide-neutral-border rounded-lg border border-neutral-border bg-neutral-surface">
            <CredentialField
              label="OpenCode Zen"
              description="Cervello conversazionale di Jarvis"
              configured={secretStatus.openCodeZenConfigured}
              value={secretDrafts.open_code_zen}
              busy={secretBusy === "open_code_zen"}
              onChange={(value) => setSecretDrafts((current) => ({ ...current, open_code_zen: value }))}
              onSave={() => void handleSecretSave("open_code_zen")}
              onClear={() => void handleSecretClear("open_code_zen")}
            />
            <CredentialField
              label="Groq"
              description="Whisper · whisper-large-v3-turbo"
              configured={secretStatus.groqConfigured}
              value={secretDrafts.groq}
              busy={secretBusy === "groq"}
              onChange={(value) => setSecretDrafts((current) => ({ ...current, groq: value }))}
              onSave={() => void handleSecretSave("groq")}
              onClear={() => void handleSecretClear("groq")}
            />
          </div>
        </section>

        <VoiceOptions
          input={jarvis.voiceInput}
          output={jarvis.voiceOutput}
          onInputChange={(voiceInput) => updateJarvis((current) => ({ ...current, voiceInput }))}
          onOutputChange={(voiceOutput) => updateJarvis((current) => ({ ...current, voiceOutput }))}
        />

        <ModelOptions settings={jarvis} onChange={(next) => updateJarvis(() => next)} />

        <section className="border-t border-neutral-border pt-4">
          <ToggleRow
            label="Diagnostica avanzata"
            description="Registry agent e Context Broker. Rimane fuori dall'interfaccia normale di Jarvis."
            checked={jarvis.advancedViewEnabled}
            onChange={(advancedViewEnabled) => updateJarvis((current) => ({ ...current, advancedViewEnabled }))}
          />
          {jarvis.advancedViewEnabled && advanced && (
            <div className="mt-4">
              <JarvisAdvancedSettings {...advanced} providerStatus={providerStatus} />
            </div>
          )}
        </section>

        {(settingsError || error) && (
          <p role="alert" className="rounded-md border border-danger/35 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error ?? settingsError}
          </p>
        )}
        {saved && (
          <p className="flex items-center gap-2 text-sm text-signal">
            <Check size={15} /> Impostazioni salvate.
          </p>
        )}

        <div className="flex items-center justify-between border-t border-neutral-border pt-4">
          <button type="button" onClick={handleReset} className="secondary-button">
            <RotateCcw size={14} /> Ripristina
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="secondary-button">Chiudi</button>
            <button type="button" disabled={saving} onClick={() => void handleSave()} className="primary-button">
              <Save size={14} /> {saving ? "Salvataggio…" : "Salva"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-neutral-text">{title}</h3>
      <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-text-muted">{description}</p>
    </div>
  );
}

function CredentialField({ label, description, configured, value, busy, onChange, onSave, onClear }: {
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
    <div className="grid gap-3 p-3.5 sm:grid-cols-[170px_1fr] sm:items-center">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-neutral-elevated text-primary"><KeyRound size={14} /></span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-medium text-neutral-text">{label}</p>
            <span className={configured ? "status-dot status-dot--ok" : "status-dot"} aria-label={configured ? "Configurata" : "Da configurare"} />
          </div>
          <p className="truncate text-[10px] text-neutral-text-muted">{description}</p>
        </div>
      </div>
      <div className="flex min-w-0 gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={configured ? "Incolla una nuova chiave per sostituirla" : "Incolla API key"}
          className="field-input min-w-0 flex-1"
        />
        <button type="button" disabled={busy || !value.trim()} onClick={onSave} className="primary-button px-3">Salva</button>
        {configured && (
          <button type="button" disabled={busy} onClick={onClear} className="ui-icon-button h-9 w-9 hover:text-danger" title={`Rimuovi ${label}`} aria-label={`Rimuovi ${label}`}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function VoiceOptions({ input, output, onInputChange, onOutputChange }: {
  input: AppSettings["jarvis"]["voiceInput"];
  output: AppSettings["jarvis"]["voiceOutput"];
  onInputChange: (value: AppSettings["jarvis"]["voiceInput"]) => void;
  onOutputChange: (value: AppSettings["jarvis"]["voiceOutput"]) => void;
}) {
  const [devices, setDevices] = useState<VoiceInputDevice[]>([]);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voiceSettingsError, setVoiceSettingsError] = useState<string | null>(null);

  const loadDevices = async () => {
    setLoadingDevices(true);
    setVoiceSettingsError(null);
    try { setDevices(await voiceListInputDevices()); }
    catch (error) { setVoiceSettingsError(sanitizedVoiceError(error)); }
    finally { setLoadingDevices(false); }
  };
  const loadVoices = async () => {
    setLoadingVoices(true);
    setVoiceSettingsError(null);
    try { setVoices(italianVoices(await ttsListVoices())); }
    catch (error) { setVoiceSettingsError(sanitizedVoiceError(error)); }
    finally { setLoadingVoices(false); }
  };

  // Explicitly keep the automatic voice path represented in the settings
  // object. These are owner-mode invariants rather than user toggles.
  const normalizedInput = { ...input, activationMode: "click_toggle" as const, autoSubmitTranscript: true, vadEnabled: true };
  const normalizedOutput = { ...output, enabled: true, autoSpeak: true, stopOnUserSpeech: true };

  return (
    <section className="space-y-3">
      <SectionHeading title="Voice" description="Automatic turn detection: ascolto, VAD locale, trascrizione e risposta vocale senza pulsanti intermedi." />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-xs text-neutral-text-muted">
          <span>Microfono</span>
          <div className="flex gap-2">
            <select
              value={normalizedInput.selectedInputDeviceId ?? ""}
              onChange={(event) => onInputChange({ ...normalizedInput, selectedInputDeviceId: event.target.value || null })}
              className="field-input min-w-0 flex-1"
            >
              <option value="">Predefinito di Windows</option>
              {inputDeviceOptions(devices).map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
            </select>
            <button type="button" onClick={() => void loadDevices()} disabled={loadingDevices} className="secondary-button px-3" title="Aggiorna microfoni">
              {loadingDevices ? "…" : "Aggiorna"}
            </button>
          </div>
        </label>
        <label className="space-y-1.5 text-xs text-neutral-text-muted">
          <span>Voce di Jarvis</span>
          <div className="flex gap-2">
            <select
              value={normalizedOutput.voice}
              onChange={(event) => onOutputChange({ ...normalizedOutput, voice: event.target.value })}
              className="field-input min-w-0 flex-1"
            >
              {voices.length === 0 && <option value={normalizedOutput.voice}>{normalizedOutput.voice}</option>}
              {voices.map((voice) => <option key={voice.shortName} value={voice.shortName}>{voice.shortName}</option>)}
            </select>
            <button type="button" onClick={() => void loadVoices()} disabled={loadingVoices} className="secondary-button px-3" title="Carica voci italiane">
              {loadingVoices ? "…" : "Voci"}
            </button>
          </div>
        </label>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-md border border-neutral-border bg-neutral-surface px-3 py-2.5">
        <div>
          <p className="text-xs font-medium text-neutral-text">Turn detection automatica</p>
          <p className="mt-0.5 text-[10px] text-neutral-text-muted">Un click avvia l'ascolto; una pausa naturale chiude e invia il turno.</p>
        </div>
        <span className="status-chip status-chip--ok">Attiva</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
        <TextField label="Hotkey globale" value={normalizedInput.globalShortcut} onChange={(globalShortcut) => onInputChange({ ...normalizedInput, globalShortcut })} />
        <ToggleRow
          label="Abilita hotkey"
          checked={normalizedInput.globalShortcutEnabled}
          onChange={(globalShortcutEnabled) => onInputChange({ ...normalizedInput, globalShortcutEnabled })}
        />
      </div>

      <details className="details-panel">
        <summary>Voice tuning</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <TextField
            label="Sensibilità VAD locale"
            value={String(normalizedInput.vadSpeechThreshold)}
            onChange={(value) => {
              const parsed = Number(value);
              if (Number.isFinite(parsed)) onInputChange({ ...normalizedInput, vadSpeechThreshold: Math.max(0.001, Math.min(1, parsed)) });
            }}
          />
          <TextField
            label="Attesa massima (s)"
            value={String(normalizedInput.maxArmedSeconds)}
            onChange={(value) => {
              const parsed = Number(value);
              if (Number.isFinite(parsed)) onInputChange({ ...normalizedInput, maxArmedSeconds: Math.max(1, Math.min(20, Math.floor(parsed))) });
            }}
          />
        </div>
      </details>

      {voiceSettingsError && <p role="alert" className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{voiceSettingsError}</p>}
    </section>
  );
}

function ModelOptions({ settings, onChange }: { settings: AppSettings["jarvis"]; onChange: (settings: AppSettings["jarvis"]) => void }) {
  return (
    <details className="details-panel">
      <summary>Model routing</summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <TextField label="Primario" value={settings.textModel.primaryModel} placeholder="longcat-2.0-free" onChange={(primaryModel) => onChange({ ...settings, textModel: { ...settings.textModel, primaryModel } })} />
        <TextField label="Fallback" value={settings.textModel.fallbackModel} placeholder="deepseek-v4-flash-free" onChange={(fallbackModel) => onChange({ ...settings, textModel: { ...settings.textModel, fallbackModel } })} />
      </div>
      <div className="mt-3">
        <ToggleRow label="Fallback modello" checked={settings.textModel.fallbackEnabled} onChange={(fallbackEnabled) => onChange({ ...settings, textModel: { ...settings.textModel, fallbackEnabled } })} />
      </div>
    </details>
  );
}

function TextField({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange?: (value: string) => void }) {
  return (
    <label className="space-y-1.5">
      <span className="text-xs text-neutral-text-muted">{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange?.(event.target.value)} className="field-input w-full" />
    </label>
  );
}

function ToggleRow({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex min-h-9 cursor-pointer items-center justify-between gap-3 rounded-md border border-neutral-border bg-neutral-surface px-3 py-2">
      <span>
        <span className="block text-xs font-medium text-neutral-text">{label}</span>
        {description && <span className="mt-0.5 block text-[10px] leading-relaxed text-neutral-text-muted">{description}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="accent-primary" />
    </label>
  );
}
