import { create } from "zustand";
import {
  agentGetLastResult,
  cancelChat,
  clearConversation,
  confirmAction,
  conversationHistory,
  getSettings,
  jarvisChat,
  pendingActions,
  providerStatus,
  rejectAction,
  setSettings as persistSettings,
  updatePendingAction,
  ttsSpeak,
  ttsStop,
  voiceCancel,
  voiceDiscardTranscript,
  voiceStart,
  voiceStop,
} from "../lib/jarvis/client";
import { defaultAppSettings, defaultJarvisSettings } from "../lib/jarvis/settings";
import { applyRegistrySnapshot } from "../lib/jarvis/registryState";
import { isWorkspaceChatLoading, mergeConversationMessages, pruneRequestHistory } from "../lib/jarvis/chatState";
import { useWorkspaceStore } from "./workspaceStore";
import type {
  AgentResult,
  AgentSessionContext,
  AppSettings,
  InvocationBinding,
  JarvisConversationMessage,
  JarvisProviderStatus,
  JarvisRequestState,
  JarvisUiIntent,
  ModelContextViewV1,
  PendingAction,
  WidgetPosition,
  TtsStatusView,
  VoiceLevelEvent,
  VoiceRequestStatusView,
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
  uiIntents: JarvisUiIntent[];
  followUps: Record<string, string[]>;
  voiceRequest: VoiceRequestStatusView | null;
  voiceLevel: VoiceLevelEvent | null;
  ttsStatus: TtsStatusView;

  loadSettings: () => Promise<void>;
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
  sendMessage: (message: string) => Promise<void>;
  cancelChatRequest: (requestId: string) => Promise<void>;
  isChatLoading: (workspaceId: string | null) => boolean;
  refreshPendingActions: () => Promise<void>;
  confirmPendingAction: (action: PendingAction) => Promise<void>;
  rejectPendingAction: (action: PendingAction) => Promise<void>;
  updatePendingAction: (action: PendingAction, text: string) => Promise<PendingAction>;
  loadProviderStatus: () => Promise<void>;
  clearConversation: (workspaceId: string) => Promise<void>;
  startVoice: () => Promise<void>;
  stopVoice: () => Promise<void>;
  cancelVoice: () => Promise<void>;
  discardVoiceTranscript: () => Promise<void>;
  setVoiceRequest: (status: VoiceRequestStatusView) => void;
  setVoiceLevel: (event: VoiceLevelEvent) => void;
  setTtsStatus: (status: TtsStatusView) => void;
  stopTts: () => Promise<void>;
}

let settingsSaveQueue = Promise.resolve();

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return error instanceof Error ? error.message : String(error);
}

