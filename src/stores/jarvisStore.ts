import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  agentGetLastResult,
  cancelChat,
  clearConversation,
  codexAccountRead,
  codexLoginCancel,
  codexLoginStart,
  codexLogout,
  codexModelList,
  codexRateLimits,
  codexRuntimeRestart,
  codexRuntimeStart,
  codexRuntimeStatus,
  codexThreadDelete,
  codexThreadEnsure,
  codexThreads,
  codexTurnInterrupt,
  codexTurnSteer,
  codexTurnStart,
  codexUsage,
  confirmAction,
  conversationHistory,
  getSettings,
  getWakeWordStatus,
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
  voiceShutdown,
  voiceStart,
  voiceStop,
  voiceSyncShortcut,
  voiceWorkspaceStatus,
} from "../lib/jarvis/client";
import { defaultAppSettings, defaultJarvisSettings } from "../lib/jarvis/settings";
import { applyRegistrySnapshot } from "../lib/jarvis/registryState";
import { applyCodexChatStream, isWorkspaceChatLoading, mergeConversationMessages, pruneRequestHistory } from "../lib/jarvis/chatState";
import { clearSpeechQueue, dequeueSpeech, enqueueSpeech, rememberSpoken, shouldSpeakCommentary } from "../lib/jarvis/ttsState";
import { mergeActivityEvents, type ActivityCheckpoint } from "../lib/jarvis/activityState";
import { applyTtsStatusTransition, beginLocalTtsRequest } from "../lib/jarvis/ttsState";
import { reportFrontendDiagnosticCode } from "../lib/crashDiagnostics";
import { useWorkspaceStore } from "./workspaceStore";
import { sanitizedVoiceError, sanitizedVoiceErrorView } from "../lib/jarvis/voiceSettings";
import { decideVoiceSubmit } from "../lib/jarvis/voiceState";
import type {
  AgentResult,
  AgentSessionContext,
  AppSettings,
  InvocationBinding,
  JarvisConversationMessage,
  JarvisCodexThread,
  JarvisProviderStatus,
  JarvisRequestState,
  CodexAccountEvent,
  CodexAccountView,
  CodexChatStreamEvent,
  CodexModelCatalog,
  CodexSpeechItem,
  CodexRateLimitsView,
  CodexRuntimeStatus,
  CodexStreamingTurn,
  CodexThreadSnapshot,
  CodexUsageView,
  JarvisUiIntent,
  ModelContextViewV1,
  PendingAction,
  WidgetPosition,
  TtsStatusView,
  VoiceActivationMode,
  VoiceLevelEvent,
  VoiceRequestStatusView,
  VoiceSubmitState,
  WakeWordStatusView,
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
  codexRuntime: CodexRuntimeStatus | null;
  codexAccount: CodexAccountView | null;
  codexAccountLoading: boolean;
  codexLoginBusy: boolean;
  codexError: string | null;
  codexModels: CodexModelCatalog | null;
  codexModelsLoading: boolean;
  codexUsage: CodexUsageView | null;
  codexRateLimits: CodexRateLimitsView | null;
  codexThreads: Record<string, JarvisCodexThread>;
  // C7: per-workspace streaming turns (commentary/tool/final lifecycle).
  codexStreamingTurns: Record<string, CodexStreamingTurn[]>;
  // C8: progressive commentary speech queue (FIFO, dedupe itemId).
  codexSpeechQueue: CodexSpeechItem[];
  codexSpokenItemIds: string[];
  /** Review #6: last streamed completed-message text per workspace — lets
   *  the chat response path know the final was already handled by the
   *  progressive TTS worker (single owner for the final speech). */
  codexStreamFinal: Record<string, string | undefined>;
  dequeueCodexSpeech: (itemId: string) => void;
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
  sendMessage: (message: string) => Promise<boolean>;
  cancelChatRequest: (requestId: string) => Promise<void>;
  isChatLoading: (workspaceId: string | null) => boolean;
  refreshPendingActions: () => Promise<void>;
  confirmPendingAction: (action: PendingAction) => Promise<void>;
  rejectPendingAction: (action: PendingAction) => Promise<void>;
  updatePendingAction: (action: PendingAction, text: string) => Promise<PendingAction>;
  loadProviderStatus: () => Promise<void>;
  loadCodexRuntime: () => Promise<void>;
  startCodex: () => Promise<void>;
  loadCodexAccount: () => Promise<void>;
  loadCodexModels: () => Promise<void>;
  loadCodexUsage: () => Promise<void>;
  loadCodexRateLimits: () => Promise<void>;
  restartCodex: () => Promise<void>;
  startCodexLogin: () => Promise<void>;
  cancelCodexLogin: (loginId: string) => Promise<void>;
  logoutCodex: () => Promise<void>;
  clearConversation: (workspaceId: string) => Promise<void>;
  startVoice: (options?: { interruptTts?: boolean; activationMode?: VoiceActivationMode; forceEndpointing?: boolean }) => Promise<void>;
  stopVoice: () => Promise<void>;
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

let settingsSaveQueue = Promise.resolve();
const autoSubmittedVoiceRequests = new Set<string>();
const voiceSubmissionInFlight = new Set<string>();
const acceptedVoiceRequestIds = new Set<string>();
const ACCEPTED_VOICE_REQUESTS_STORAGE_KEY = "traflix.jarvis.accepted-voice-requests";
const MAX_ACCEPTED_VOICE_REQUESTS = 128;

function loadAcceptedVoiceRequestIds() {
  if (acceptedVoiceRequestIds.size > 0 || typeof localStorage === "undefined") return;
  try {
    const stored = JSON.parse(localStorage.getItem(ACCEPTED_VOICE_REQUESTS_STORAGE_KEY) ?? "[]");
    if (Array.isArray(stored)) {
      for (const value of stored) {
        if (typeof value === "string" && value.trim()) acceptedVoiceRequestIds.add(value);
      }
    }
  } catch {
    // A corrupted local marker must never prevent voice capture.
  }
}

function rememberAcceptedVoiceRequest(requestId: string) {
  loadAcceptedVoiceRequestIds();
  acceptedVoiceRequestIds.add(requestId);
  while (acceptedVoiceRequestIds.size > MAX_ACCEPTED_VOICE_REQUESTS) {
    acceptedVoiceRequestIds.delete(acceptedVoiceRequestIds.values().next().value as string);
  }
  try {
    localStorage.setItem(
      ACCEPTED_VOICE_REQUESTS_STORAGE_KEY,
      JSON.stringify([...acceptedVoiceRequestIds]),
    );
  } catch {
    // Persistence is a duplicate-submit guard, not a voice prerequisite.
  }
}

function wasVoiceRequestAccepted(requestId: string): boolean {
  loadAcceptedVoiceRequestIds();
  return acceptedVoiceRequestIds.has(requestId);
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return error instanceof Error ? error.message : String(error);
}

function voiceLog(message: string, details: Record<string, unknown> = {}) {
  console.info("[Jarvis voice]", message, details);
}

function voiceWarn(message: string, details: Record<string, unknown> = {}) {
  console.warn("[Jarvis voice]", message, details);
}

export const useJarvisStore = create<JarvisStore>((set, get) => ({
  settings: defaultAppSettings(), settingsLoaded: false, settingsLoading: false, settingsError: null,
  expanded: false, dragging: false, settingsOpen: false, selectedAgentSessionId: null,
  context: null, contextStatus: "idle", contextError: null, registrySessions: [], isRefreshing: false,
  currentResult: null, currentResultSessionId: null, currentResultLoading: false, currentError: null,
  registryRefreshTimestamp: null, otherWorkspaceAgentCount: 0, conversation: [], pendingActions: [],
  requests: {}, chatErrors: {}, providerStatus: null, codexRuntime: null, codexAccount: null,
  codexAccountLoading: false, codexLoginBusy: false, codexError: null, codexModels: null,
  codexModelsLoading: false, codexUsage: null, codexRateLimits: null, codexThreads: {},
  codexStreamingTurns: {},
  codexSpeechQueue: [],
  codexSpokenItemIds: [],
  codexStreamFinal: {},
  uiIntents: [], followUps: {},
  activities: [], voiceRequests: {}, voiceSubmitStates: {}, voiceLevel: null, wakeWordStatus: null, ttsStatus: { status: "idle", sequence: 0 },
  pendingTtsRequestId: null,
  activeVoiceRequestId: null,
  voiceStopRequested: false,
  voiceCancelRequested: false,
  voiceError: null,

  loadSettings: async () => {
    set({ settingsLoading: true, settingsError: null, voiceError: null });
    try {
      const loaded = await getSettings();
      set({ settings: loaded, settingsLoaded: true, settingsLoading: false, voiceError: null });
      await get().loadWakeWordStatus();
      await voiceSyncShortcut();
  }
  catch (error) { set({ settingsLoaded: true, settingsLoading: false, settingsError: errorMessage(error), voiceError: null }); }
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
        const message = sanitizedVoiceError(error);
        set({ voiceError: message });
        throw error;
      }
    }
    set({ settings, settingsError: null });
    settingsSaveQueue = settingsSaveQueue.catch(() => undefined).then(() => persistSettings(settings));
    try {
      await settingsSaveQueue;
      await get().loadWakeWordStatus();
      await voiceSyncShortcut();
    } catch (error) { set({ settingsError: errorMessage(error) }); throw error; }
  },
  updateJarvisSettings: async (updater) => {
    const current = get().settings;
    await get().saveSettings({ ...current, jarvis: updater(current.jarvis) });
  },
  showJarvis: async () => {
    await get().updateJarvisSettings((jarvis) => ({ ...jarvis, enabled: true }));
    // The right-rail Jarvis/bridge icon is the explicit activation boundary.
    await get().startCodex();
  },
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
    if (!trimmed || !workspaceId) { if (!workspaceId) set({ chatErrors: { ...get().chatErrors, [workspaceId ?? "none"]: "Nessuna workspace attiva" } }); return false; }
    if (isWorkspaceChatLoading(get().requests, workspaceId)) { set((state) => ({ chatErrors: { ...state.chatErrors, [workspaceId]: "Attendi la risposta corrente o annullala." } })); return false; }
    const invocation: InvocationBinding = { requestId: crypto.randomUUID(), targetWorkspaceId: workspaceId, createdAt: new Date().toISOString() };
    const userMessage: JarvisConversationMessage = { id: `local-user-${invocation.requestId}`, role: "user", content: trimmed, workspaceId, createdAt: invocation.createdAt };
    set((state) => ({ conversation: mergeConversationMessages(state.conversation, [userMessage]), requests: pruneRequestHistory({ ...state.requests, [invocation.requestId]: { requestId: invocation.requestId, workspaceId, createdAt: invocation.createdAt, status: "running" } }), chatErrors: { ...state.chatErrors, [workspaceId]: undefined } }));
    try {
      const response = await jarvisChat({ invocation, message: trimmed, messageId: userMessage.id });
      if (get().requests[invocation.requestId]?.status === "cancellation_requested") {
        set((state) => ({ requests: pruneRequestHistory({ ...state.requests, [invocation.requestId]: { ...state.requests[invocation.requestId], status: "cancelled" } }) }));
        return false;
      }
      set((state) => ({ conversation: mergeConversationMessages(state.conversation, [response.message]), pendingActions: mergeActions(state.pendingActions, response.pendingActions), uiIntents: [...state.uiIntents.filter((intent) => intent.workspaceId !== workspaceId), ...response.uiIntents], followUps: { ...state.followUps, [workspaceId]: response.followUps }, requests: pruneRequestHistory({ ...state.requests, [invocation.requestId]: { ...state.requests[invocation.requestId], status: "completed" } }) }));
      const voiceSettings = get().settings.jarvis.voiceOutput;
      voiceLog("chat response accepted", {
        requestId: invocation.requestId,
        workspaceId,
        responseChars: response.message.content.length,
        autoSpeak: voiceSettings.enabled && voiceSettings.autoSpeak && Boolean(voiceSettings.privacyConsent && voiceSettings.privacyConsentAt),
      });
      if (voiceSettings.enabled && voiceSettings.autoSpeak && voiceSettings.privacyConsent && voiceSettings.privacyConsentAt) {
        // Review #6: one owner for the final TTS. The progressive worker
        // already speaks the streamed final (C8, when speakCommentary is
        // on and the text passes the commentary filter). The final item
        // event is emitted before the invoke resolves, but the event
        // dispatch may be queued behind the promise microtask — wait a
        // beat for the streaming listener, then skip the legacy speak
        // when the final text matches what was streamed.
        const finalText = response.message.content.trim();
        const finalHandledByStream = await waitForStreamedFinal(workspaceId, finalText);
        if (finalHandledByStream) {
          voiceLog("final TTS handled by progressive stream; skipping legacy speak", {
            requestId: invocation.requestId,
            workspaceId,
          });
        } else {
          const ttsRequestId = `tts-${response.message.id}`;
        voiceLog("tts request started", {
          requestId: ttsRequestId,
          workspaceId,
          textChars: response.message.content.length,
          voice: voiceSettings.voice,
          rate: voiceSettings.rate,
          volume: voiceSettings.volume,
          pitch: voiceSettings.pitch,
        });
        // Block the hands-free re-arm immediately. The backend emits the same
        // synthesizing state, but setting it locally closes the small IPC gap
        // between a completed chat response and the first TTS event.
        set((state) => ({
          ...beginLocalTtsRequest(state, ttsRequestId, workspaceId),
          voiceError: null,
        }));
        void ttsSpeak({ requestId: ttsRequestId, workspaceId, text: response.message.content, voice: voiceSettings.voice, rate: voiceSettings.rate, volume: voiceSettings.volume, pitch: voiceSettings.pitch })
          .then((status) => {
            voiceLog("tts request completed", {
              requestId: ttsRequestId,
              workspaceId,
              status: status.status,
              sequence: status.sequence,
              errorCode: status.error?.code,
            });
            get().setTtsStatus(status);
          })
          .catch((error) => {
            const errorView = sanitizedVoiceErrorView(error, "tts_ipc_failed");
            const message = errorView.message;
            voiceWarn("tts request failed", {
              requestId: ttsRequestId,
              workspaceId,
              errorCode: errorView.code,
              error: message,
            });
            reportFrontendDiagnosticCode("jarvis-tts-error", errorView.code, {
              workspaceId,
              requestId: ttsRequestId,
              state: "ipc-failed",
            });
            get().setTtsStatus({
              requestId: ttsRequestId,
              workspaceId,
              sequence: get().ttsStatus.sequence,
              status: "failed",
              error: errorView,
            });
          });
        }
      }
      return true;
    } catch (error) {
      const cancelled = error && typeof error === "object" && "code" in error && (error as { code: unknown }).code === "chat_cancelled";
      // invokeWithTimeout cannot cancel a Tauri command by itself. Best-effort
      // cancellation keeps Rust from continuing to emit Thinking checkpoints
      // after the UI has already timed out.
      if (!cancelled) void cancelChat(invocation.requestId).catch(() => undefined);
      set((state) => ({ requests: pruneRequestHistory({ ...state.requests, [invocation.requestId]: { ...state.requests[invocation.requestId], status: cancelled ? "cancelled" : "failed", error: errorMessage(error) } }), chatErrors: { ...state.chatErrors, [workspaceId]: errorMessage(error) } }));
      return false;
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
  loadCodexRuntime: async () => {
    try {
      const runtime = await codexRuntimeStatus();
      set({ codexRuntime: runtime, codexError: runtime.lastError ? (codexErrorMessage(runtime.lastError)) : get().codexError });
    } catch { /* runtime may be warming up; keep last status */ }
  },
  startCodex: async () => {
    try {
      set({ codexRuntime: await codexRuntimeStart(), codexError: null });
    } catch (error) {
      set({ codexError: errorMessage(error) });
    }
  },
  loadCodexAccount: async () => {
    set({ codexAccountLoading: true });
    try {
      set({ codexAccount: await codexAccountRead(), codexAccountLoading: false });
    } catch (error) {
      set({ codexAccountLoading: false, codexError: errorMessage(error) });
    }
  },
  loadCodexModels: async () => {
    set({ codexModelsLoading: true });
    try {
      set({ codexModels: await codexModelList(), codexModelsLoading: false });
    } catch (error) {
      set({ codexModelsLoading: false, codexError: errorMessage(error) });
    }
  },
  loadCodexUsage: async () => {
    try { set({ codexUsage: await codexUsage() }); } catch { /* keep last usage */ }
  },
  loadCodexRateLimits: async () => {
    try { set({ codexRateLimits: await codexRateLimits() }); } catch { /* keep last snapshot */ }
  },
  dequeueCodexSpeech: (itemId) => {
    set((state) => ({
      codexSpeechQueue: dequeueSpeech(state.codexSpeechQueue, itemId),
      codexSpokenItemIds: rememberSpoken(
        state.codexSpokenItemIds,
        itemId,
      ),
    }));
  },
  clearCodexSpeech: () => {
    // Barge-in / mute: drop everything still pending (spec §17).
    set((state) => ({
      codexSpeechQueue: clearSpeechQueue(state.codexSpeechQueue),
    }));
  },
  loadCodexThreads: async () => {
    try {
      const snapshot = await codexThreads();
      set({
        codexThreads: Object.fromEntries(
          snapshot.threads.map((thread) => [thread.workspaceId, thread]),
        ),
      });
    } catch { /* keep last threads */ }
  },
  ensureCodexThread: async (workspaceId) => {
    try {
      await codexThreadEnsure(workspaceId);
      await get().loadCodexThreads();
    } catch { /* surfaced by the caller through codexError */ }
  },
  deleteCodexThread: async (workspaceId) => {
    try {
      await codexThreadDelete(workspaceId);
      set((state) => {
        const next = { ...state.codexThreads };
        delete next[workspaceId];
        return { codexThreads: next };
      });
    } catch { /* keep local record; runtime will clear on next start */ }
  },
  startCodexTurn: async (workspaceId, input) => {
    try {
      return await codexTurnStart(workspaceId, input);
    } catch {
      return null;
    }
  },
  interruptCodexTurn: async (workspaceId) => {
    try { await codexTurnInterrupt(workspaceId); } catch { /* turn may already be done */ }
  },
  steerCodexTurn: async (workspaceId, steerText) => {
    try { await codexTurnSteer(workspaceId, steerText); } catch { /* surfaced by caller */ }
  },
  restartCodex: async () => {
    set({ codexLoginBusy: true, codexError: null });
    try {
      set({ codexRuntime: await codexRuntimeRestart() });
    } catch (error) {
      set({ codexError: errorMessage(error) });
    } finally {
      set({ codexLoginBusy: false });
    }
  },
  startCodexLogin: async () => {
    set({ codexLoginBusy: true, codexError: null });
    try {
      const { authUrl } = await codexLoginStart();
      set({ codexLoginBusy: false });
      await openCodexAuthUrl(authUrl);
      // The flow completes via jarvis://codex-account notifications;
      // the global listener refreshes the account view on completion.
    } catch (error) {
      set({ codexLoginBusy: false, codexError: errorMessage(error) });
    }
  },
  cancelCodexLogin: async (loginId) => {
    try { await codexLoginCancel(loginId); } catch (error) { set({ codexError: errorMessage(error) }); }
  },
  logoutCodex: async () => {
    set({ codexLoginBusy: true, codexError: null });
    try {
      await codexLogout();
      set({ codexAccount: { account: { kind: "signedOut" }, requiresOpenaiAuth: true } });
    } catch (error) {
      set({ codexError: errorMessage(error) });
    } finally {
      set({ codexLoginBusy: false });
    }
  },
  clearConversation: async (workspaceId) => {
    await clearConversation(workspaceId);
    set((state) => ({
      conversation: state.conversation.filter((message) => message.workspaceId !== workspaceId),
      uiIntents: state.uiIntents.filter((intent) => intent.workspaceId !== workspaceId),
      followUps: { ...state.followUps, [workspaceId]: [] },
      // C4: the backend destroys the ephemeral Codex thread too; mirror
      // the local record immediately (event snapshot may not arrive).
      codexThreads: (() => {
        const next = { ...state.codexThreads };
        delete next[workspaceId];
        return next;
      })(),
    }));
  },
  startVoice: async (options = {}) => {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    const current = get();
    if (!current.settingsLoaded || !workspaceId || current.activeVoiceRequestId) {
      voiceLog("start skipped", {
        settingsLoaded: current.settingsLoaded,
        workspaceId,
        activeRequestId: current.activeVoiceRequestId,
      });
      return;
    }
    const requestId = crypto.randomUUID();
    voiceLog("start requested", { requestId, workspaceId, interruptTts: Boolean(options.interruptTts) });
    set({ activeVoiceRequestId: requestId, voiceStopRequested: false, voiceCancelRequested: false, voiceError: null });
    try {
      if (options.interruptTts && get().settings.jarvis.voiceOutput.stopOnUserSpeech && (get().ttsStatus.status === "playing" || get().ttsStatus.status === "synthesizing")) {
        // Do not block microphone startup on TTS acknowledgement. The
        // backend also stops the TTS-only token at the audio boundary when
        // VAD confirms speech, so this fast path cannot cancel the chat/task.
        void get().stopTts();
      }
      const status = await voiceStart({
        requestId,
        workspaceId,
        selectedDeviceId: get().settings.jarvis.voiceInput.selectedInputDeviceId,
        activationMode: options.activationMode,
        forceEndpointing: options.forceEndpointing,
      });
      voiceLog("start completed", { requestId, workspaceId, status: status.status, vadState: status.vadState });
      const stopAfterStart = get().voiceStopRequested;
      const cancelAfterStart = get().voiceCancelRequested;
      set((state) => ({ voiceRequests: { ...state.voiceRequests, [status.workspaceId]: status }, voiceError: null }));

      if (cancelAfterStart) {
        voiceLog("stop/cancel was requested while start was pending", { requestId, cancelAfterStart, stopAfterStart });
        await get().cancelVoice();
      } else if (stopAfterStart) {
        voiceLog("stop was requested while start was pending", { requestId });
        await get().stopVoice();
      }
    } catch (error) {
      voiceWarn("start failed", { requestId, error: sanitizedVoiceError(error) });
      const errorView = sanitizedVoiceErrorView(error, "voice_start_failed");
      const wakeUnavailable = options.activationMode === "wake_word"
        && ["wake_word_unavailable", "wake_word_disabled"].includes(errorView.code);
      set((state) => state.activeVoiceRequestId === requestId
        ? {
            activeVoiceRequestId: null,
            voiceStopRequested: false,
            voiceCancelRequested: false,
            voiceError: wakeUnavailable ? null : sanitizedVoiceError(error),
            wakeWordStatus: wakeUnavailable
              ? {
                  state: "unavailable",
                  enabled: true,
                  keyword: state.settings.jarvis.wakeWordPhrase,
                  engine: "disabled",
                  error: errorView,
                }
              : state.wakeWordStatus,
          }
        : { voiceError: sanitizedVoiceError(error) });
    }
  },
  stopVoice: async () => {
    const requestId = get().activeVoiceRequestId;
    if (!requestId) {
      voiceLog("stop skipped: no active request");
      return;
    }
    voiceLog("stop requested", { requestId });
    const current = Object.values(get().voiceRequests).find((request) => request.requestId === requestId);
    if (!current) {
      voiceLog("stop deferred until start completes", { requestId });
      set({ voiceStopRequested: true });
      return;
    }
    try {
      set({ voiceError: null, voiceStopRequested: false });
      set((state) => ({ voiceRequests: { ...state.voiceRequests, [current.workspaceId]: { ...current, status: "stopping" } } }));
      const status = await voiceStop(requestId);
      voiceLog("stop completed", { requestId, status: status.status, errorCode: status.error?.code, transcriptChars: status.transcript?.length ?? 0 });
      set((state) => ({
        voiceRequests: { ...state.voiceRequests, [status.workspaceId]: status },
        activeVoiceRequestId: status.status === "transcript_ready" || status.status === "cancelled" || status.status === "failed" || status.status === "idle" ? null : state.activeVoiceRequestId,
        voiceError: status.error ? sanitizedVoiceError(status.error) : null,
      }));
    } catch (error) {
      voiceWarn("stop failed", { requestId, error: sanitizedVoiceError(error) });
      set({ voiceError: sanitizedVoiceError(error) });
    }
  },
  cancelVoice: async () => {
    const requestId = get().activeVoiceRequestId;
    if (!requestId) {
      voiceLog("cancel skipped: no active request");
      return;
    }
    voiceLog("cancel requested", { requestId });
    const current = Object.values(get().voiceRequests).find((request) => request.requestId === requestId);
    if (!current) {
      voiceLog("cancel deferred until start completes", { requestId });
      set({ voiceCancelRequested: true });
      return;
    }
    try {
      set({ voiceError: null, voiceCancelRequested: false });
      const status = await voiceCancel(requestId);
      voiceLog("cancel completed", { requestId, status: status.status, errorCode: status.error?.code });
      set((state) => ({
        voiceRequests: { ...state.voiceRequests, [status.workspaceId]: status },
        activeVoiceRequestId: status.status === "cancelled" || status.status === "failed" || status.status === "idle" ? null : state.activeVoiceRequestId,
        voiceError: status.error ? sanitizedVoiceError(status.error) : null,
      }));
    } catch (error) {
      voiceWarn("cancel failed", { requestId, error: sanitizedVoiceError(error) });
      set({ voiceError: sanitizedVoiceError(error) });
    }
  },
  discardVoiceTranscript: async () => { try { set({ voiceError: null }); const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId; if (!activeWorkspaceId) return; const workspaceId = activeWorkspaceId; const requestId = get().voiceRequests[workspaceId]?.requestId; if (!requestId) return; await voiceDiscardTranscript(requestId); set((state) => { const voiceRequests = { ...state.voiceRequests }; delete voiceRequests[workspaceId]; return { voiceRequests, activeVoiceRequestId: state.activeVoiceRequestId === requestId ? null : state.activeVoiceRequestId }; }); } catch (error) { set({ voiceError: sanitizedVoiceError(error) }); } },
  sendVoiceTranscript: async (requestId, text, options = {}) => {
    const automatic = options.automatic === true;
    const submitState = get().voiceSubmitStates[requestId];
    if (submitState === "sent" || submitState === "submitting") {
      // The transcript is already owned by this handoff. This is the
      // frontend half of the single-flight guard against duplicate submits.
      return true;
    }
    const origin = Object.values(get().voiceRequests).find((request) => request.requestId === requestId);
    const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!origin || origin.status !== "transcript_ready" || origin.workspaceId !== activeWorkspaceId || !text.trim()) {
      voiceWarn("transcript submission skipped", {
        requestId,
        hasOrigin: Boolean(origin),
        originStatus: origin?.status,
        originWorkspaceId: origin?.workspaceId,
        activeWorkspaceId,
        transcriptChars: text.trim().length,
      });
      return false;
    }
    if (isWorkspaceChatLoading(get().requests, origin.workspaceId)) {
      // A chat turn may begin between transcript_ready and this handoff. Keep
      // the draft and explicitly queue it; the overlay retries when the
      // current turn leaves the running state.
      voiceWarn("transcript handoff deferred because chat is busy", { requestId });
      if (get().voiceSubmitStates[requestId] !== "queued") {
        set((state) => ({
          voiceSubmitStates: { ...state.voiceSubmitStates, [requestId]: "queued" },
        }));
      }
      return true;
    }
    if (voiceSubmissionInFlight.has(requestId)) return true;
    voiceSubmissionInFlight.add(requestId);
    set((state) => ({
      voiceSubmitStates: { ...state.voiceSubmitStates, [requestId]: "submitting" },
    }));
    voiceLog("transcript submission started", {
      requestId,
      workspaceId: origin.workspaceId,
      transcriptChars: text.trim().length,
      automatic,
    });
    let accepted: boolean;
    try {
      accepted = await get().sendMessage(text);
    } catch (error) {
      voiceSubmissionInFlight.delete(requestId);
      set((state) => ({
        voiceSubmitStates: { ...state.voiceSubmitStates, [requestId]: "manual" },
        voiceError: sanitizedVoiceError(error),
      }));
      throw error;
    }
    if (!accepted) {
      const chatError = get().chatErrors[origin.workspaceId];
      voiceWarn("transcript submission rejected; keeping draft and allowing a new capture", {
        requestId,
        chatError,
      });
      // The rejection happens in the frontend (chat busy, IPC failure, no
      // active workspace) and would otherwise be invisible in the backend
      // log; report the exact reason so voice failures are diagnosable.
      // The backend state token only accepts [a-z0-9_.:-], so the human
      // message is slugified here.
      const reasonSlug = chatError
        ? chatError
            .toLowerCase()
            .replace(/[àáâãä]/g, "a")
            .replace(/[èéêë]/g, "e")
            .replace(/[ìíîï]/g, "i")
            .replace(/[òóôõö]/g, "o")
            .replace(/[ùúûü]/g, "u")
            .replace(/[^a-z0-9_.:-]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 96)
        : "send-message-failed";
      reportFrontendDiagnosticCode(
        "jarvis-voice-submit-error",
        chatError ? "chat-rejected" : "submit-rejected",
        {
          workspaceId: origin.workspaceId,
          requestId,
          state: reasonSlug,
        },
      );
      set({
        voiceError: chatError
          ? `Jarvis non ha accettato la trascrizione: ${chatError}`
          : "La trascrizione non è stata inviata a Jarvis. Riprovare quando vuoi.",
        voiceSubmitStates: {
          ...get().voiceSubmitStates,
          [requestId]: chatError ? "queued" : "manual",
        },
      });
      voiceSubmissionInFlight.delete(requestId);
      return false;
    }
    voiceLog("transcript accepted by Jarvis chat", { requestId });
    rememberAcceptedVoiceRequest(requestId);
    // The chat request is already accepted. Remove the local draft first so a
    // cleanup-only IPC failure cannot block the next hands-free capture or
    // cause the same transcript to be submitted a second time in this session.
    set((state) => {
      const voiceRequests = { ...state.voiceRequests };
      delete voiceRequests[origin.workspaceId];
      return {
        voiceRequests,
        voiceSubmitStates: { ...state.voiceSubmitStates, [requestId]: "sent" },
        activeVoiceRequestId: state.activeVoiceRequestId === requestId ? null : state.activeVoiceRequestId,
      };
    });
    voiceSubmissionInFlight.delete(requestId);
    try {
      await voiceDiscardTranscript(requestId);
      voiceLog("transcript draft discarded after successful submission", { requestId });
    } catch (error) {
      voiceWarn("transcript cleanup failed after chat accepted it; no retry will be issued", {
        requestId,
        error: sanitizedVoiceError(error),
      });
    }
    return true;
  },
  loadVoiceDraft: async (workspaceId) => {
    try {
      const status = await voiceWorkspaceStatus(workspaceId);
      if (status && wasVoiceRequestAccepted(status.requestId)) {
        voiceWarn("accepted transcript draft found during reload; cleanup only", {
          requestId: status.requestId,
          workspaceId,
        });
        void voiceDiscardTranscript(status.requestId).catch((error) => {
          voiceWarn("accepted transcript cleanup retry failed", {
            requestId: status.requestId,
            error: sanitizedVoiceError(error),
          });
        });
        set((state) => {
          const voiceRequests = { ...state.voiceRequests };
          delete voiceRequests[workspaceId];
          return {
            voiceRequests,
            activeVoiceRequestId: state.activeVoiceRequestId === status.requestId
              ? null
              : state.activeVoiceRequestId,
          };
        });
        return;
      }
      set((state) => {
        const voiceRequests = { ...state.voiceRequests };
        if (status) voiceRequests[workspaceId] = status;
        else delete voiceRequests[workspaceId];
        return {
          voiceRequests,
          activeVoiceRequestId: status && ["armed", "recording", "stopping", "transcribing"].includes(status.status)
            ? status.requestId
            : state.activeVoiceRequestId,
        };
      });
    } catch { /* preserve the last valid draft during a transient IPC failure */ }
  },
  setVoiceRequest: (voiceRequest) => {
    let shouldAutoSubmit = false;
    let shouldInterruptTts = false;
    set((state) => {
      const current = state.voiceRequests[voiceRequest.workspaceId];
      voiceLog("voice state event received", {
        requestId: voiceRequest.requestId,
        workspaceId: voiceRequest.workspaceId,
        status: voiceRequest.status,
        errorCode: voiceRequest.error?.code,
        transcriptChars: voiceRequest.transcript?.length ?? 0,
      });
      // A new request is allowed to replace a previous terminal draft only
      // when it is the request currently being started. Late events from an
      // older capture must never overwrite a newer recording.
      const hasDifferentActiveRequest = Boolean(
        state.activeVoiceRequestId &&
        state.activeVoiceRequestId !== voiceRequest.requestId,
      );
      const isDifferentFromCurrent = Boolean(
        current && current.requestId !== voiceRequest.requestId,
      );
      if (
        (hasDifferentActiveRequest && !current) ||
        (isDifferentFromCurrent && (hasDifferentActiveRequest || (voiceRequest.status !== "armed" && voiceRequest.status !== "recording")))
      ) {
        voiceWarn("stale voice state event ignored", {
          requestId: voiceRequest.requestId,
          currentRequestId: current?.requestId,
          activeRequestId: state.activeVoiceRequestId,
          status: voiceRequest.status,
        });
        return state;
      }
      shouldInterruptTts = voiceRequest.status === "recording"
        && current?.requestId === voiceRequest.requestId
        && current.status !== "recording"
        && state.settings.jarvis.voiceOutput.stopOnUserSpeech
        && (state.ttsStatus.status === "playing" || state.ttsStatus.status === "synthesizing");
      const submitDecision = decideVoiceSubmit({
        status: voiceRequest.status,
        hasTranscript: Boolean(voiceRequest.transcript?.trim()),
        autoSubmit: state.settings.jarvis.voiceInput.autoSubmitTranscript,
        chatBusy: isWorkspaceChatLoading(state.requests, voiceRequest.workspaceId),
        alreadyClaimed: Boolean(
          autoSubmittedVoiceRequests.has(voiceRequest.requestId) ||
          ["sent", "submitting"].includes(state.voiceSubmitStates[voiceRequest.requestId] ?? ""),
        ),
      });
      shouldAutoSubmit = ["send", "queue"].includes(submitDecision)
        && useWorkspaceStore.getState().activeWorkspaceId === voiceRequest.workspaceId;
      if (voiceRequest.status === "transcript_ready") {
        voiceLog("transcript ready for chat handoff", {
          requestId: voiceRequest.requestId,
          workspaceId: voiceRequest.workspaceId,
          transcriptChars: voiceRequest.transcript?.length ?? 0,
          autoSubmit: shouldAutoSubmit,
          chatBusy: isWorkspaceChatLoading(state.requests, voiceRequest.workspaceId),
        });
      }
      const terminal = ["idle", "transcript_ready", "cancelled", "failed"].includes(voiceRequest.status);
      const voiceSubmitStates = { ...state.voiceSubmitStates };
      if (
        voiceRequest.status === "transcript_ready" &&
        !voiceSubmitStates[voiceRequest.requestId] &&
        !state.settings.jarvis.voiceInput.autoSubmitTranscript
      ) {
        voiceSubmitStates[voiceRequest.requestId] = "manual";
      }
      return {
        voiceRequests: { ...state.voiceRequests, [voiceRequest.workspaceId]: voiceRequest },
        voiceSubmitStates,
        activeVoiceRequestId: terminal && state.activeVoiceRequestId === voiceRequest.requestId ? null : state.activeVoiceRequestId ?? (terminal ? null : voiceRequest.requestId),
        voiceError: voiceRequest.error?.code === "voice_vad_timeout" ? null : voiceRequest.error ? sanitizedVoiceError(voiceRequest.error) : state.voiceError,
      };
    });
    // If capture was explicitly started while TTS was active, stop only once
    // VAD has crossed into real speech. Merely arming must not cancel a reply.
    if (shouldInterruptTts) {
      void ttsStop()
        .then((status) => get().setTtsStatus(status))
        .catch((error) => set({ voiceError: sanitizedVoiceError(error) }));
    }
    if (shouldAutoSubmit && !autoSubmittedVoiceRequests.has(voiceRequest.requestId)) {
      autoSubmittedVoiceRequests.add(voiceRequest.requestId);
      while (autoSubmittedVoiceRequests.size > 128) autoSubmittedVoiceRequests.delete(autoSubmittedVoiceRequests.values().next().value as string);
      void get().sendVoiceTranscript(voiceRequest.requestId, voiceRequest.transcript ?? "", { automatic: true }).then((accepted) => {
        if (!accepted) {
          autoSubmittedVoiceRequests.delete(voiceRequest.requestId);
          voiceWarn("automatic transcript submission did not start chat", { requestId: voiceRequest.requestId });
        }
      }).catch((error) => {
        autoSubmittedVoiceRequests.delete(voiceRequest.requestId);
        voiceWarn("automatic transcript submission threw", { requestId: voiceRequest.requestId, error: sanitizedVoiceError(error) });
        set({ voiceError: sanitizedVoiceError(error) });
      });

    }
  },
  applyActivityEvents: (activities) => set((state) => ({ activities: mergeActivityEvents(state.activities, activities) })),
  clearWorkspaceActivities: (workspaceId) => set((state) => ({ activities: state.activities.filter((event) => event.workspaceId !== workspaceId) })),
  setVoiceLevel: (voiceLevel) => set((state) => { const request = Object.values(state.voiceRequests).find((item) => item.requestId === voiceLevel.requestId); if (!request) return state; return { voiceLevel, voiceRequests: { ...state.voiceRequests, [request.workspaceId]: { ...request, normalizedLevel: voiceLevel.normalizedLevel, durationMs: voiceLevel.elapsedMs, vadState: voiceLevel.vadState } } }; }),
  setWakeWordStatus: (wakeWordStatus) => set({ wakeWordStatus }),
  setVoiceSubmitState: (requestId, submitState) => set((state) => ({
    voiceSubmitStates: { ...state.voiceSubmitStates, [requestId]: submitState },
  })),
  setTtsStatus: (ttsStatus) => set((state) => {
    const transition = applyTtsStatusTransition(state, ttsStatus);
    if (!transition.accepted) {
      voiceWarn("stale tts state event ignored", {
        requestId: ttsStatus.requestId,
        workspaceId: ttsStatus.workspaceId,
        sequence: ttsStatus.sequence,
        currentRequestId: state.ttsStatus.requestId,
        currentSequence: state.ttsStatus.sequence,
        pendingRequestId: state.pendingTtsRequestId,
        status: ttsStatus.status,
      });
      return state;
    }
    return {
      ttsStatus: transition.ttsStatus,
      pendingTtsRequestId: transition.pendingTtsRequestId,
      voiceError: ttsStatus.error
        ? sanitizedVoiceError(ttsStatus.error)
        : ["synthesizing", "playing", "idle"].includes(ttsStatus.status)
          ? null
          : state.voiceError,
    };
  }),
  stopTts: async () => { try { const status = await ttsStop(); get().setTtsStatus(status); } catch (error) { set({ voiceError: sanitizedVoiceError(error) }); } },
  clearVoiceError: () => set({ voiceError: null }),
}));

