import { create } from "zustand";
import {
  agentGetLastResult,
  getSettings,
  setSettings as persistSettings,
} from "../lib/jarvis/client";
import { defaultAppSettings, defaultJarvisSettings } from "../lib/jarvis/settings";
import type {
  AgentResult,
  AppSettings,
  ModelContextViewV1,
  WidgetPosition,
} from "../lib/jarvis/types";

export type JarvisContextStatus = "idle" | "loading" | "ready" | "unavailable";

interface JarvisStore {
  settings: AppSettings;
  settingsLoaded: boolean;
  settingsLoading: boolean;
  settingsError: string | null;
  expanded: boolean;
  dragging: boolean;
  settingsOpen: boolean;
  selectedAgentSessionId: string | null;
  context: ModelContextViewV1 | null;
  contextStatus: JarvisContextStatus;
  currentResult: AgentResult | null;
  currentResultSessionId: string | null;
  currentResultLoading: boolean;
  currentError: string | null;
  registryRefreshTimestamp: string | null;
  otherWorkspaceAgentCount: number;

  loadSettings: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  updateJarvisSettings: (
    updater: (settings: AppSettings["jarvis"]) => AppSettings["jarvis"],
  ) => Promise<void>;
  showJarvis: () => Promise<void>;
  hideJarvis: () => Promise<void>;
  toggleMuted: () => Promise<void>;
  updateWidgetPosition: (position: WidgetPosition) => Promise<void>;
  resetJarvisSettings: () => Promise<void>;
  setExpanded: (expanded: boolean) => void;
  setDragging: (dragging: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setSelectedAgentSessionId: (sessionId: string | null) => void;
  clearResult: () => void;
  setContext: (
    context: ModelContextViewV1 | null,
    status: JarvisContextStatus,
    error?: string | null,
  ) => void;
  setResult: (sessionId: string, result: AgentResult | null) => void;
  setResultLoading: (loading: boolean) => void;
  setCurrentError: (error: string | null) => void;
  setRegistryRefreshTimestamp: (timestamp: string) => void;
  setOtherWorkspaceAgentCount: (count: number) => void;
  loadLastResult: (workspaceId: string, sessionId: string) => Promise<void>;
}

let settingsSaveQueue = Promise.resolve();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useJarvisStore = create<JarvisStore>((set, get) => ({
  settings: defaultAppSettings(),
  settingsLoaded: false,
  settingsLoading: false,
  settingsError: null,
  expanded: false,
  dragging: false,
  settingsOpen: false,
  selectedAgentSessionId: null,
  context: null,
  contextStatus: "idle",
  currentResult: null,
  currentResultSessionId: null,
  currentResultLoading: false,
  currentError: null,
  registryRefreshTimestamp: null,
  otherWorkspaceAgentCount: 0,

  loadSettings: async () => {
    set({ settingsLoading: true, settingsError: null });
    try {
      const settings = await getSettings();
      set({ settings, settingsLoaded: true, settingsLoading: false });
    } catch (error) {
      set({
        settingsLoaded: true,
        settingsLoading: false,
        settingsError: errorMessage(error),
      });
    }
  },

  saveSettings: async (settings) => {
    set({ settings, settingsError: null });
    settingsSaveQueue = settingsSaveQueue
      .catch(() => undefined)
      .then(() => persistSettings(settings));
    try {
      await settingsSaveQueue;
    } catch (error) {
      set({ settingsError: errorMessage(error) });
      throw error;
    }
  },

  updateJarvisSettings: async (updater) => {
    const nextSettings = {
      ...get().settings,
      jarvis: updater(get().settings.jarvis),
    };
    await get().saveSettings(nextSettings);
  },

  showJarvis: async () => {
    await get().updateJarvisSettings((jarvis) => ({ ...jarvis, enabled: true }));
  },

  hideJarvis: async () => {
    set({ expanded: false });
    await get().updateJarvisSettings((jarvis) => ({ ...jarvis, enabled: false }));
  },

  toggleMuted: async () => {
    await get().updateJarvisSettings((jarvis) => ({
      ...jarvis,
      muted: !jarvis.muted,
    }));
  },

  updateWidgetPosition: async (position) => {
    await get().updateJarvisSettings((jarvis) => ({
      ...jarvis,
      widgetPosition: position,
    }));
  },

  resetJarvisSettings: async () => {
    await get().updateJarvisSettings(() => defaultJarvisSettings());
  },

  setExpanded: (expanded) => set({ expanded }),
  setDragging: (dragging) => set({ dragging }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSelectedAgentSessionId: (selectedAgentSessionId) =>
    set({ selectedAgentSessionId }),
  clearResult: () =>
    set({
      currentResult: null,
      currentResultSessionId: null,
      currentResultLoading: false,
      currentError: null,
    }),
  setContext: (context, contextStatus, error = null) =>
    set({ context, contextStatus, currentError: error }),
  setResult: (sessionId, result) =>
    set({
      currentResultSessionId: sessionId,
      currentResult: result,
      currentResultLoading: false,
    }),
  setResultLoading: (currentResultLoading) => set({ currentResultLoading }),
  setCurrentError: (currentError) => set({ currentError }),
  setRegistryRefreshTimestamp: (registryRefreshTimestamp) =>
    set({ registryRefreshTimestamp }),
  setOtherWorkspaceAgentCount: (otherWorkspaceAgentCount) =>
    set({ otherWorkspaceAgentCount }),
  loadLastResult: async (workspaceId, sessionId) => {
    set({
      currentResultLoading: true,
      currentResultSessionId: sessionId,
      currentError: null,
    });
    try {
      const envelope = await agentGetLastResult(workspaceId, sessionId);
      set({
        currentResult: envelope.data,
        currentResultLoading: false,
        currentError:
          envelope.warnings.length > 0 ? envelope.warnings.join(" · ") : null,
      });
    } catch (error) {
      set({
        currentResult: null,
        currentResultLoading: false,
        currentError: errorMessage(error),
      });
    }
  },
}));
