import type { AppSettings, JarvisSettings } from "./types";

const OWNER_MODE_MARKER = "owner-mode";

/**
 * Traflix Space is a private, owner-operated desktop app. Jarvis therefore
 * runs in owner mode: voice input, automatic turn handling, transcript submit
 * and spoken replies are always enabled. The legacy consent fields stay in
 * the persisted schema for backwards compatibility with the Rust contracts,
 * but they are an internal invariant rather than user-facing settings.
 */
export function ownerModeJarvisSettings(settings: JarvisSettings): JarvisSettings {
  return {
    ...settings,
    textModel: {
      ...settings.textModel,
      privacyConsent: true,
      privacyConsentAt: settings.textModel.privacyConsentAt || OWNER_MODE_MARKER,
    },
    voiceInput: {
      ...settings.voiceInput,
      enabled: true,
      activationMode: "click_toggle",
      autoSubmitTranscript: true,
      vadEnabled: true,
      privacyConsent: true,
      privacyConsentAt: settings.voiceInput.privacyConsentAt || OWNER_MODE_MARKER,
    },
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
  return Boolean(
    settings.textModel.privacyConsent &&
      settings.textModel.privacyConsentAt &&
      settings.voiceInput.enabled &&
      settings.voiceInput.activationMode === "click_toggle" &&
      settings.voiceInput.autoSubmitTranscript &&
      settings.voiceInput.vadEnabled &&
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
      provider: "open_code_zen",
      primaryModel: "longcat-2.0-free",
      fallbackModel: "deepseek-v4-flash-free",
      fallbackEnabled: true,
      privacyConsent: true,
      privacyConsentAt: OWNER_MODE_MARKER,
    },
    advancedViewEnabled: false,
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
      activationMode: "click_toggle",
      globalShortcutEnabled: false,
      globalShortcut: "Ctrl+Alt+Space",
      shortcutBehavior: "toggle",
      vadEnabled: true,
      vadSpeechThreshold: 0.018,
      vadStartFrames: 3,
      vadSilenceFrames: 16,
      vadPreRollMs: 250,
      vadPostSpeechMs: 650,
      maxArmedSeconds: 20,
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