function mergeActions(current: PendingAction[], incoming: PendingAction[]): PendingAction[] {
  const byId = new Map(current.map((action) => [action.id, action]));
  for (const action of incoming) byId.set(action.id, action);
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function codexErrorMessage(message: string): string {
  const code = message.split(": ")[0];
  switch (code) {
    case "codex_not_installed":
      return "Codex CLI non installato: installa il pacchetto npm `@openai/codex` e riavvia.";
    case "codex_version_mismatch":
      return "Versione Codex troppo vecchia: serve >= 0.147.0.";
    case "codex_runtime_start_failed":
      return "Impossibile avviare il runtime Codex (handshake fallito).";
    case "codex_runtime_crashed":
      return "Il runtime Codex non è in esecuzione (riavvialo dalla sezione Codex).";
    default:
      return message;
  }
}

/** Opens the ChatGPT OAuth URL in the internal incognito browser. */
/** Review #6: waits (bounded) for the streaming listener to process the
 *  final `message_completed` of the turn and reports whether its text
 *  matches the chat response — i.e. the progressive TTS worker already
 *  owns (or will own) the final speech.
 *
 *  The final item event is emitted by the backend before the invoke
 *  resolves, but the WebView may dispatch the event after the promise
 *  microtask, so we poll the store for a short window instead of relying
 *  on ordering. Text equality is reliable because both the streamed
 *  payload and the chat response come from the same `item/completed`.
 */
async function waitForStreamedFinal(
  workspaceId: string,
  finalText: string,
): Promise<boolean> {
  const deadline = Date.now() + 300;
  while (Date.now() < deadline) {
    const streamed = useJarvisStore.getState().codexStreamFinal[workspaceId];
    if (streamed !== undefined) {
      return streamed.trim() === finalText;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return false;
}

async function openCodexAuthUrl(authUrl: string): Promise<void> {
  await invoke("browser_create");
  await invoke("browser_navigate", { url: authUrl });
}

/**
 * Binds the global Codex runtime + account event listeners. Idempotent:
 * each call returns an unlisten function (call from a root effect).
 */
export function bindCodexEvents(): () => void {
  const unlisteners: Array<() => void> = [];

  // C7 observability: per-turn/per-tool `performance.now()` anchors used to
  // log latencies from the chat stream. Kept module-private and bounded —
  // entries are removed when their turn/tool terminates.
  const chatStreamTimings = new Map<
    string,
    { startedAt: number; toolName: string | null }
  >();
  const startedAt = () => performance.now();
  const durationMs = (anchor: { startedAt: number }) =>
    Math.round(performance.now() - anchor.startedAt);
  void listen<CodexRuntimeStatus>("jarvis://codex-runtime", (event) => {
    useJarvisStore.setState((state) => ({
      codexRuntime: event.payload,
      codexError: event.payload.lastError
        ? codexErrorMessage(event.payload.lastError)
        : state.codexError,
    }));
  }).then((unlisten) => unlisteners.push(unlisten));
  void listen<CodexAccountEvent>("jarvis://codex-account", (event) => {
    const method = event.payload.method;
    if (
      method === "account/login/completed" ||
      method === "account/updated"
    ) {
      // Refresh the account view; the completion notification carries no
      // token data (login/error only), so a fresh read is always safe.
      void useJarvisStore.getState().loadCodexAccount();
    }
  }).then((unlisten) => unlisteners.push(unlisten));
  // C3: the backend merges incremental rate-limit updates into the last
  // snapshot and forwards the merged result here (never null-overwrites).
  void listen<unknown>("jarvis://codex-rate-limits", (event) => {
    useJarvisStore.setState({
      codexRateLimits: { snapshot: event.payload },
    });
  }).then((unlisten) => unlisteners.push(unlisten));
  // C4: thread snapshots (started/completed/deleted transitions) are
  // emitted by the backend registry after every lifecycle change.
  void listen<CodexThreadSnapshot>("jarvis://codex-thread", (event) => {
    useJarvisStore.setState({
      codexThreads: Object.fromEntries(
        event.payload.threads.map((thread) => [thread.workspaceId, thread]),
      ),
    });
  }).then((unlisten) => unlisteners.push(unlisten));
  // C7: streaming conversation events (commentary deltas, tool lifecycle,
  // final message marking, turn completion).
  void listen<CodexChatStreamEvent>("jarvis://chat-stream", (event) => {
    const payload = event.payload;
    const meta = {
      requestId: payload.requestId ?? undefined,
      workspaceId: payload.workspaceId ?? undefined,
      turnId: payload.turnId ?? undefined,
      itemId: payload.itemId ?? undefined,
    };
    // C7 observability: log lifecycle transitions with real durations
    // (never reasoning content or tool payloads).
    switch (payload.kind) {
      case "turn_started":
        chatStreamTimings.set(`turn:${payload.turnId}`, {
          startedAt: startedAt(),
          toolName: null,
        });
        console.info("[Jarvis Codex] turn started", meta);
        break;
      case "tool_started":
        chatStreamTimings.set(`tool:${payload.itemId}`, {
          startedAt: startedAt(),
          toolName: payload.toolName,
        });
        console.info("[Jarvis Codex tool] started", {
          ...meta,
          tool: payload.toolName ?? undefined,
        });
        break;
      case "tool_completed": {
        const anchor = chatStreamTimings.get(`tool:${payload.itemId}`);
        console.info("[Jarvis Codex tool] completed", {
          ...meta,
          tool: payload.toolName ?? anchor?.toolName ?? undefined,
          durationMs: anchor ? durationMs(anchor) : undefined,
        });
        if (anchor) chatStreamTimings.delete(`tool:${payload.itemId}`);
        break;
      }
      case "message_completed":
        console.info("[Jarvis Codex] commentary completed", {
          ...meta,
          chars: payload.text?.length ?? 0,
        });
        break;
      case "turn_completed": {
        const anchor = chatStreamTimings.get(`turn:${payload.turnId}`);
        console.info("[Jarvis Codex] turn completed", {
          ...meta,
          durationMs: anchor ? durationMs(anchor) : undefined,
        });
        if (anchor) chatStreamTimings.delete(`turn:${payload.turnId}`);
        break;
      }
      case "turn_failed":
      case "turn_interrupted": {
        const anchor = chatStreamTimings.get(`turn:${payload.turnId}`);
        console.info(`[Jarvis Codex] turn ${payload.kind.slice(5)}`, {
          ...meta,
          durationMs: anchor ? durationMs(anchor) : undefined,
        });
        if (anchor) chatStreamTimings.delete(`turn:${payload.turnId}`);
        break;
      }
      default:
        break;
    }
    useJarvisStore.setState((state) => ({
      codexStreamingTurns: applyCodexChatStream(
        state.codexStreamingTurns,
        event.payload,
      ),
    }));
    // C8: progressive TTS — enqueue completed commentary/final items.
    const store = useJarvisStore.getState();
    if (payload.kind === "message_completed" && payload.text) {
      // Review #6: remember the LAST streamed message text per workspace
      // (the final answer) so the chat response path can skip the legacy
      // TTS speak — one owner for the final speech. Updated on every
      // completed message; cleared when a new turn starts below.
      const finalText = payload.text;
      useJarvisStore.setState((state) => ({
        codexStreamFinal: {
          ...state.codexStreamFinal,
          [payload.workspaceId ?? "unknown"]: finalText,
        },
      }));
    }
    if (payload.kind === "turn_started") {
      // New turn: the previous final is no longer authoritative.
      const cleared: Record<string, string | undefined> = {
        ...useJarvisStore.getState().codexStreamFinal,
        [payload.workspaceId ?? "unknown"]: undefined,
      };
      useJarvisStore.setState({ codexStreamFinal: cleared });
    }
    if (
      payload.kind === "message_completed" &&
      payload.text &&
      !store.codexSpokenItemIds.includes(payload.itemId ?? "") &&
      store.settings.jarvis.codex.speakCommentary &&
      store.settings.jarvis.voiceOutput.enabled &&
      store.settings.jarvis.voiceOutput.autoSpeak &&
      Boolean(
        store.settings.jarvis.voiceOutput.privacyConsent &&
          store.settings.jarvis.voiceOutput.privacyConsentAt,
      ) &&
      !store.settings.jarvis.muted &&
      shouldSpeakCommentary(payload.text)
    ) {
      useJarvisStore.setState((state) => ({
        codexSpeechQueue: enqueueSpeech(state.codexSpeechQueue, {
          itemId: payload.itemId ?? `msg-${payload.turnId ?? "unknown"}`,
          turnId: payload.turnId ?? "unknown",
          workspaceId: payload.workspaceId ?? "unknown",
          text: payload.text ?? "",
        }),
      }));
      console.info("[Jarvis TTS] commentary queued", {
        ...meta,
        chars: payload.text.length,
      });
    }
  }).then((unlisten) => unlisteners.push(unlisten));
  return () => {
    for (const unlisten of unlisteners) unlisten();
  };
}
