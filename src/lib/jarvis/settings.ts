import type { AppSettings, JarvisSettings, VoiceActivationMode } from "./types";

const OWNER_MODE_MARKER = "owner-mode";
const ALWAYS_READY_ARM_SECONDS = 120;
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
 * Traflix Space is a private, owner-operated desktop app. Jarvis therefore
 * runs in owner mode: network consent, transcript submission and spoken
 * replies are always enabled. Hands-free local VAD is the default interaction;
 * hold-to-talk remains available as an explicit advanced choice. Manual mode
 * keeps a global shortcut enabled so it always has a start/stop boundary.
 */
export function ownerModeJarvisSettings(settings: JarvisSettings): JarvisSettings {
  const activationMode: VoiceActivationMode =
    settings.voiceInput.activationMode === "hold_to_talk" ? "hold_to_talk" : "vad";
  const voiceInput = {
    ...settings.voiceInput,
    enabled: true,
    autoSubmitTranscript: true,
    maxDurationSeconds: normalizeVoiceMaxDurationSeconds(
      settings.voiceInput.maxDurationSeconds,
    ),
    selectedInputDeviceId: null,
    vadPostSpeechMs: normalizeVoiceVadPostSpeechMs(
      settings.voiceInput.vadPostSpeechMs,
    ),
    endpointGraceMs: normalizeVoiceEndpointWaitMs(settings.voiceInput.endpointGraceMs),
    activationMode,
    vadEnabled: activationMode !== "hold_to_talk",
    globalShortcutEnabled:
      activationMode === "hold_to_talk"
        ? true
        : settings.voiceInput.globalShortcutEnabled,
    maxArmedSeconds:
      activationMode === "vad"
        ? Math.max(ALWAYS_READY_ARM_SECONDS, settings.voiceInput.maxArmedSeconds)
        : settings.voiceInput.maxArmedSeconds,
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
    voiceInput,
    voiceOutput: {
      ...settings.voiceOutput,
      enabled: true,
      autoSpeak: true,
      stopOnUserSpeech: true,
      privacyConsent: true,
      privacyConsentAt: settings.voiceOutput.privacyConsentAt || OWNER_MODE_MARKER,
    },
  };
}

export function isJarvisOwnerModeReady(settings: JarvisSettings): boolean {
  const expectedActivationMode =
    settings.voiceInput.activationMode === "hold_to_talk" ? "hold_to_talk" : "vad";
  const expectedVad = expectedActivationMode !== "hold_to_talk";
  return Boolean(
    settings.textModel.privacyConsent &&
      settings.textModel.privacyConsentAt &&
      settings.voiceInput.enabled &&
      settings.voiceInput.autoSubmitTranscript &&
      settings.voiceInput.activationMode === expectedActivationMode &&
      settings.voiceInput.vadEnabled === expectedVad &&
      (expectedActivationMode !== "vad" ||
        settings.voiceInput.maxArmedSeconds >= ALWAYS_READY_ARM_SECONDS) &&
      settings.voiceInput.privacyConsent &&
      settings.voiceInput.privacyConsentAt &&
      settings.voiceOutput.enabled &&
      settings.voiceOutput.autoSpeak &&
      settings.voiceOutput.stopOnUserSpeech &&
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
      autoSubmitTranscript: true,
      privacyConsent: true,
      privacyConsentAt: OWNER_MODE_MARKER,
      activationMode: "vad",
      globalShortcutEnabled: false,
      globalShortcut: "Ctrl+Alt+Space",
      shortcutBehavior: "toggle",
      vadEnabled: true,
      vadSpeechThreshold: 0.018,
      vadStartFrames: 5,
      vadSilenceFrames: 16,
      vadPreRollMs: 500,
      vadPostSpeechMs: VOICE_VAD_CANDIDATE_MS,
      endpointingEnabled: true,
      endpointGraceMs: VOICE_ENDPOINT_WAIT_MS,
      minSpokenMs: 350,
      maxArmedSeconds: ALWAYS_READY_ARM_SECONDS,
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
      stopOnUserSpeech: true,
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
