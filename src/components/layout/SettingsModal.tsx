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
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
  defaultJarvisSettings,
  ownerModeJarvisSettings,
  normalizeVoiceEndpointWaitMs,
  VOICE_ENDPOINT_MAX_WAIT_MS,
  VOICE_ENDPOINT_MIN_WAIT_MS,
  VOICE_ENDPOINT_WAIT_SECONDS,
  VOICE_VAD_CANDIDATE_MS,
} from "../../lib/jarvis/settings";
import {
  ttsListVoices,
} from "../../lib/jarvis/client";
import {
  jarvisClearSecret,
  jarvisSecretStatus,
  jarvisSetSecret,
  type JarvisSecretId,
  type JarvisSecretStatus,
} from "../../lib/jarvis/secrets";
import {
  italianVoices,
  sanitizedVoiceError,
} from "../../lib/jarvis/voiceSettings";
import type {
  AppSettings,
  TtsVoice,
  WakeWordStatusView,
} from "../../lib/jarvis/types";
import {
  JarvisAdvancedSettings,
  CodexDiagnosticsSection,
} from "../jarvis/JarvisAdvancedSettings";
import {
  CodexConnectionRow,
  CodexIntelligenceSettings,
  CodexStatusSettings,
} from "../jarvis/CodexSettingsBlocks";
import type { JarvisAdvancedSettingsProps } from "../jarvis/JarvisAdvancedSettings";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  advanced?: JarvisAdvancedSettingsProps;
}

const EMPTY_SECRET_STATUS: JarvisSecretStatus = {
  groqConfigured: false,
  persistent: false,
};

type VoiceInputSettings = AppSettings["jarvis"]["voiceInput"];
type VoiceOutputSettings = AppSettings["jarvis"]["voiceOutput"];