export const useJarvisStore = create<JarvisStore>((set, get) => ({
  settings: defaultAppSettings(), settingsLoaded: false, settingsLoading: false, settingsError: null,
  expanded: false, dragging: false, settingsOpen: false, selectedAgentSessionId: null,
  context: null, contextStatus: "idle", contextError: null, registrySessions: [], isRefreshing: false,
  currentResult: null, currentResultSessionId: null, currentResultLoading: false, currentError: null,
  registryRefreshTimestamp: null, otherWorkspaceAgentCount: 0, conversation: [], pendingActions: [],
  requests: {}, chatErrors: {}, providerStatus: null, uiIntents: [], followUps: {},
  voiceRequest: null, voiceLevel: null, ttsStatus: { status: "idle" },

  loadSettings: async () => {
    set({ settingsLoading: true, settingsError: null });
    try { set({ settings: await getSettings(), settingsLoaded: true, settingsLoading: false }); }
    catch (error) { set({ settingsLoaded: true, settingsLoading: false, settingsError: errorMessage(error) }); }
  },
  saveSettings: async (settings) => {
    set({ settings, settingsError: null });
    settingsSaveQueue = settingsSaveQueue.catch(() => undefined).then(() => persistSettings(settings));
    try { await settingsSaveQueue; } catch (error) { set({ settingsError: errorMessage(error) }); throw error; }
  },
  updateJarvisSettings: async (updater) => {
    const current = get().settings;
    await get().saveSettings({ ...current, jarvis: updater(current.jarvis) });
  },
  showJarvis: async () => get().updateJarvisSettings((jarvis) => ({ ...jarvis, enabled: true })),
  hideJarvis: async () => { set({ expanded: false }); await get().updateJarvisSettings((jarvis) => ({ ...jarvis, enabled: false })); },
  toggleMuted: async () => get().updateJarvisSettings((jarvis) => ({ ...jarvis, muted: !jarvis.muted })),
  updateWidgetPosition: async (position) => get().updateJarvisSettings((jarvis) => ({ ...jarvis, widgetPosition: position })),
  resetJarvisSettings: async () => get().updateJarvisSettings(() => defaultJarvisSettings()),
  setExpanded: (expanded) => set({ expanded }), setDragging: (dragging) => set({ dragging }), setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSelectedAgentSessionId: (selectedAgentSessionId) => set({ selectedAgentSessionId }),
  clearResult: () => set({ currentResult: null, currentResultSessionId: null, currentResultLoading: false, currentError: null }),
  setContext: (context, contextStatus, contextError = null) => set((state) => ({ context: context ?? state.context, contextStatus, contextError })),
  setContextStatus: (contextStatus, contextError = null) => set({ contextStatus, contextError }),
  setRegistrySessions: (sessions) => set((state) => {
    const next = applyRegistrySnapshot({ sessions: state.registrySessions, selectedSessionId: state.selectedAgentSessionId, currentResult: state.currentResult, currentResultSessionId: state.currentResultSessionId, currentResultLoading: state.currentResultLoading, currentError: state.currentError }, sessions);
    return { registrySessions: next.sessions, selectedAgentSessionId: next.selectedSessionId, currentResult: next.currentResult, currentResultSessionId: next.currentResultSessionId, currentResultLoading: next.currentResultLoading, currentError: next.currentError };
  }),
  setRefreshing: (isRefreshing) => set({ isRefreshing }), setResult: (sessionId, currentResult) => set({ currentResultSessionId: sessionId, currentResult, currentResultLoading: false }),
  setResultLoading: (currentResultLoading) => set({ currentResultLoading }), setCurrentError: (currentError) => set({ currentError }),
  setRegistryRefreshTimestamp: (registryRefreshTimestamp) => set({ registryRefreshTimestamp }), setOtherWorkspaceAgentCount: (otherWorkspaceAgentCount) => set({ otherWorkspaceAgentCount }),
  loadLastResult: async (workspaceId, sessionId) => {
    set({ currentResultLoading: true, currentResultSessionId: sessionId, currentError: null });
    try { const envelope = await agentGetLastResult(workspaceId, sessionId); if (get().currentResultSessionId !== sessionId) return; set({ currentResult: envelope.data, currentResultLoading: false, currentError: envelope.warnings.length ? envelope.warnings.join(" · ") : null }); }
    catch (error) { if (get().currentResultSessionId === sessionId) set({ currentResultLoading: false, currentError: errorMessage(error) }); }
  },
  loadConversation: async (workspaceId) => {
    try {
      const history = await conversationHistory(workspaceId);
      set((state) => ({ conversation: mergeConversationMessages(state.conversation, history.filter((message) => message.workspaceId === workspaceId)) }));
    } catch { /* keep last valid conversation during a transient IPC failure */ }
  },
  sendMessage: async (message) => {
    const trimmed = message.trim();
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!trimmed || !workspaceId) { if (!workspaceId) set({ chatErrors: { ...get().chatErrors, [workspaceId ?? "none"]: "Nessuna workspace attiva" } }); return; }
    if (isWorkspaceChatLoading(get().requests, workspaceId)) { set((state) => ({ chatErrors: { ...state.chatErrors, [workspaceId]: "Attendi la risposta corrente o annullala." } })); return; }
    const invocation: InvocationBinding = { requestId: crypto.randomUUID(), targetWorkspaceId: workspaceId, createdAt: new Date().toISOString() };
    const userMessage: JarvisConversationMessage = { id: `local-user-${invocation.requestId}`, role: "user", content: trimmed, workspaceId, createdAt: invocation.createdAt };
    set((state) => ({ conversation: mergeConversationMessages(state.conversation, [userMessage]), requests: pruneRequestHistory({ ...state.requests, [invocation.requestId]: { requestId: invocation.requestId, workspaceId, createdAt: invocation.createdAt, status: "running" } }), chatErrors: { ...state.chatErrors, [workspaceId]: undefined } }));
    try {
      const response = await jarvisChat({ invocation, message: trimmed, messageId: userMessage.id });
      if (get().requests[invocation.requestId]?.status === "cancellation_requested") {
        set((state) => ({ requests: pruneRequestHistory({ ...state.requests, [invocation.requestId]: { ...state.requests[invocation.requestId], status: "cancelled" } }) }));
        return;
      }
      set((state) => ({ conversation: mergeConversationMessages(state.conversation, [response.message]), pendingActions: mergeActions(state.pendingActions, response.pendingActions), uiIntents: [...state.uiIntents.filter((intent) => intent.workspaceId !== workspaceId), ...response.uiIntents], followUps: { ...state.followUps, [workspaceId]: response.followUps }, requests: pruneRequestHistory({ ...state.requests, [invocation.requestId]: { ...state.requests[invocation.requestId], status: "completed" } }) }));
      const voiceSettings = get().settings.jarvis.voiceOutput;
      if (voiceSettings.enabled && voiceSettings.autoSpeak && voiceSettings.privacyConsent && voiceSettings.privacyConsentAt) {
        void ttsSpeak({ requestId: `tts-${response.message.id}`, text: response.message.content, voice: voiceSettings.voice, rate: voiceSettings.rate, volume: voiceSettings.volume, pitch: voiceSettings.pitch }).then((status) => set({ ttsStatus: status })).catch(() => undefined);
      }
    } catch (error) {
      const cancelled = error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "chat_cancelled";
      set((state) => ({ requests: pruneRequestHistory({ ...state.requests, [invocation.requestId]: { ...state.requests[invocation.requestId], status: cancelled ? "cancelled" : "failed", error: errorMessage(error) } }), chatErrors: { ...state.chatErrors, [workspaceId]: errorMessage(error) } }));
    }
  },
  cancelChatRequest: async (requestId) => {
    const request = get().requests[requestId];
    if (!request || (request.status !== "running" && request.status !== "cancellation_requested")) return;
    set((state) => ({ requests: pruneRequestHistory({ ...state.requests, [requestId]: { ...request, status: "cancellation_requested" } }) }));
    try { await cancelChat(requestId); } catch (error) { set((state) => ({ chatErrors: { ...state.chatErrors, [request.workspaceId]: errorMessage(error) } })); }
  },
  isChatLoading: (workspaceId) => isWorkspaceChatLoading(get().requests, workspaceId),
  refreshPendingActions: async () => { try { set({ pendingActions: (await pendingActions()).data }); } catch { /* preserve snapshot */ } },
  confirmPendingAction: async (action) => { try { const result = await confirmAction(action.id, action.invocation); set((state) => ({ pendingActions: state.pendingActions.map((item) => item.id === result.id ? result : item) })); } catch (error) { set((state) => ({ chatErrors: { ...state.chatErrors, [action.invocation.targetWorkspaceId]: errorMessage(error) } })); } },
  rejectPendingAction: async (action) => { try { const result = await rejectAction(action.id, action.invocation); set((state) => ({ pendingActions: state.pendingActions.map((item) => item.id === result.id ? result : item) })); } catch (error) { set((state) => ({ chatErrors: { ...state.chatErrors, [action.invocation.targetWorkspaceId]: errorMessage(error) } })); } },
  updatePendingAction: async (action, text) => { try { const result = await updatePendingAction(action.id, action.invocation, text); set((state) => ({ pendingActions: state.pendingActions.map((item) => item.id === result.id ? result : item) })); return result; } catch (error) { set((state) => ({ chatErrors: { ...state.chatErrors, [action.invocation.targetWorkspaceId]: errorMessage(error) } })); throw error; } },
  loadProviderStatus: async () => { try { set({ providerStatus: await providerStatus() }); } catch { /* advanced settings keeps last status */ } },
  clearConversation: async (workspaceId) => { await clearConversation(workspaceId); set((state) => ({ conversation: state.conversation.filter((message) => message.workspaceId !== workspaceId), uiIntents: state.uiIntents.filter((intent) => intent.workspaceId !== workspaceId), followUps: { ...state.followUps, [workspaceId]: [] } })); },
  startVoice: async () => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!workspaceId) return;
    if (get().ttsStatus.status === "playing" || get().ttsStatus.status === "synthesizing") await get().stopTts();
    const requestId = crypto.randomUUID();
    const status = await voiceStart({ requestId, workspaceId, selectedDeviceId: get().settings.jarvis.voiceInput.selectedInputDeviceId });
    set({ voiceRequest: status });
  },
  stopVoice: async () => { const requestId = get().voiceRequest?.requestId; if (!requestId) return; set((state) => state.voiceRequest ? { voiceRequest: { ...state.voiceRequest, status: "stopping" } } : state); const status = await voiceStop(requestId); set({ voiceRequest: status }); },
  cancelVoice: async () => { const requestId = get().voiceRequest?.requestId; if (!requestId) return; const status = await voiceCancel(requestId); set({ voiceRequest: status }); },
  discardVoiceTranscript: async () => { const requestId = get().voiceRequest?.requestId; if (!requestId) return; await voiceDiscardTranscript(requestId); set({ voiceRequest: null }); },
  setVoiceRequest: (voiceRequest) => set((state) => { if (state.voiceRequest && state.voiceRequest.requestId !== voiceRequest.requestId && voiceRequest.status !== "recording") return state; return { voiceRequest }; }),
  setVoiceLevel: (voiceLevel) => set((state) => state.voiceRequest?.requestId === voiceLevel.requestId ? { voiceLevel, voiceRequest: { ...state.voiceRequest, normalizedLevel: voiceLevel.normalizedLevel, durationMs: voiceLevel.elapsedMs } } : state),
  setTtsStatus: (ttsStatus) => set({ ttsStatus }),
  stopTts: async () => { const status = await ttsStop(); set({ ttsStatus: status }); },
}));

function mergeActions(current: PendingAction[], incoming: PendingAction[]): PendingAction[] {
  const byId = new Map(current.map((action) => [action.id, action]));
  for (const action of incoming) byId.set(action.id, action);
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
