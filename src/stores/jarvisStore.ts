import { create } from "zustand";
import { bindCodexEventsForStore } from "./jarvis/eventBinding";
import { createChatSlice } from "./jarvis/chatSlice";
import { createCodexSlice } from "./jarvis/codexSlice";
import { createRegistrySlice } from "./jarvis/registrySlice";
import { createSettingsSlice } from "./jarvis/settingsSlice";
import { createVoiceSlice } from "./jarvis/voiceSlice";
import { defaultAppSettings } from "../lib/jarvis/settings";
import type { JarvisStore } from "./jarvis/types";

export type { JarvisContextStatus } from "./jarvis/types";

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
  contextError: null,
  registrySessions: [],
  isRefreshing: false,
  currentResult: null,
  currentResultSessionId: null,
  currentResultLoading: false,
  currentError: null,
  registryRefreshTimestamp: null,
  otherWorkspaceAgentCount: 0,
  conversation: [],
  pendingActions: [],
  requests: {},
  chatErrors: {},
  providerStatus: null,
  codexRuntime: null,
  codexAccount: null,
  codexAccountLoading: false,
  codexLoginBusy: false,
  codexError: null,
  codexModels: null,
  codexModelsLoading: false,
  codexUsage: null,
  codexUsageLoading: false,
  codexRateLimits: null,
  codexRateLimitsLoading: false,
  codexThreads: {},
  codexStreamingTurns: {},
  codexSpeechQueue: [],
  codexSpokenItemIds: [],
  codexStreamFinal: {},
  uiIntents: [],
  followUps: {},
  activities: [],
  voiceRequests: {},
  voiceSubmitStates: {},
  voiceLevel: null,
  wakeWordStatus: null,
  ttsStatus: { status: "idle", sequence: 0 },
  pendingTtsRequestId: null,
  activeVoiceRequestId: null,
  voiceStopRequested: false,
  voiceCancelRequested: false,
  voiceError: null,
  ...createSettingsSlice(set, get),
  ...createRegistrySlice(set, get),
  ...createChatSlice(set, get),
  ...createCodexSlice(set, get),
  ...createVoiceSlice(set, get),
} as JarvisStore));

/** Binds global Codex runtime, account, thread and chat-stream events. */
export function bindCodexEvents(): () => void {
  return bindCodexEventsForStore({
    getState: () => useJarvisStore.getState(),
    setState: (partial, replace) => {
      if (replace === true) {
        useJarvisStore.setState(partial as JarvisStore, true);
      } else {
        useJarvisStore.setState(partial, false);
      }
    },
  });
}
