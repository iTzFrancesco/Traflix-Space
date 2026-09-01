import type {
  AgentResult,
  AgentSessionContext,
  AppSettings,
  CodexAccountEvent,
  CodexAccountView,
  CodexChatStreamEvent,
  CodexModelCatalog,
  CodexRateLimitsView,
  CodexRuntimeStatus,
  CodexSpeechItem,
  CodexStreamingTurn,
  CodexThreadSnapshot,
  CodexUsageView,
  JarvisCodexThread,
  JarvisConversationMessage,
  JarvisProviderStatus,
  JarvisRequestState,
  JarvisUiIntent,
  ModelContextViewV1,
  PendingAction,
  TtsStatusView,
  VoiceActivationMode,
  VoiceLevelEvent,
  VoiceRequestStatusView,
  VoiceSubmitState,
  WakeWordStatusView,
  WidgetPosition,
} from "../../lib/jarvis/types";
import type { ActivityCheckpoint } from "../../lib/jarvis/activityState";
import type { StateCreator } from "zustand";

export type JarvisContextStatus = "idle" | "loading" | "ready" | "unavailable";

export interface JarvisStore {
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
  contextError: string | null;
  registrySessions: AgentSessionContext[];
  isRefreshing: boolean;
  currentResult: AgentResult | null;
  currentResultSessionId: string | null;
  currentResultLoading: boolean;
  currentError: string | null;
  registryRefreshTimestamp: string | null;
  otherWorkspaceAgentCount: number;
  conversation: JarvisConversationMessage[];
  pendingActions: PendingAction[];
  requests: Record<string, JarvisRequestState>;
  chatErrors: Record<string, string | undefined>;
  providerStatus: JarvisProviderStatus | null;
  codexRuntime: CodexRuntimeStatus | null;
  codexAccount: CodexAccountView | null;
  codexAccountLoading: boolean;
  codexLoginBusy: boolean;
  codexError: string | null;
  codexModels: CodexModelCatalog | null;
  codexModelsLoading: boolean;
  codexUsage: CodexUsageView | null;
  codexUsageLoading: boolean;
  codexRateLimits: CodexRateLimitsView | null;
  codexRateLimitsLoading: boolean;
  codexThreads: Record<string, JarvisCodexThread>;
  codexStreamingTurns: Record<string, CodexStreamingTurn[]>;
  codexSpeechQueue: CodexSpeechItem[];
  codexSpokenItemIds: string[];
  codexStreamFinal: Record<string, string | undefined>;
  dequeueCodexSpeech: (item: Pick<CodexSpeechItem, "turnId" | "itemId">) => void;
  clearCodexSpeech: () => void;
  loadCodexThreads: () => Promise<void>;
  ensureCodexThread: (workspaceId: string) => Promise<void>;
  deleteCodexThread: (workspaceId: string) => Promise<void>;
  startCodexTurn: (workspaceId: string, input: string) => Promise<string | null>;
  interruptCodexTurn: (workspaceId: string) => Promise<void>;
  steerCodexTurn: (workspaceId: string, steerText: string) => Promise<void>;
  uiIntents: JarvisUiIntent[];
  followUps: Record<string, string[]>;
  activities: ActivityCheckpoint[];
  voiceRequests: Record<string, VoiceRequestStatusView>;
  voiceSubmitStates: Record<string, VoiceSubmitState>;
  activeVoiceRequestId: string | null;
  voiceStopRequested: boolean;
  voiceCancelRequested: boolean;
  voiceLevel: VoiceLevelEvent | null;
  wakeWordStatus: WakeWordStatusView | null;
  ttsStatus: TtsStatusView;
  pendingTtsRequestId: string | null;
  voiceError: string | null;

  loadSettings: () => Promise<void>;
  loadWakeWordStatus: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  updateJarvisSettings: (updater: (settings: AppSettings["jarvis"]) => AppSettings["jarvis"]) => Promise<void>;
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
  setContext: (context: ModelContextViewV1 | null, status: JarvisContextStatus, error?: string | null) => void;
  setContextStatus: (status: JarvisContextStatus, error?: string | null) => void;
  setRegistrySessions: (sessions: AgentSessionContext[]) => void;
  setRefreshing: (refreshing: boolean) => void;
  setResult: (sessionId: string, result: AgentResult | null) => void;
  setResultLoading: (loading: boolean) => void;
  setCurrentError: (error: string | null) => void;
  setRegistryRefreshTimestamp: (timestamp: string) => void;
  setOtherWorkspaceAgentCount: (count: number) => void;
  loadLastResult: (workspaceId: string, sessionId: string) => Promise<void>;
  loadConversation: (workspaceId: string) => Promise<void>;
  sendMessage: (message: string, options?: { voiceRequestId?: string }) => Promise<boolean>;
  cancelChatRequest: (requestId: string) => Promise<void>;
  isChatLoading: (workspaceId: string | null) => boolean;
  refreshPendingActions: () => Promise<void>;
  confirmPendingAction: (action: PendingAction) => Promise<void>;
  rejectPendingAction: (action: PendingAction) => Promise<void>;
  updatePendingAction: (action: PendingAction, text: string) => Promise<PendingAction>;
  loadProviderStatus: () => Promise<void>;
  loadCodexRuntime: () => Promise<void>;
  startCodex: () => Promise<boolean>;
  loadCodexAccount: () => Promise<boolean>;
  loadCodexModels: () => Promise<boolean>;
  loadCodexUsage: () => Promise<boolean>;
  loadCodexRateLimits: () => Promise<boolean>;
  bootstrapCodex: () => Promise<void>;
  refreshCodex: () => Promise<void>;
  restartCodex: () => Promise<void>;
  startCodexLogin: () => Promise<void>;
  cancelCodexLogin: (loginId: string) => Promise<void>;
  logoutCodex: () => Promise<void>;
  clearConversation: (workspaceId: string) => Promise<void>;
  startVoice: (options?: { activationMode?: VoiceActivationMode; forceEndpointing?: boolean }) => Promise<void>;
  stopVoice: () => Promise<VoiceRequestStatusView | null>;
  cancelVoice: () => Promise<void>;
  discardVoiceTranscript: () => Promise<void>;
  sendVoiceTranscript: (requestId: string, text: string, options?: { automatic?: boolean }) => Promise<boolean>;
  loadVoiceDraft: (workspaceId: string) => Promise<void>;
  setVoiceRequest: (status: VoiceRequestStatusView) => void;
  setVoiceSubmitState: (requestId: string, state: VoiceSubmitState) => void;
  applyActivityEvents: (events: ActivityCheckpoint[]) => void;
  clearWorkspaceActivities: (workspaceId: string) => void;
  setVoiceLevel: (event: VoiceLevelEvent) => void;
  setWakeWordStatus: (status: WakeWordStatusView) => void;
  setTtsStatus: (status: TtsStatusView) => void;
  stopTts: () => Promise<void>;
  clearVoiceError: () => void;
}

export type JarvisSet = Parameters<StateCreator<JarvisStore>>[0];
export type JarvisGet = Parameters<StateCreator<JarvisStore>>[1];
export type JarvisSlice = (set: JarvisSet, get: JarvisGet) => Partial<JarvisStore>;

export interface JarvisStoreAccess {
  getState: JarvisGet;
  setState: (
    partial: JarvisStore | Partial<JarvisStore> | ((state: JarvisStore) => JarvisStore | Partial<JarvisStore>),
    replace?: boolean,
  ) => void;
}

export type { CodexAccountEvent, CodexChatStreamEvent, CodexRuntimeStatus, CodexThreadSnapshot };
