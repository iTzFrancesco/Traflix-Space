import type { AppSettings, JarvisSettings, VoiceActivationMode } from "./types";

const OWNER_MODE_MARKER = "owner-mode";
const ALWAYS_READY_ARM_SECONDS = 120;

/**
 * Traflix Space is a private, owner-operated desktop app. Jarvis therefore
 * runs in owner mode: network consent, transcript submission and spoken
 * replies are always enabled. Hands-free local VAD is the default interaction;
 * hold-to-talk remains available as an explicit advanced choice.
 */
export function ownerModeJarvisSettings(settings: JarvisSettings): JarvisSettings {
  const activationMode: VoiceActivationMode =
    settings.voiceInput.activationMode === "hold_to_talk" ? "hold_to_talk" : "vad";
  const voiceInput = {
    ...settings.voiceInput,
    enabled: true,
    autoSubmitTranscript: true,
    activationMode,
    vadEnabled: activationMode !== "hold_to_talk",
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
      maxDurationSeconds: 45,
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
      vadStartFrames: 3,
      vadSilenceFrames: 16,
      vadPreRollMs: 250,
      vadPostSpeechMs: 650,
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
