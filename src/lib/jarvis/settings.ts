import type { AppSettings, JarvisSettings, VoiceActivationMode } from "./types";

const OWNER_MODE_MARKER = "owner-mode";
export const VOICE_MAX_DURATION_SECONDS = 600;
const LEGACY_VOICE_MAX_DURATION_SECONDS = 45;
export const VOICE_ENDPOINT_WAIT_MS = 900;
export const VOICE_ENDPOINT_MIN_WAIT_MS = 500;
export const VOICE_ENDPOINT_MAX_WAIT_MS = 5_000;
export const VOICE_VAD_CANDIDATE_MS = 650;
export const VOICE_VAD_POST_SPEECH_MAX_MS = 5_000;
const LEGACY_VOICE_ENDPOINT_WAIT_MS = 1_200;
const PREVIOUS_VOICE_ENDPOINT_WAIT_MS = 6_500;
const LEGACY_VOICE_VAD_CANDIDATE_MS = 3_000;
export const VOICE_ENDPOINT_WAIT_SECONDS = VOICE_ENDPOINT_WAIT_MS / 1_000;

export function normalizeVoiceEndpointWaitMs(value: number | undefined): number {
  const configured = typeof value === "number" && Number.isFinite(value)
    ? value
    : VOICE_ENDPOINT_WAIT_MS;
  const migrated = configured === LEGACY_VOICE_ENDPOINT_WAIT_MS
    || configured === PREVIOUS_VOICE_ENDPOINT_WAIT_MS
    ? VOICE_ENDPOINT_WAIT_MS
    : configured;
  return Math.min(
    VOICE_ENDPOINT_MAX_WAIT_MS,
    Math.max(VOICE_ENDPOINT_MIN_WAIT_MS, migrated),
  );
}

export function normalizeVoiceMaxDurationSeconds(value: number | undefined): number {
  const configured = typeof value === "number" && Number.isFinite(value)
    ? value
    : VOICE_MAX_DURATION_SECONDS;
  const migrated = configured === LEGACY_VOICE_MAX_DURATION_SECONDS
    ? VOICE_MAX_DURATION_SECONDS
    : configured;
  return Math.min(VOICE_MAX_DURATION_SECONDS, Math.max(1, migrated));
}

export function normalizeVoiceVadPostSpeechMs(value: number | undefined): number {
  const configured = typeof value === "number" && Number.isFinite(value)
    ? value
    : VOICE_VAD_CANDIDATE_MS;
  return Math.min(
    VOICE_VAD_POST_SPEECH_MAX_MS,
    Math.max(
      configured === LEGACY_VOICE_VAD_CANDIDATE_MS
        ? VOICE_VAD_CANDIDATE_MS
        : configured,
      VOICE_VAD_CANDIDATE_MS,
    ),
  );
}

/**
 * Keep the current Jarvis defaults explicit and bounded. Voice capture remains
 * a deliberate click-toggle session, while legacy VAD, wake-word, and
 * auto-submit fields stay in the persisted shape for backwards compatibility
 * and are normalized at this boundary.
 */
export function ownerModeJarvisSettings(settings: JarvisSettings): JarvisSettings {
  const activationMode: VoiceActivationMode = "click_toggle";
  const voiceInput = {
    ...settings.voiceInput,
    enabled: true,
    autoSubmitTranscript: false,
    maxDurationSeconds: normalizeVoiceMaxDurationSeconds(
      settings.voiceInput.maxDurationSeconds,
    ),
    selectedInputDeviceId: null,
    vadPostSpeechMs: normalizeVoiceVadPostSpeechMs(
      settings.voiceInput.vadPostSpeechMs,
    ),
    endpointGraceMs: normalizeVoiceEndpointWaitMs(settings.voiceInput.endpointGraceMs),
    activationMode,
    vadEnabled: false,
    endpointingEnabled: false,
    maxArmedSeconds: settings.voiceInput.maxArmedSeconds,
    privacyConsent: true,
    privacyConsentAt: settings.voiceInput.privacyConsentAt || OWNER_MODE_MARKER,
  };

  return {
    ...settings,
    textModel: {
      ...settings.textModel,
      privacyConsent: true,
      privacyConsentAt: settings.textModel.privacyConsentAt || OWNER_MODE_MARKER,
    },
    wakeWordEnabled: false,
    voiceInput,
    voiceOutput: {
      ...settings.voiceOutput,
      enabled: true,
      autoSpeak: true,
      stopOnUserSpeech: false,
      privacyConsent: true,
      privacyConsentAt: settings.voiceOutput.privacyConsentAt || OWNER_MODE_MARKER,
    },
  };
}