export function SettingsModal({ open, onClose, advanced }: SettingsModalProps) {
  const settings = useJarvisStore((state) => state.settings);
  const wakeWordStatus = useJarvisStore((state) => state.wakeWordStatus);
  const settingsLoaded = useJarvisStore((state) => state.settingsLoaded);
  const settingsLoading = useJarvisStore((state) => state.settingsLoading);
  const settingsError = useJarvisStore((state) => state.settingsError);
  const codexRuntime = useJarvisStore((state) => state.codexRuntime);
  const codexAccount = useJarvisStore((state) => state.codexAccount);
  const codexAccountLoading = useJarvisStore((state) => state.codexAccountLoading);
  const codexLoginBusy = useJarvisStore((state) => state.codexLoginBusy);
  const codexError = useJarvisStore((state) => state.codexError);
  const codexModels = useJarvisStore((state) => state.codexModels);
  const codexModelsLoading = useJarvisStore((state) => state.codexModelsLoading);
  const codexUsage = useJarvisStore((state) => state.codexUsage);
  const codexUsageLoading = useJarvisStore((state) => state.codexUsageLoading);
  const codexRateLimits = useJarvisStore((state) => state.codexRateLimits);
  const codexRateLimitsLoading = useJarvisStore((state) => state.codexRateLimitsLoading);
  const codexThreads = useJarvisStore((state) => state.codexThreads);
  const codexStreamingTurns = useJarvisStore((state) => state.codexStreamingTurns);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
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
    groq: "",
  });
  const [secretBusy, setSecretBusy] = useState<JarvisSecretId | null>(null);

  useEffect(() => {
    if (open && !settingsLoaded && !settingsLoading) void loadSettings();
  }, [loadSettings, open, settingsLoaded, settingsLoading]);

  useEffect(() => {
    if (!open || !settingsLoaded) return;
    setDraft({
      ...settings,
      jarvis: ownerModeJarvisSettings(settings.jarvis),
    });
    setError(null);
    setSaved(false);
    setSecretDrafts({ groq: "" });
    void jarvisSecretStatus()
      .then(setSecretStatus)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
    void useJarvisStore.getState().bootstrapCodex();
    void useJarvisStore.getState().loadCodexThreads();
  }, [open, settings, settingsLoaded]);

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
      width="max-w-[920px]"
    >
      <div className="space-y-9">
        <header>
          <p className="text-sm font-semibold text-neutral-text">
            La voce è l'interfaccia principale
          </p>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-neutral-text-muted">
            Jarvis resta pronto in ascolto e risponde a voce.
          </p>
        </header>

        <SettingsSection
          title="Connessioni"
          description="Groq per la voce, ChatGPT per l'intelligenza di Jarvis."
        >
          <div className="divide-y divide-neutral-border border-y border-neutral-border">
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
          <div className="mt-3">
            <CodexConnectionRow
              account={codexAccount}
              accountLoading={codexAccountLoading}
              loginBusy={codexLoginBusy}
              error={codexError}
              running={codexRuntime?.state === "running"}
              onLogin={() => void useJarvisStore.getState().startCodexLogin()}
              onLogout={() => void useJarvisStore.getState().logoutCodex()}
            />
          </div>
        </SettingsSection>

        <SettingsSection
          title="Codex"
          description="Stato e limiti della sottoscrizione ChatGPT."
        >
          <CodexStatusSettings
            account={codexAccount}
            accountLoading={codexAccountLoading}
            runtime={codexRuntime}
            rateLimits={codexRateLimits}
            rateLimitsLoading={codexRateLimitsLoading}
            usage={codexUsage}
            usageLoading={codexUsageLoading}
            onRefresh={async () => {
              await useJarvisStore.getState().refreshCodex();
            }}
          />
        </SettingsSection>

        <SettingsSection
          title="Intelligenza"
          description="Modello e reasoning del turno Codex."
        >
          <CodexIntelligenceSettings
            models={codexModels}
            modelsLoading={codexModelsLoading}
            modelSettings={jarvis.codex}
            running={codexRuntime?.state === "running"}
            onModelSettingsChange={(codex) =>
              updateJarvis((current) => ({ ...current, codex }))
            }
          />
        </SettingsSection>

        <VoiceOptions
          input={jarvis.voiceInput}
          output={jarvis.voiceOutput}
          wakeWordEnabled={jarvis.wakeWordEnabled}
          wakeWordPhrase={jarvis.wakeWordPhrase}
          wakeWordStatus={wakeWordStatus}
          onWakeWordChange={(patch) =>
            updateJarvis((current) => ({ ...current, ...patch }))
          }
          onInputChange={(voiceInput) =>
            updateJarvis((current) => ({ ...current, voiceInput }))
          }
          onOutputChange={(voiceOutput) =>
            updateJarvis((current) => ({ ...current, voiceOutput }))
          }
        />

        <details className="details-panel">
          <summary>Diagnostica avanzata</summary>
          <CodexDiagnosticsSection
            runtime={codexRuntime}
            threads={codexThreads}
            streamingTurns={
              activeWorkspaceId
                ? codexStreamingTurns[activeWorkspaceId] ?? []
                : []
            }
            loginBusy={codexLoginBusy}
            onDeleteThread={(workspaceId) =>
              void useJarvisStore.getState().deleteCodexThread(workspaceId)
            }
            onRestart={() => void useJarvisStore.getState().restartCodex()}
          />
          {advanced && (
            <div className="mt-4">
              <JarvisAdvancedSettings {...advanced} />
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
      <div className="mt-4">{children}</div>
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
  wakeWordEnabled,
  wakeWordPhrase,
  wakeWordStatus,
  onWakeWordChange,
  onInputChange,
  onOutputChange,
}: {
  input: VoiceInputSettings;
  output: VoiceOutputSettings;
  wakeWordEnabled: boolean;
  wakeWordPhrase: string;
  wakeWordStatus: WakeWordStatusView | null;
  onWakeWordChange: (patch: {
    wakeWordEnabled?: boolean;
    wakeWordPhrase?: string;
  }) => void;
  onInputChange: (value: VoiceInputSettings) => void;
  onOutputChange: (value: VoiceOutputSettings) => void;
}) {
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [voiceSettingsError, setVoiceSettingsError] = useState<string | null>(null);

  const normalizedInput: VoiceInputSettings = {
    ...input,
    enabled: true,
    autoSubmitTranscript: true,
    vadEnabled: input.activationMode !== "hold_to_talk",
    endpointingEnabled: input.endpointingEnabled ?? true,
    endpointGraceMs: normalizeVoiceEndpointWaitMs(input.endpointGraceMs),
    minSpokenMs: input.minSpokenMs ?? 350,
    vadPostSpeechMs: Math.max(
      input.vadPostSpeechMs ?? VOICE_VAD_CANDIDATE_MS,
      VOICE_VAD_CANDIDATE_MS,
    ),
  };
  const normalizedOutput: VoiceOutputSettings = {
    ...output,
    enabled: true,
    autoSpeak: true,
    stopOnUserSpeech: true,
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

  return (
    <SettingsSection
      title="Voce"
      description="Microfono e voce di Jarvis."
    >
      <div className="mb-4 space-y-3 border-y border-neutral-border py-3">
        <label className="flex items-start gap-2.5 text-xs text-neutral-text">
          <input
            type="checkbox"
            checked={wakeWordEnabled}
            onChange={(event) =>
              onWakeWordChange({ wakeWordEnabled: event.target.checked })
            }
            className="mt-0.5 accent-[var(--color-accent)]"
          />
          <span className="min-w-0">
            <span className="block font-medium">Standby wake word locale</span>
            <span className="mt-1 block text-[11px] leading-relaxed text-neutral-text-muted">
              Mantiene soltanto il detector locale pronto; il mute del widget
              continua a chiudere completamente il microfono.
            </span>
          </span>
        </label>

        <div className="max-w-xl">
          <label className="space-y-1.5 text-xs text-neutral-text-muted">
            <span>Parola di attivazione</span>
            <input
              value={wakeWordPhrase}
              onChange={(event) =>
                onWakeWordChange({ wakeWordPhrase: event.target.value })
              }
              className="field-input w-full"
              maxLength={80}
              disabled={!wakeWordEnabled}
            />
          </label>
        </div>

        {wakeWordEnabled &&
          (wakeWordStatus?.state === "fallback" ||
            wakeWordStatus?.state === "unavailable") && (
          <p
            role="status"
            className="border-l-2 border-warning px-3 py-2 text-[11px] leading-relaxed text-neutral-text-muted"
          >
            Il modello wake word non è incluso in questa build. Jarvis usa un
            fallback VAD locale, senza inviare audio in standby e senza aprire
            un secondo microfono.
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 text-xs text-neutral-text-muted">
          <span className="block">Microfono</span>
          <p className="flex min-h-9 items-center rounded-md border border-neutral-border bg-neutral-darkest px-3 text-neutral-text">
            Microfono automatico
          </p>
          <p className="text-[11px] leading-relaxed">
            Jarvis usa il microfono predefinito di Windows.
          </p>
        </div>

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

      <div className="mt-4 border-y border-neutral-border py-3">
        <label className="flex items-start gap-2 text-xs text-neutral-text">
          <input
            type="checkbox"
            checked={normalizedInput.endpointingEnabled}
            onChange={(event) =>
              onInputChange({
                ...normalizedInput,
                endpointingEnabled: event.target.checked,
              })
            }
            className="mt-0.5 accent-[var(--color-accent)]"
          />
          <span>
            <span className="block font-medium">Invio automatico dopo pausa naturale</span>
            <span className="mt-1 block text-[11px] leading-relaxed text-neutral-text-muted">
              Respiri, pause e micro-interruzioni restano nella stessa frase. Il
              draft viene chiuso solo dopo un silenzio finale stabile e il primo
              attacco viene protetto da preroll e calibrazione.
            </span>
          </span>
        </label>

        {normalizedInput.endpointingEnabled && (
          <label className="mt-3 block max-w-xl space-y-1.5 text-xs text-neutral-text-muted">
            <span className="flex items-center justify-between gap-3">
              <span>Silenzio finale prima dell&apos;invio</span>
              <output className="font-mono tabular-nums text-neutral-text">
                {normalizedInput.endpointGraceMs / 1000}s
              </output>
            </span>
            <input
              type="range"
              min={VOICE_ENDPOINT_MIN_WAIT_MS}
              max={VOICE_ENDPOINT_MAX_WAIT_MS}
              step={500}
              value={normalizedInput.endpointGraceMs}
              onChange={(event) =>
                onInputChange({
                  ...normalizedInput,
                  endpointGraceMs: Number(event.target.value),
                })
              }
              className="w-full accent-[var(--color-accent)]"
              aria-label={`Silenzio finale prima dell'invio: ${normalizedInput.endpointGraceMs / 1000} secondi`}
            />
            <span className="block text-[11px] leading-relaxed">
              Predefinito {VOICE_ENDPOINT_WAIT_SECONDS}s · configurabile da {VOICE_ENDPOINT_MIN_WAIT_MS / 1000}s a {VOICE_ENDPOINT_MAX_WAIT_MS / 1000}s.
            </span>
          </label>
        )}
      </div>

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
