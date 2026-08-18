import {
  getSettings,
  getWakeWordStatus,
  setSettings as persistSettings,
  voiceShutdown,
} from "../../lib/jarvis/client";
import { defaultJarvisSettings } from "../../lib/jarvis/settings";
import { sanitizedVoiceError } from "../../lib/jarvis/voiceSettings";
import { errorMessage } from "./runtime";
import type { JarvisSlice } from "./types";

let settingsSaveQueue = Promise.resolve();

export const createSettingsSlice: JarvisSlice = (set, get) => ({
  loadSettings: async () => {
    set({ settingsLoading: true, settingsError: null, voiceError: null });
    try {
      const loaded = await getSettings();
      set({ settings: loaded, settingsLoaded: true, settingsLoading: false, voiceError: null });
      await get().loadWakeWordStatus();
    } catch (error) {
      set({ settingsLoaded: true, settingsLoading: false, settingsError: errorMessage(error), voiceError: null });
    }
  },

  loadWakeWordStatus: async () => {
    try {
      set({ wakeWordStatus: await getWakeWordStatus() });
    } catch (error) {
      set((state) => ({
        wakeWordStatus: {
          state: state.settings.jarvis.muted
            ? "off"
            : state.settings.jarvis.wakeWordEnabled
              ? "unavailable"
              : "off",
          enabled: state.settings.jarvis.wakeWordEnabled && !state.settings.jarvis.muted,
          keyword: state.settings.jarvis.wakeWordPhrase,
          engine: "unknown",
          error: { code: "wake_word_status_failed", message: sanitizedVoiceError(error) },
        },
      }));
    }
  },

  saveSettings: async (settings) => {
    if (!settings.jarvis.enabled) {
      try {
        await voiceShutdown();
      } catch (error) {
        set({ voiceError: sanitizedVoiceError(error) });
        throw error;
      }
    }
    set({ settings, settingsError: null });
    settingsSaveQueue = settingsSaveQueue.catch(() => undefined).then(() => persistSettings(settings));
    try {
      await settingsSaveQueue;
      await get().loadWakeWordStatus();
    } catch (error) {
      set({ settingsError: errorMessage(error) });
      throw error;
    }
  },

  updateJarvisSettings: async (updater) => {
    const current = get().settings;
    await get().saveSettings({ ...current, jarvis: updater(current.jarvis) });
  },

  showJarvis: async () => {
    await get().updateJarvisSettings((jarvis) => ({ ...jarvis, enabled: true }));
    await get().startCodex();
  },

  hideJarvis: async () => {
    set({ expanded: false });
    await get().updateJarvisSettings((jarvis) => ({ ...jarvis, enabled: false }));
  },

  toggleMuted: async () => get().updateJarvisSettings((jarvis) => ({ ...jarvis, muted: !jarvis.muted })),
  updateWidgetPosition: async (position) => get().updateJarvisSettings((jarvis) => ({ ...jarvis, widgetPosition: position })),
  resetJarvisSettings: async () => get().updateJarvisSettings(() => defaultJarvisSettings()),
});