export function isJarvisOwnerModeReady(settings: JarvisSettings): boolean {
  return Boolean(
    settings.textModel.privacyConsent &&
      settings.textModel.privacyConsentAt &&
      settings.voiceInput.enabled &&
      !settings.voiceInput.autoSubmitTranscript &&
      settings.voiceInput.activationMode === "click_toggle" &&
      !settings.voiceInput.vadEnabled &&
      !settings.voiceInput.endpointingEnabled &&
      settings.voiceInput.privacyConsent &&
      settings.voiceInput.privacyConsentAt &&
      settings.voiceOutput.enabled &&
      settings.voiceOutput.autoSpeak &&
      !settings.voiceOutput.stopOnUserSpeech &&
      settings.voiceOutput.privacyConsent &&
      settings.voiceOutput.privacyConsentAt,
  );
}

export function defaultJarvisSettings(): JarvisSettings {
  return ownerModeJarvisSettings({
    enabled: true,
    voiceEngine: "standard",
    muted: false,
    wakeWordEnabled: false,
    wakeWordPhrase: "Hey Traflix",
    wakeWordSensitivity: 0.65,
    widgetPosition: { x: 0.5, y: 0.9 },
    standardPipeline: {
      stt: "Traflix Voice / Whisper-compatible",
      fastModel: "",
      contextPlanner: "",
      tts: "Edge TTS-compatible",
      voice: "",
    },
    geminiLive: {
      provider: "Gemini Live",
      model: "",
      voice: "",
      automaticTurnDetection: true,
      allowInterruption: true,
    },
    textModel: {
      privacyConsent: true,
      privacyConsentAt: OWNER_MODE_MARKER,
    },
    codex: {
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      speakCommentary: true,
    },
    voiceInput: {
      enabled: true,
      provider: "groq",
      model: "whisper-large-v3-turbo",
      language: "it",
      maxDurationSeconds: VOICE_MAX_DURATION_SECONDS,
      selectedInputDeviceId: undefined,
      autoSubmitTranscript: false,
    privacyConsent: true,
    privacyConsentAt: OWNER_MODE_MARKER,
    activationMode: "click_toggle",
    vadEnabled: false,
      vadSpeechThreshold: 0.018,
      vadStartFrames: 5,
      vadSilenceFrames: 16,
      vadPreRollMs: 500,
      vadPostSpeechMs: VOICE_VAD_CANDIDATE_MS,
      endpointingEnabled: false,
      endpointGraceMs: VOICE_ENDPOINT_WAIT_MS,
      minSpokenMs: 350,
      maxArmedSeconds: 120,
    },
    voiceOutput: {
      enabled: true,
      provider: "edge_tts",
      voice: "it-IT-DiegoNeural",
      rate: "+0%",
      volume: "+0%",
      pitch: "+0Hz",
      autoSpeak: true,
      maxSpokenChars: 800,
      privacyConsent: true,
      privacyConsentAt: OWNER_MODE_MARKER,
      stopOnUserSpeech: false,
    },
  });
}

export function defaultAppSettings(): AppSettings {
  return {
    sidebar: {
      isCollapsed: false,
      workspaceOrder: [],
      activeWorkspaceId: null,
    },
    theme: { accentColor: "#e98a2d" },
    jarvis: defaultJarvisSettings(),
  };
}
