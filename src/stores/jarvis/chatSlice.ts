import {
  cancelChat,
  confirmAction,
  conversationHistory,
  jarvisChat,
  pendingActions,
  rejectAction,
  ttsSpeak,
  updatePendingAction,
} from "../../lib/jarvis/client";
import {
  isWorkspaceChatLoading,
  mergeConversationMessages,
  mergeJarvisRequestState,
  pruneRequestHistory,
} from "../../lib/jarvis/chatState";
import { beginLocalTtsRequest } from "../../lib/jarvis/ttsState";
import { reportFrontendDiagnosticCode } from "../../lib/crashDiagnostics";
import { useWorkspaceStore } from "../workspaceStore";
import { sanitizedVoiceErrorView } from "../../lib/jarvis/voiceSettings";
import {
  errorMessage,
  isCodexChatStreamAvailable,
  mergeActions,
  voiceLog,
  voiceWarn,
  waitForCodexChatStreamBinding,
} from "./runtime";
import type { InvocationBinding, JarvisConversationMessage } from "../../lib/jarvis/types";
import type { JarvisSlice } from "./types";

export const createChatSlice: JarvisSlice = (set, get) => {
  const retryQueuedVoiceTranscript = (workspaceId: string) => {
    const state = get();
    const queued = Object.values(state.voiceRequests).find(
      (request) => request.workspaceId === workspaceId
        && request.status === "transcript_ready"
        && state.voiceSubmitStates[request.requestId] === "queued"
        && Boolean(request.transcript?.trim()),
    );
    if (!queued?.transcript?.trim()) return;
    void state.sendVoiceTranscript(queued.requestId, queued.transcript, { automatic: true })
      .catch((error) => voiceWarn("queued transcript retry failed", {
        requestId: queued.requestId,
        error: errorMessage(error),
      }));
  };

  return {
  loadConversation: async (workspaceId) => {
    try {
      const history = await conversationHistory(workspaceId);
      set((state) => ({
        conversation: mergeConversationMessages(
          state.conversation,
          history.filter((message) => message.workspaceId === workspaceId),
        ),
      }));
    } catch {
      // Keep the last valid conversation during a transient IPC failure.
    }
  },

  sendMessage: async (message, options = {}) => {
    const trimmed = message.trim();
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!trimmed || !workspaceId) {
      if (!workspaceId) {
        set({ chatErrors: { ...get().chatErrors, [workspaceId ?? "none"]: "Nessuna workspace attiva" } });
      }
      return false;
    }
    if (isWorkspaceChatLoading(get().requests, workspaceId)) {
      set((state) => ({
        chatErrors: { ...state.chatErrors, [workspaceId]: "Attendi la risposta corrente o annullala." },
      }));
      return false;
    }

    const invocation: InvocationBinding = {
      requestId: crypto.randomUUID(),
      targetWorkspaceId: workspaceId,
      createdAt: new Date().toISOString(),
    };
    const userMessage: JarvisConversationMessage = {
      id: `local-user-${invocation.requestId}`,
      role: "user",
      content: trimmed,
      workspaceId,
      createdAt: invocation.createdAt,
    };
    set((state) => ({
      conversation: mergeConversationMessages(state.conversation, [userMessage]),
      requests: pruneRequestHistory({
        ...state.requests,
        [invocation.requestId]: {
          requestId: invocation.requestId,
          workspaceId,
          voiceRequestId: options.voiceRequestId,
          createdAt: invocation.createdAt,
          status: "running",
        },
      }),
      chatErrors: { ...state.chatErrors, [workspaceId]: undefined },
    }));

    try {
      await waitForCodexChatStreamBinding();
      const response = await jarvisChat({ invocation, message: trimmed, messageId: userMessage.id });
      if (get().requests[invocation.requestId]?.status === "cancellation_requested") {
        voiceLog("chat response won a late local cancellation race", {
          requestId: invocation.requestId,
          voiceRequestId: options.voiceRequestId,
        });
      }
      set((state) => ({
        conversation: mergeConversationMessages(state.conversation, [response.message]),
        pendingActions: mergeActions(state.pendingActions, response.pendingActions),
        uiIntents: [
          ...state.uiIntents.filter((intent) => intent.workspaceId !== workspaceId),
          ...response.uiIntents,
        ],
        followUps: { ...state.followUps, [workspaceId]: response.followUps },
        requests: pruneRequestHistory({
          ...state.requests,
          [invocation.requestId]: mergeJarvisRequestState(state.requests[invocation.requestId], {
            ...state.requests[invocation.requestId],
            requestId: invocation.requestId,
            workspaceId,
            voiceRequestId: options.voiceRequestId,
            createdAt: invocation.createdAt,
            status: "completed",
            error: undefined,
          }),
        }),
      }));
      retryQueuedVoiceTranscript(workspaceId);

      const voiceSettings = get().settings.jarvis.voiceOutput;
      voiceLog("chat response accepted", {
        requestId: invocation.requestId,
        workspaceId,
        responseChars: response.message.content.length,
        autoSpeak: voiceSettings.enabled && voiceSettings.autoSpeak && Boolean(voiceSettings.privacyConsent && voiceSettings.privacyConsentAt),
      });
      const progressiveCodexSpeech = get().settings.jarvis.codex.speakCommentary && isCodexChatStreamAvailable();
      if (
        voiceSettings.enabled
        && voiceSettings.autoSpeak
        && voiceSettings.privacyConsent
        && voiceSettings.privacyConsentAt
        && !progressiveCodexSpeech
      ) {
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
        set((state) => ({ ...beginLocalTtsRequest(state, ttsRequestId, workspaceId), voiceError: null }));
        void ttsSpeak({
          requestId: ttsRequestId,
          workspaceId,
          text: response.message.content,
          voice: voiceSettings.voice,
          rate: voiceSettings.rate,
          volume: voiceSettings.volume,
          pitch: voiceSettings.pitch,
        })
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
            voiceWarn("tts request failed", {
              requestId: ttsRequestId,
              workspaceId,
              errorCode: errorView.code,
              error: errorView.message,
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
      return true;
    } catch (error) {
      const cancelled = error && typeof error === "object" && "code" in error
        && (error as { code: unknown }).code === "chat_cancelled";
      if (!cancelled) void cancelChat(invocation.requestId).catch(() => undefined);
      set((state) => ({
        requests: pruneRequestHistory({
          ...state.requests,
          [invocation.requestId]: mergeJarvisRequestState(state.requests[invocation.requestId], {
            ...state.requests[invocation.requestId],
            requestId: invocation.requestId,
            workspaceId,
            voiceRequestId: options.voiceRequestId,
            createdAt: invocation.createdAt,
            status: cancelled ? "cancelled" : "failed",
            error: errorMessage(error),
          }),
        }),
        chatErrors: { ...state.chatErrors, [workspaceId]: errorMessage(error) },
      }));
      retryQueuedVoiceTranscript(workspaceId);
      return false;
    }
  },

  cancelChatRequest: async (requestId) => {
    const request = get().requests[requestId];
    if (!request || (request.status !== "running" && request.status !== "cancellation_requested")) return;
    set((state) => ({
      requests: pruneRequestHistory({
        ...state.requests,
        [requestId]: mergeJarvisRequestState(state.requests[requestId], { ...request, status: "cancellation_requested" }),
      }),
    }));
    try {
      await cancelChat(requestId);
    } catch (error) {
      set((state) => ({ chatErrors: { ...state.chatErrors, [request.workspaceId]: errorMessage(error) } }));
    }
  },

  isChatLoading: (workspaceId) => isWorkspaceChatLoading(get().requests, workspaceId),
  refreshPendingActions: async () => {
    try {
      set({ pendingActions: (await pendingActions()).data });
    } catch {
      // Preserve the last snapshot.
    }
  },
  confirmPendingAction: async (action) => {
    try {
      const result = await confirmAction(action.id, action.invocation);
      set((state) => ({ pendingActions: state.pendingActions.map((item) => item.id === result.id ? result : item) }));
    } catch (error) {
      set((state) => ({ chatErrors: { ...state.chatErrors, [action.invocation.targetWorkspaceId]: errorMessage(error) } }));
    }
  },
  rejectPendingAction: async (action) => {
    try {
      const result = await rejectAction(action.id, action.invocation);
      set((state) => ({ pendingActions: state.pendingActions.map((item) => item.id === result.id ? result : item) }));
    } catch (error) {
      set((state) => ({ chatErrors: { ...state.chatErrors, [action.invocation.targetWorkspaceId]: errorMessage(error) } }));
    }
  },
  updatePendingAction: async (action, text) => {
    try {
      const result = await updatePendingAction(action.id, action.invocation, text);
      set((state) => ({ pendingActions: state.pendingActions.map((item) => item.id === result.id ? result : item) }));
      return result;
    } catch (error) {
      set((state) => ({ chatErrors: { ...state.chatErrors, [action.invocation.targetWorkspaceId]: errorMessage(error) } }));
      throw error;
    }
  },
  };
};
