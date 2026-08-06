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
