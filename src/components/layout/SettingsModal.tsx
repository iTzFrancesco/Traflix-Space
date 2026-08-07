import { useEffect, useState } from "react";
import { Check, KeyRound, RotateCcw, Save, Settings2, Trash2 } from "lucide-react";
import { Modal } from "../ui/Modal";
import { useJarvisStore } from "../../stores/jarvisStore";
import { defaultJarvisSettings } from "../../lib/jarvis/settings";
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

export function SettingsModal({ open, onClose, advanced }: SettingsModalProps) {
  const settings = useJarvisStore((state) => state.settings);
  const settingsLoaded = useJarvisStore((state) => state.settingsLoaded);
  const settingsLoading = useJarvisStore((state) => state.settingsLoading);
  const settingsError = useJarvisStore((state) => state.settingsError);
  const loadSettings = useJarvisStore((state) => state.loadSettings);
  const saveSettings = useJarvisStore((state) => state.saveSettings);
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secretStatus, setSecretStatus] = useState<JarvisSecretStatus>(EMPTY_SECRET_STATUS);
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
    setDraft(settings);
    setError(null);
    setSaved(false);
    setSecretDrafts({ open_code_zen: "", groq: "" });
    void jarvisSecretStatus()
      .then(setSecretStatus)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
  }, [open, settings]);

  const updateJarvis = (updater: (jarvis: AppSettings["jarvis"]) => AppSettings["jarvis"]) => {
    setDraft((current) => ({ ...current, jarvis: updater(current.jarvis) }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveSettings(draft);
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
    <Modal open={open} onClose={onClose} title="Jarvis" width="max-w-2xl">
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/[0.05] p-4">
          <Settings2 size={19} className="mt-0.5 shrink-0 text-primary" />
          <div>
            <p className="font-semibold text-neutral-text">Voice-first</p>
            <p className="mt-1 text-xs leading-relaxed text-neutral-text-muted">
              La barra di Jarvis è l'interfaccia principale: parli, segui lo stato e ricevi la risposta a voce. Questa schermata serve solo per configurazione e diagnostica.
            </p>
          </div>
        </div>

        <section className="space-y-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
          <div className="flex items-center gap-2">
            <KeyRound size={16} className="text-primary" />
            <div>
              <h3 className="text-sm font-semibold text-neutral-text">Provider</h3>
              <p className="text-[11px] text-neutral-text-muted">Le API key restano fuori da settings.json e non vengono mai rilette o mostrate dopo il salvataggio.</p>
            </div>
          </div>
          <CredentialField
            label="OpenCode Zen"
            description="LLM di Jarvis"
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
        </section>

        <ModelOptions settings={jarvis} onChange={(next) => updateJarvis(() => next)} />

        <VoiceOptions
          input={jarvis.voiceInput}
          output={jarvis.voiceOutput}
          onInputChange={(voiceInput) => updateJarvis((current) => ({ ...current, voiceInput }))}
          onOutputChange={(voiceOutput) => updateJarvis((current) => ({ ...current, voiceOutput }))}
        />

        <ToggleRow
          label="Diagnostica avanzata"
          description="Registry agent, Context Broker e dettagli tecnici. Non compare nella UI normale di Jarvis."
          checked={jarvis.advancedViewEnabled}
          onChange={(advancedViewEnabled) => updateJarvis((current) => ({ ...current, advancedViewEnabled }))}
        />
        {jarvis.advancedViewEnabled && advanced && (
          <JarvisAdvancedSettings {...advanced} providerStatus={useJarvisStore.getState().providerStatus} />
        )}

        {(settingsError || error) && (
          <p className="rounded-lg border border-danger/30 bg-danger/[0.08] px-3 py-2 text-sm text-danger">
            {error ?? settingsError}
          </p>
        )}
        {saved && (
          <p className="flex items-center gap-2 text-sm text-signal">
            <Check size={16} /> Impostazioni salvate.
          </p>
        )}

        <div className="flex items-center justify-between border-t border-white/[0.08] pt-4">
          <button type="button" onClick={handleReset} className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-text-muted hover:bg-white/[0.06] hover:text-neutral-text">
            <RotateCcw size={15} /> Ripristina
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-neutral-text-muted hover:bg-white/[0.06] hover:text-neutral-text">Chiudi</button>
            <button type="button" disabled={saving} onClick={() => void handleSave()} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-neutral-bg hover:opacity-90 disabled:opacity-50">
              <Save size={15} /> {saving ? "Salvataggio…" : "Salva"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function CredentialField({ label, description, configured, value, busy, onChange, onSave, onClear }: { label: string; description: string; configured: boolean; value: string; busy: boolean; onChange: (value: string) => void; onSave: () => void; onClear: () => void }) {
  return (
    <div className="rounded-lg border border-white/[0.08] bg-neutral-bg/55 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div><p className="text-sm font-medium text-neutral-text">{label}</p><p className="text-[11px] text-neutral-text-muted">{description}</p></div>
        <span className={configured ? "text-[11px] font-medium text-signal" : "text-[11px] text-warning"}>{configured ? "Configurata" : "Da configurare"}</span>
      </div>
      <div className="flex gap-2">
        <input type="password" autoComplete="off" spellCheck={false} value={value} onChange={(event) => onChange(event.target.value)} placeholder={configured ? "Inserisci una nuova chiave per sostituirla" : "Incolla API key"} className="min-w-0 flex-1 rounded-lg border border-white/10 bg-neutral-bg px-3 py-2 text-sm text-neutral-text outline-none placeholder:text-neutral-text-muted/50 focus:border-primary/60" />
        <button type="button" disabled={busy || !value.trim()} onClick={onSave} className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-neutral-bg disabled:opacity-40">Salva</button>
        {configured && <button type="button" disabled={busy} onClick={onClear} className="ui-icon-button h-9 w-9 text-neutral-text-muted hover:text-danger" title={`Rimuovi ${label}`} aria-label={`Rimuovi ${label}`}><Trash2 size={14} /></button>}
      </div>
    </div>
  );
}

function VoiceOptions({ input, output, onInputChange, onOutputChange }: { input: AppSettings["jarvis"]["voiceInput"]; output: AppSettings["jarvis"]["voiceOutput"]; onInputChange: (value: AppSettings["jarvis"]["voiceInput"]) => void; onOutputChange: (value: AppSettings["jarvis"]["voiceOutput"]) => void }) {
  const [devices, setDevices] = useState<VoiceInputDevice[]>([]);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voiceSettingsError, setVoiceSettingsError] = useState<string | null>(null);
  const vadMode = input.activationMode === "vad";
  const effectiveVadEnabled = vadMode || input.vadEnabled;
  const loadDevices = async () => { setLoadingDevices(true); setVoiceSettingsError(null); try { setDevices(await voiceListInputDevices()); } catch (error) { setVoiceSettingsError(sanitizedVoiceError(error)); } finally { setLoadingDevices(false); } };
  const loadVoices = async () => { setLoadingVoices(true); setVoiceSettingsError(null); try { setVoices(italianVoices(await ttsListVoices())); } catch (error) { setVoiceSettingsError(sanitizedVoiceError(error)); } finally { setLoadingVoices(false); } };

  return <section className="space-y-4 rounded-xl border border-signal/20 bg-signal/[0.035] p-4">
    <div><h3 className="text-sm font-semibold text-neutral-text">Voce</h3><p className="mt-1 text-[11px] text-neutral-text-muted">Groq trascrive, Jarvis risponde, Edge TTS parla. Per l'uso voice-first tieni attivo l'invio automatico del transcript.</p></div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-1 text-xs text-neutral-text-muted"><span>Microfono</span><select value={input.selectedInputDeviceId ?? ""} onChange={(event) => onInputChange({ ...input, selectedInputDeviceId: event.target.value || null })} className="w-full rounded-lg border border-white/10 bg-neutral-bg px-2 py-2 text-sm text-neutral-text"><option value="">Predefinito di Windows</option>{inputDeviceOptions(devices).map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}</select></label>
      <div className="flex items-end"><button type="button" onClick={() => void loadDevices()} disabled={loadingDevices} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-neutral-text-muted hover:text-neutral-text disabled:opacity-50">{loadingDevices ? "Ricerca…" : "Aggiorna microfoni"}</button></div>
      <label className="space-y-1 text-xs text-neutral-text-muted"><span>Voce Edge</span><select value={output.voice} onChange={(event) => onOutputChange({ ...output, voice: event.target.value })} className="w-full rounded-lg border border-white/10 bg-neutral-bg px-2 py-2 text-sm text-neutral-text">{voices.length === 0 && <option value={output.voice}>{output.voice}</option>}{voices.map((voice) => <option key={voice.shortName} value={voice.shortName}>{voice.shortName} · {voice.locale}</option>)}</select></label>
      <div className="flex items-end"><button type="button" onClick={() => void loadVoices()} disabled={loadingVoices} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-neutral-text-muted hover:text-neutral-text disabled:opacity-50">{loadingVoices ? "Caricamento…" : "Carica voci italiane"}</button></div>
      <label className="space-y-1 text-xs text-neutral-text-muted"><span>Attivazione</span><select value={input.activationMode} onChange={(event) => onInputChange({ ...input, activationMode: event.target.value as typeof input.activationMode })} className="w-full rounded-lg border border-white/10 bg-neutral-bg px-2 py-2 text-sm text-neutral-text"><option value="click_toggle">Click per parlare</option><option value="hold_to_talk">Tieni premuto</option><option value="vad">VAD locale</option></select></label>
      <TextField label="Hotkey globale" value={input.globalShortcut} onChange={(globalShortcut) => onInputChange({ ...input, globalShortcut })} />
    </div>
    <ToggleRow label="Input vocale" checked={input.enabled} onChange={(enabled) => onInputChange({ ...input, enabled })} />
    <ToggleRow label="Invia automaticamente ciò che dico" description="Comportamento consigliato: parli e Jarvis risponde senza passaggi intermedi." checked={input.autoSubmitTranscript} onChange={(autoSubmitTranscript) => onInputChange({ ...input, autoSubmitTranscript })} />
    <ToggleRow label="Hotkey globale" checked={input.globalShortcutEnabled} onChange={(globalShortcutEnabled) => onInputChange({ ...input, globalShortcutEnabled })} />
    {vadMode ? <div className="rounded-lg border border-signal/25 bg-signal/[0.05] px-3 py-2 text-xs text-neutral-text-muted">VAD locale attivo: Jarvis attende la voce e chiude automaticamente il turno.</div> : <ToggleRow label="VAD locale assistito" checked={input.vadEnabled} onChange={(vadEnabled) => onInputChange({ ...input, vadEnabled })} />}
    {effectiveVadEnabled && <div className="grid gap-3 sm:grid-cols-2"><TextField label="Sensibilità VAD" value={String(input.vadSpeechThreshold)} onChange={(value) => { const parsed = Number(value); if (Number.isFinite(parsed)) onInputChange({ ...input, vadSpeechThreshold: Math.max(0.001, Math.min(1, parsed)) }); }} /><TextField label="Attesa massima (s)" value={String(input.maxArmedSeconds)} onChange={(value) => { const parsed = Number(value); if (Number.isFinite(parsed)) onInputChange({ ...input, maxArmedSeconds: Math.max(1, Math.min(20, Math.floor(parsed))) }); }} /></div>}
    <ToggleRow label="Rispondi a voce automaticamente" checked={output.enabled && output.autoSpeak} onChange={(enabled) => onOutputChange({ ...output, enabled, autoSpeak: enabled })} />
    <ToggleRow label="Interrompi la voce di Jarvis quando parlo" checked={output.stopOnUserSpeech} onChange={(stopOnUserSpeech) => onOutputChange({ ...output, stopOnUserSpeech })} />
    <ToggleRow label="Consenso audio → Groq" description="Necessario per inviare la registrazione a Whisper." checked={input.privacyConsent} onChange={(privacyConsent) => onInputChange({ ...input, privacyConsent, privacyConsentAt: privacyConsent ? new Date().toISOString() : undefined })} />
    <ToggleRow label="Consenso testo → Edge TTS" description="Necessario per sintetizzare la risposta a voce." checked={output.privacyConsent} onChange={(privacyConsent) => onOutputChange({ ...output, privacyConsent, privacyConsentAt: privacyConsent ? new Date().toISOString() : undefined })} />
    {voiceSettingsError && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/[0.08] px-3 py-2 text-xs text-danger">{voiceSettingsError}</p>}
  </section>;
}

function ModelOptions({ settings, onChange }: { settings: AppSettings["jarvis"]; onChange: (settings: AppSettings["jarvis"]) => void }) {
  return <section className="space-y-3 rounded-xl border border-primary/20 bg-primary/[0.035] p-4">
    <div><h3 className="text-sm font-semibold text-neutral-text">Modello Jarvis</h3><p className="mt-1 text-[11px] text-neutral-text-muted">OpenCode Zen è il provider del cervello conversazionale; gli agenti visibili restano le sessioni PTY reali.</p></div>
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField label="Primario" value={settings.textModel.primaryModel} placeholder="longcat-2.0-free" onChange={(primaryModel) => onChange({ ...settings, textModel: { ...settings.textModel, primaryModel } })} />
      <TextField label="Fallback" value={settings.textModel.fallbackModel} placeholder="deepseek-v4-flash-free" onChange={(fallbackModel) => onChange({ ...settings, textModel: { ...settings.textModel, fallbackModel } })} />
    </div>
    <ToggleRow label="Fallback modello" checked={settings.textModel.fallbackEnabled} onChange={(fallbackEnabled) => onChange({ ...settings, textModel: { ...settings.textModel, fallbackEnabled } })} />
    <ToggleRow label="Consenso contesto → OpenCode Zen" description="Invia solo il contesto consentito; niente sorgenti, .env o secret." checked={settings.textModel.privacyConsent} onChange={(privacyConsent) => onChange({ ...settings, textModel: { ...settings.textModel, privacyConsent, privacyConsentAt: privacyConsent ? settings.textModel.privacyConsentAt ?? new Date().toISOString() : undefined } })} />
  </section>;
}

function TextField({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange?: (value: string) => void }) {
  return <label className="space-y-1"><span className="text-xs text-neutral-text-muted">{label}</span><input value={value} placeholder={placeholder} onChange={(event) => onChange?.(event.target.value)} className="w-full rounded-lg border border-white/10 bg-neutral-bg px-3 py-2 text-sm text-neutral-text outline-none placeholder:text-neutral-text-muted/50 focus:border-primary/60" /></label>;
}

function ToggleRow({ label, description, checked, onChange }: { label: string; description?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-white/[0.08] px-3 py-2.5"><span><span className="block text-sm text-neutral-text">{label}</span>{description && <span className="mt-0.5 block text-[11px] text-neutral-text-muted">{description}</span>}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="accent-primary" /></label>;
}
