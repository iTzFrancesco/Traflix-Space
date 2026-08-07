import type { AppSettings, JarvisSettings } from "./types";

export function defaultJarvisSettings(): JarvisSettings {
  return {
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
      privacyConsent: false,
      privacyConsentAt: undefined,
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
      privacyConsent: false,
      privacyConsentAt: undefined,
      activationMode: "click_toggle",
      globalShortcutEnabled: false,
      globalShortcut: "Ctrl+Alt+Space",
      shortcutBehavior: "toggle",
      vadEnabled: false,
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
      privacyConsent: false,
      privacyConsentAt: undefined,
      stopOnUserSpeech: true,
    },
  };
}

export function defaultAppSettings(): AppSettings {
  return {
    sidebar: {
      isCollapsed: false,
      workspaceOrder: [],
      activeWorkspaceId: null,
    },
    theme: { accentColor: "#e85d04" },
    jarvis: defaultJarvisSettings(),
  };
}
