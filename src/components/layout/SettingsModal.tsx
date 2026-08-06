import { useEffect, useState } from "react";
import { Check, RotateCcw, Save, Settings2 } from "lucide-react";
import { Modal } from "../ui/Modal";
import { useJarvisStore } from "../../stores/jarvisStore";
import { defaultJarvisSettings } from "../../lib/jarvis/settings";
import type { AppSettings, VoiceEngine } from "../../lib/jarvis/types";
import { JarvisAdvancedSettings } from "../jarvis/JarvisAdvancedSettings";
import type { JarvisAdvancedSettingsProps } from "../jarvis/JarvisAdvancedSettings";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  advanced?: Omit<JarvisAdvancedSettingsProps, "providerStatus">;
}

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

  useEffect(() => {
    if (open && !settingsLoaded && !settingsLoading) {
      void loadSettings();
    }
  }, [loadSettings, open, settingsLoaded, settingsLoading]);

  useEffect(() => {
    if (open) {
      setDraft(settings);
      setError(null);
      setSaved(false);
    }
  }, [open, settings]);

  const updateJarvis = (
    updater: (jarvis: AppSettings["jarvis"]) => AppSettings["jarvis"],
  ) => {
    setDraft((current) => ({ ...current, jarvis: updater(current.jarvis) }));
    setSaved(false);
  };

  const selectVoiceEngine = (voiceEngine: VoiceEngine) => {
    updateJarvis((jarvis) => ({ ...jarvis, voiceEngine }));
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

  const handleReset = () => {
    setDraft((current) => ({
      ...current,
      jarvis: defaultJarvisSettings(),
    }));
    setSaved(false);
  };

  const jarvis = draft.jarvis;

  return (
    <Modal open={open} onClose={onClose} title="Impostazioni" width="max-w-2xl">
      <div className="space-y-6">
        <div className="flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/[0.06] p-4">
          <Settings2 size={20} className="mt-0.5 shrink-0 text-primary" />
          <div>
            <p className="font-semibold text-neutral-text">Jarvis</p>
            <p className="mt-1 text-sm leading-relaxed text-neutral-text-muted">
              Jarvis testuale usa il provider configurato dal backend. Le credenziali non vengono mai salvate in settings, frontend o log.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <EngineCard
            selected={jarvis.voiceEngine === "standard"}
            title="Standard Voice Pipeline"
            description="Modular, configurable and easier to inspect. Traflix Voice/Whisper → LLM → Edge TTS."
            badge="Default"
            onClick={() => selectVoiceEngine("standard")}
          />
          <EngineCard
            selected={jarvis.voiceEngine === "gemini_live"}
            title="Gemini Live Voice"
            description="Native real-time audio conversation with tool calling. Provider integration will be enabled in a later phase."
            badge="Experimental"
            onClick={() => selectVoiceEngine("gemini_live")}
          />
        </div>

        <ModelOptions
          settings={jarvis}
          onChange={(next) => updateJarvis(() => next)}
        />

        <VoiceOptions
          input={jarvis.voiceInput}
          output={jarvis.voiceOutput}
          onInputChange={(voiceInput) => updateJarvis((current) => ({ ...current, voiceInput }))}
          onOutputChange={(voiceOutput) => updateJarvis((current) => ({ ...current, voiceOutput }))}
        />

        <ToggleRow
          label="Abilita strumenti avanzati"
          description="Mostra diagnostica, registry e Context Broker soltanto dentro Settings."
          checked={jarvis.advancedViewEnabled}
          onChange={(advancedViewEnabled) => updateJarvis((current) => ({ ...current, advancedViewEnabled }))}
        />
        {jarvis.advancedViewEnabled && advanced && (
          <JarvisAdvancedSettings
            {...advanced}
            providerStatus={useJarvisStore.getState().providerStatus}
          />
        )}

        <div className="space-y-4 rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-neutral-text">
                {jarvis.voiceEngine === "standard" ? "Standard Voice Pipeline" : "Gemini Live Voice"}
              </h3>
              <p className="mt-1 text-xs text-neutral-text-muted">Schema locale, provider non collegato.</p>
            </div>
            <span className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] uppercase tracking-wider text-neutral-text-muted">
              Solo impostazioni
            </span>
          </div>

          {jarvis.voiceEngine === "standard" ? (
            <StandardOptions
              settings={jarvis.standardPipeline}
              onChange={(standardPipeline) =>
                updateJarvis((current) => ({ ...current, standardPipeline }))
              }
            />
          ) : (
            <GeminiOptions
              settings={jarvis.geminiLive}
              onChange={(geminiLive) =>
                updateJarvis((current) => ({ ...current, geminiLive }))
              }
            />
          )}

          <div className="grid gap-3 border-t border-white/[0.08] pt-4 sm:grid-cols-2">
            <ToggleRow
              label="Wake word"
              description="Disponibile in una fase vocale futura"
              checked={jarvis.wakeWordEnabled}
              onChange={(wakeWordEnabled) =>
                updateJarvis((current) => ({ ...current, wakeWordEnabled }))
              }
            />
            <ToggleRow
              label="Microfono muto"
              description="Stato preparatorio, nessun microfono attivo"
              checked={jarvis.muted}
              onChange={(muted) => updateJarvis((current) => ({ ...current, muted }))}
            />
          </div>
        </div>

        {(settingsError || error) && (
          <p className="rounded-lg border border-danger/30 bg-danger/[0.08] px-3 py-2 text-sm text-danger">
            {error ?? settingsError}
          </p>
        )}
        {saved && (
          <p className="flex items-center gap-2 text-sm text-signal">
            <Check size={16} /> Impostazioni salvate localmente.
          </p>
        )}

        <div className="flex items-center justify-between border-t border-white/[0.08] pt-5">
          <button
            type="button"
            onClick={handleReset}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-neutral-text-muted transition-colors hover:bg-white/[0.06] hover:text-neutral-text"
          >
            <RotateCcw size={15} /> Ripristina
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-neutral-text-muted transition-colors hover:bg-white/[0.06] hover:text-neutral-text"
            >
              Annulla
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-neutral-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <Save size={15} /> {saving ? "Salvataggio…" : "Salva"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function VoiceOptions({ input, output, onInputChange, onOutputChange }: { input: AppSettings["jarvis"]["voiceInput"]; output: AppSettings["jarvis"]["voiceOutput"]; onInputChange: (value: AppSettings["jarvis"]["voiceInput"]) => void; onOutputChange: (value: AppSettings["jarvis"]["voiceOutput"]) => void }) {
  return <div className="space-y-4 rounded-xl border border-signal/20 bg-signal/[0.04] p-5">
    <div><h3 className="font-semibold text-neutral-text">Voce Jarvis</h3><p className="mt-1 text-xs leading-relaxed text-neutral-text-muted">STT esclusivamente Groq Whisper turbo. TTS esclusivamente Microsoft Edge TTS. Il transcript non viene inviato automaticamente.</p></div>
    <div className="grid gap-3 sm:grid-cols-2">
      <ReadOnlyField label="STT" value="Groq · whisper-large-v3-turbo" />
      <ReadOnlyField label="TTS" value="Microsoft Edge TTS" />
      <TextField label="Voce Edge" value={output.voice} onChange={(voice) => onOutputChange({ ...output, voice })} />
      <TextField label="Durata massima (s)" value={String(input.maxDurationSeconds)} onChange={(value) => { const parsed = Number(value); if (Number.isFinite(parsed)) onInputChange({ ...input, maxDurationSeconds: Math.max(1, Math.min(45, Math.floor(parsed))) }); }} />
    </div>
    <ToggleRow label="Abilita input vocale" description="Registra solo dopo un click esplicito." checked={input.enabled} onChange={(enabled) => onInputChange({ ...input, enabled })} />
    <ToggleRow label="Parla automaticamente le risposte" description="Richiede consenso separato per inviare il testo a Edge TTS." checked={output.autoSpeak} onChange={(autoSpeak) => onOutputChange({ ...output, autoSpeak })} />
    <ToggleRow label="Consenso audio → Groq" description="L'audio registrato viene inviato a Groq per Whisper e resta solo in memoria." checked={input.privacyConsent} onChange={(privacyConsent) => onInputChange({ ...input, privacyConsent, privacyConsentAt: privacyConsent ? new Date().toISOString() : undefined })} />
    <ToggleRow label="Consenso testo → Edge TTS" description="Il testo della risposta viene inviato al servizio vocale online Edge TTS." checked={output.privacyConsent} onChange={(privacyConsent) => onOutputChange({ ...output, privacyConsent, privacyConsentAt: privacyConsent ? new Date().toISOString() : undefined })} />
  </div>;
}

function ModelOptions({ settings, onChange }: { settings: AppSettings["jarvis"]; onChange: (settings: AppSettings["jarvis"]) => void }) {
  return <div className="space-y-4 rounded-xl border border-primary/20 bg-primary/[0.04] p-5">
    <div><h3 className="font-semibold text-neutral-text">Jarvis testuale</h3><p className="mt-1 text-xs leading-relaxed text-neutral-text-muted">Provider unico OpenCode Zen. La credenziale backend si chiama <code>OPENCODE_ZEN_API_KEY</code> e non viene mai mostrata o salvata.</p></div>
    <div className="grid gap-4 sm:grid-cols-2">
      <ReadOnlyField label="Provider" value="OpenCode Zen" />
      <TextField label="Modello primario" value={settings.textModel.primaryModel} placeholder="longcat-2.0-free" onChange={(primaryModel) => onChange({ ...settings, textModel: { ...settings.textModel, primaryModel } })} />
      <TextField label="Modello fallback" value={settings.textModel.fallbackModel} placeholder="deepseek-v4-flash-free" onChange={(fallbackModel) => onChange({ ...settings, textModel: { ...settings.textModel, fallbackModel } })} />
    </div>
    <ToggleRow label="Fallback abilitato" description="Usa il modello fallback soltanto per errori temporanei o modello primario indisponibile." checked={settings.textModel.fallbackEnabled} onChange={(fallbackEnabled) => onChange({ ...settings, textModel: { ...settings.textModel, fallbackEnabled } })} />
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-primary/30 bg-primary/[0.06] px-3 py-3"><input type="checkbox" checked={settings.textModel.privacyConsent} onChange={(event) => onChange({ ...settings, textModel: { ...settings.textModel, privacyConsent: event.target.checked, privacyConsentAt: event.target.checked ? settings.textModel.privacyConsentAt ?? new Date().toISOString() : undefined } })} className="mt-1 accent-primary" /><span><span className="block text-sm font-semibold text-neutral-text">Consento l'invio del contesto consentito</span><span className="mt-1 block text-[11px] leading-relaxed text-neutral-text-muted">Possono essere inviati messaggio, Markdown consentito, indice documenti, stato terminali e output agent bounded e non fidati. Non vengono inviati codice sorgente, .env o secret.</span></span></label>
  </div>;
}

function EngineCard({
  selected,
  title,
  description,
  badge,
  onClick,
}: {
  selected: boolean;
  title: string;
  description: string;
  badge: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative rounded-xl border p-4 text-left transition-colors"
      style={{
        borderColor: selected ? "rgba(255,157,36,0.65)" : "rgba(255,255,255,0.09)",
        backgroundColor: selected ? "rgba(255,157,36,0.08)" : "rgba(255,255,255,0.02)",
      }}
    >
      <span className="mb-3 inline-flex rounded-full border border-white/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-primary">
        {badge}
      </span>
      <p className="font-semibold text-neutral-text">{title}</p>
      <p className="mt-2 text-xs leading-relaxed text-neutral-text-muted">{description}</p>
      {selected && <Check size={17} className="absolute right-4 top-4 text-primary" />}
    </button>
  );
}

function StandardOptions({
  settings,
  onChange,
}: {
  settings: AppSettings["jarvis"]["standardPipeline"];
  onChange: (settings: AppSettings["jarvis"]["standardPipeline"]) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <ReadOnlyField label="STT" value={settings.stt} />
      <ReadOnlyField label="TTS" value={settings.tts} />
      <TextField label="Fast model" value={settings.fastModel} placeholder="Configurable later" onChange={(fastModel) => onChange({ ...settings, fastModel })} />
      <TextField label="Context planner" value={settings.contextPlanner} placeholder="Configurable later" onChange={(contextPlanner) => onChange({ ...settings, contextPlanner })} />
      <TextField label="Voice" value={settings.voice} placeholder="Configurable later" onChange={(voice) => onChange({ ...settings, voice })} />
    </div>
  );
}

function GeminiOptions({
  settings,
  onChange,
}: {
  settings: AppSettings["jarvis"]["geminiLive"];
  onChange: (settings: AppSettings["jarvis"]["geminiLive"]) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <ReadOnlyField label="Provider" value={settings.provider} />
      <TextField label="Model" value={settings.model} placeholder="Default later" onChange={(model) => onChange({ ...settings, model })} />
      <TextField label="Voice" value={settings.voice} placeholder="Default later" onChange={(voice) => onChange({ ...settings, voice })} />
      <ToggleRow label="Automatic turn detection" checked={settings.automaticTurnDetection} onChange={(automaticTurnDetection) => onChange({ ...settings, automaticTurnDetection })} />
      <ToggleRow label="Allow interruption" checked={settings.allowInterruption} onChange={(allowInterruption) => onChange({ ...settings, allowInterruption })} />
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return <TextField label={label} value={value} readOnly />;
}

function TextField({
  label,
  value,
  placeholder,
  onChange,
  readOnly = false,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <label className="space-y-1.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-neutral-text-muted">{label}</span>
      <input
        value={value}
        readOnly={readOnly}
        placeholder={placeholder}
        onChange={(event) => onChange?.(event.target.value)}
        className="w-full rounded-lg border border-white/10 bg-neutral-bg px-3 py-2 text-sm text-neutral-text outline-none transition-colors placeholder:text-neutral-text-muted/60 focus:border-primary/60"
      />
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
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-white/[0.08] px-3 py-2.5">
      <span>
        <span className="block text-sm text-neutral-text">{label}</span>
        {description && <span className="mt-0.5 block text-[11px] text-neutral-text-muted">{description}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="accent-primary" />
    </label>
  );
}
