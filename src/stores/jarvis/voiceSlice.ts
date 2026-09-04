import {
  ttsStop,
  voiceCancel,
  voiceDiscardTranscript,
  voiceStart,
  voiceStop,
  voiceWorkspaceStatus,
} from "../../lib/jarvis/client";
import { mergeActivityEvents, type ActivityCheckpoint } from "../../lib/jarvis/activityState";
import { isWorkspaceChatLoading } from "../../lib/jarvis/chatState";
import { reportFrontendDiagnosticCode } from "../../lib/crashDiagnostics";
import { applyTtsStatusTransition } from "../../lib/jarvis/ttsState";
import { sanitizedVoiceError, sanitizedVoiceErrorView } from "../../lib/jarvis/voiceSettings";
import { mergeVoiceRequestStatus } from "../../lib/jarvis/voiceState";
import { useWorkspaceStore } from "../workspaceStore";
import { voiceLog, voiceWarn, VOICE_LEVEL_UI_MIN_INTERVAL_MS } from "./runtime";
import type { JarvisSlice } from "./types";

const voiceSubmissionInFlight = new Set<string>();
const acceptedVoiceRequestIds = new Set<string>();
const ACCEPTED_VOICE_REQUESTS_STORAGE_KEY = "traflix.jarvis.accepted-voice-requests";
const MAX_ACCEPTED_VOICE_REQUESTS = 128;

function loadAcceptedVoiceRequestIds(): void {
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

function rememberAcceptedVoiceRequest(requestId: string): void {
  loadAcceptedVoiceRequestIds();
  acceptedVoiceRequestIds.add(requestId);
  while (acceptedVoiceRequestIds.size > MAX_ACCEPTED_VOICE_REQUESTS) {
    acceptedVoiceRequestIds.delete(acceptedVoiceRequestIds.values().next().value as string);
  }
  try {
    localStorage.setItem(ACCEPTED_VOICE_REQUESTS_STORAGE_KEY, JSON.stringify([...acceptedVoiceRequestIds]));
  } catch {
    // Persistence is a duplicate-submit guard, not a voice prerequisite.
  }
}

function wasVoiceRequestAccepted(requestId: string): boolean {
  loadAcceptedVoiceRequestIds();
  return acceptedVoiceRequestIds.has(requestId);
}

export const createVoiceSlice: JarvisSlice = (set, get) => ({
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
    voiceLog("start requested", { requestId, workspaceId });
    set({ activeVoiceRequestId: requestId, voiceStopRequested: false, voiceCancelRequested: false, voiceError: null });
    try {
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
      set((state) => ({
        voiceRequests: {
          ...state.voiceRequests,
          [status.workspaceId]: mergeVoiceRequestStatus(state.voiceRequests[status.workspaceId], status),
        },
        voiceError: null,
      }));
      if (cancelAfterStart) {
        voiceLog("stop/cancel was requested while start was pending", { requestId, cancelAfterStart, stopAfterStart });
        await get().cancelVoice();
      } else if (stopAfterStart) {
        voiceLog("stop was requested while start was pending", { requestId });
        const stopped = await get().stopVoice();
        if (stopped?.status === "transcript_ready" && stopped.transcript?.trim()) {
          await get().sendVoiceTranscript(stopped.requestId, stopped.transcript);
        }
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
      return null;
    }
    voiceLog("stop requested", { requestId });
    const current = Object.values(get().voiceRequests).find((request) => request.requestId === requestId);
    if (!current) {
      voiceLog("stop deferred until start completes", { requestId });
      set({ voiceStopRequested: true });
      return null;
    }
    try {
      set({ voiceError: null, voiceStopRequested: false });
      set((state) => ({
        voiceRequests: {
          ...state.voiceRequests,
          [current.workspaceId]: mergeVoiceRequestStatus(state.voiceRequests[current.workspaceId], { ...current, status: "stopping" }),
        },
      }));
      const status = await voiceStop(requestId);
      voiceLog("stop completed", { requestId, status: status.status, errorCode: status.error?.code, transcriptChars: status.transcript?.length ?? 0 });
      set((state) => {
        const nextStatus = mergeVoiceRequestStatus(state.voiceRequests[status.workspaceId], status);
        return {
          voiceRequests: { ...state.voiceRequests, [status.workspaceId]: nextStatus },
          activeVoiceRequestId: ["transcript_ready", "cancelled", "failed", "idle"].includes(nextStatus.status)
            ? null
            : state.activeVoiceRequestId,
          voiceError: nextStatus.error ? sanitizedVoiceError(nextStatus.error) : null,
        };
      });
      return status;
    } catch (error) {
      voiceWarn("stop failed", { requestId, error: sanitizedVoiceError(error) });
      set({ voiceError: sanitizedVoiceError(error) });
      return null;
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
    if (!current || !["armed", "recording", "stopping", "transcribing"].includes(current.status)) {
      voiceLog("cancel skipped: voice handoff owns the request", {
        requestId,
        status: current?.status,
        submitState: get().voiceSubmitStates[requestId],
      });
      if (!current) set({ voiceCancelRequested: true });
      return;
    }
    try {
      set({ voiceError: null, voiceCancelRequested: false });
      const status = await voiceCancel(requestId);
      voiceLog("cancel completed", { requestId, status: status.status, errorCode: status.error?.code });
      set((state) => {
        const currentVoice = Object.values(state.voiceRequests).find((request) => request.requestId === requestId);
        const handoffOwnsRequest = ["submitting", "sent"].includes(state.voiceSubmitStates[requestId] ?? "")
          || currentVoice?.status === "transcript_ready";
        if (handoffOwnsRequest) {
          voiceLog("stale voice cancellation ignored after handoff", {
            requestId,
            voiceStatus: currentVoice?.status,
            submitState: state.voiceSubmitStates[requestId],
          });
          return state;
        }
        const nextStatus = mergeVoiceRequestStatus(state.voiceRequests[status.workspaceId], status);
        return {
          voiceRequests: { ...state.voiceRequests, [status.workspaceId]: nextStatus },
          activeVoiceRequestId: ["cancelled", "failed", "idle"].includes(nextStatus.status)
            ? null
            : state.activeVoiceRequestId,
          voiceError: nextStatus.error ? sanitizedVoiceError(nextStatus.error) : null,
        };
      });
    } catch (error) {
      voiceWarn("cancel failed", { requestId, error: sanitizedVoiceError(error) });
      set({ voiceError: sanitizedVoiceError(error) });
    }
  },

  discardVoiceTranscript: async () => {
    try {
      set({ voiceError: null });
      const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
      if (!activeWorkspaceId) return;
      const requestId = get().voiceRequests[activeWorkspaceId]?.requestId;
      if (!requestId) return;
      await voiceDiscardTranscript(requestId);
      set((state) => {
        const voiceRequests = { ...state.voiceRequests };
        delete voiceRequests[activeWorkspaceId];
        return {
          voiceRequests,
          activeVoiceRequestId: state.activeVoiceRequestId === requestId ? null : state.activeVoiceRequestId,
        };
      });
    } catch (error) {
      set({ voiceError: sanitizedVoiceError(error) });
    }
  },

  sendVoiceTranscript: async (requestId, text, options = {}) => {
    const automatic = options.automatic === true;
    const submitState = get().voiceSubmitStates[requestId];
    if (submitState === "sent" || submitState === "submitting") return true;
    const origin = Object.values(get().voiceRequests).find((request) => request.requestId === requestId);
    const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!origin || origin.status !== "transcript_ready" || !text.trim()) {
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
      voiceWarn("transcript handoff deferred because chat is busy", { requestId });
      if (get().voiceSubmitStates[requestId] !== "queued") {
        set((state) => ({ voiceSubmitStates: { ...state.voiceSubmitStates, [requestId]: "queued" } }));
      }
      return true;
    }
    if (voiceSubmissionInFlight.has(requestId)) return true;
    voiceSubmissionInFlight.add(requestId);
    set((state) => ({
      voiceSubmitStates: { ...state.voiceSubmitStates, [requestId]: "submitting" },
      activeVoiceRequestId: state.activeVoiceRequestId === requestId ? null : state.activeVoiceRequestId,
    }));
    // A new explicit voice handoff supersedes commentary still waiting in the
    // FIFO. If an item is already playing, ttsSpeak is not interrupted; its
    // completion callback remains harmless when the queue item is gone.
    if (get().codexSpeechQueue.length > 0) get().clearCodexSpeech();
    voiceLog("transcript submission started", {
      requestId,
      workspaceId: origin.workspaceId,
      transcriptChars: text.trim().length,
      automatic,
    });

    let accepted: boolean;
    try {
      accepted = await get().sendMessage(text, {
        voiceRequestId: requestId,
        workspaceId: origin.workspaceId,
      });
    } catch (error) {
      voiceSubmissionInFlight.delete(requestId);
      set((state) => ({
        voiceSubmitStates: { ...state.voiceSubmitStates, [requestId]: "failed" },
        voiceError: sanitizedVoiceError(error),
      }));
      throw error;
    }
    if (!accepted) {
      const chatError = get().chatErrors[origin.workspaceId];
      voiceWarn("transcript submission rejected; keeping draft and allowing a new capture", { requestId, chatError });
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
      reportFrontendDiagnosticCode("jarvis-voice-submit-error", chatError ? "chat-rejected" : "submit-rejected", {
        workspaceId: origin.workspaceId,
        requestId,
        state: reasonSlug,
      });
      set({
        voiceError: chatError
          ? `Jarvis non ha accettato la trascrizione: ${chatError}`
          : "La trascrizione non è stata inviata a Jarvis. Riprovare quando vuoi.",
        voiceSubmitStates: { ...get().voiceSubmitStates, [requestId]: chatError ? "queued" : "failed" },
      });
      voiceSubmissionInFlight.delete(requestId);
      return false;
    }

    voiceLog("transcript accepted by Jarvis chat", { requestId });
    rememberAcceptedVoiceRequest(requestId);
    set((state) => {
      const voiceRequests = { ...state.voiceRequests };
      if (voiceRequests[origin.workspaceId]?.requestId === requestId) delete voiceRequests[origin.workspaceId];
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
        voiceWarn("accepted transcript draft found during reload; cleanup only", { requestId: status.requestId, workspaceId });
        void voiceDiscardTranscript(status.requestId).catch((error) => {
          voiceWarn("accepted transcript cleanup retry failed", { requestId: status.requestId, error: sanitizedVoiceError(error) });
        });
        set((state) => {
          const voiceRequests = { ...state.voiceRequests };
          delete voiceRequests[workspaceId];
          return {
            voiceRequests,
            activeVoiceRequestId: state.activeVoiceRequestId === status.requestId ? null : state.activeVoiceRequestId,
          };
        });
        return;
      }
      set((state) => {
        const voiceRequests = { ...state.voiceRequests };
        const nextStatus = status ? mergeVoiceRequestStatus(voiceRequests[workspaceId], status) : undefined;
        if (nextStatus) voiceRequests[workspaceId] = nextStatus;
        else delete voiceRequests[workspaceId];
        return {
          voiceRequests,
          activeVoiceRequestId: nextStatus && ["armed", "recording", "stopping", "transcribing"].includes(nextStatus.status)
            ? nextStatus.requestId
            : state.activeVoiceRequestId,
        };
      });
    } catch {
      // Preserve the last valid draft during a transient IPC failure.
    }
  },

  setVoiceRequest: (voiceRequest) => {
    set((state) => {
      const current = state.voiceRequests[voiceRequest.workspaceId];
      const submitState = state.voiceSubmitStates[voiceRequest.requestId];
      voiceLog("voice state event received", {
        requestId: voiceRequest.requestId,
        workspaceId: voiceRequest.workspaceId,
        status: voiceRequest.status,
        errorCode: voiceRequest.error?.code,
        transcriptChars: voiceRequest.transcript?.length ?? 0,
      });
      if (["queued", "submitting", "sent"].includes(submitState ?? "") && ["cancelled", "failed", "idle"].includes(voiceRequest.status)) {
        voiceWarn("stale terminal voice event ignored during handoff", { requestId: voiceRequest.requestId, status: voiceRequest.status, submitState });
        return state;
      }
      const hasDifferentActiveRequest = Boolean(state.activeVoiceRequestId && state.activeVoiceRequestId !== voiceRequest.requestId);
      const isDifferentFromCurrent = Boolean(current && current.requestId !== voiceRequest.requestId);
      if (
        (hasDifferentActiveRequest && !current)
        || (isDifferentFromCurrent && (hasDifferentActiveRequest || (voiceRequest.status !== "armed" && voiceRequest.status !== "recording")))
      ) {
        voiceWarn("stale voice state event ignored", {
          requestId: voiceRequest.requestId,
          currentRequestId: current?.requestId,
          activeRequestId: state.activeVoiceRequestId,
          status: voiceRequest.status,
        });
        return state;
      }
      const nextVoiceRequest = mergeVoiceRequestStatus(current, voiceRequest);
      if (nextVoiceRequest === current) {
        voiceWarn("stale voice state event ignored", { requestId: voiceRequest.requestId, currentRequestId: current?.requestId, activeRequestId: state.activeVoiceRequestId, status: voiceRequest.status });
        return state;
      }
      if (nextVoiceRequest.status === "transcript_ready") {
        voiceLog("transcript ready for chat handoff", {
          requestId: nextVoiceRequest.requestId,
          workspaceId: nextVoiceRequest.workspaceId,
          transcriptChars: nextVoiceRequest.transcript?.length ?? 0,
          autoSubmit: false,
          chatBusy: isWorkspaceChatLoading(state.requests, nextVoiceRequest.workspaceId),
        });
      }
      const terminal = ["idle", "transcript_ready", "cancelled", "failed"].includes(nextVoiceRequest.status);
      const voiceSubmitStates = { ...state.voiceSubmitStates };
      if (nextVoiceRequest.status === "transcript_ready" && !voiceSubmitStates[nextVoiceRequest.requestId] && !state.settings.jarvis.voiceInput.autoSubmitTranscript) {
        voiceSubmitStates[nextVoiceRequest.requestId] = "manual";
      }
      return {
        voiceRequests: { ...state.voiceRequests, [nextVoiceRequest.workspaceId]: nextVoiceRequest },
        voiceSubmitStates,
        activeVoiceRequestId: terminal && state.activeVoiceRequestId === nextVoiceRequest.requestId
          ? null
          : state.activeVoiceRequestId ?? (terminal ? null : nextVoiceRequest.requestId),
        voiceError: nextVoiceRequest.error?.code === "voice_vad_timeout"
          ? null
          : nextVoiceRequest.error
            ? sanitizedVoiceError(nextVoiceRequest.error)
            : state.voiceError,
      };
    });
  },

  applyActivityEvents: (activities: ActivityCheckpoint[]) => set((state) => ({ activities: mergeActivityEvents(state.activities, activities) })),
  clearWorkspaceActivities: (workspaceId) => set((state) => ({ activities: state.activities.filter((event) => event.workspaceId !== workspaceId) })),
  setVoiceLevel: (voiceLevel) => set((state) => {
    const request = Object.values(state.voiceRequests).find((item) => item.requestId === voiceLevel.requestId);
    if (!request || (request.durationMs ?? -1) > voiceLevel.elapsedMs) return state;
    const previous = state.voiceLevel;
    if (
      previous
      && previous.requestId === voiceLevel.requestId
      && previous.vadState === voiceLevel.vadState
      && previous.endpointState === voiceLevel.endpointState
      && voiceLevel.elapsedMs - previous.elapsedMs < VOICE_LEVEL_UI_MIN_INTERVAL_MS
    ) return state;
    return {
      voiceLevel,
      voiceRequests: {
        ...state.voiceRequests,
        [request.workspaceId]: {
          ...request,
          normalizedLevel: voiceLevel.normalizedLevel,
          durationMs: voiceLevel.elapsedMs,
          vadState: voiceLevel.vadState,
          endpointState: voiceLevel.endpointState ?? request.endpointState,
        },
      },
    };
  }),
  setWakeWordStatus: (wakeWordStatus) => set({ wakeWordStatus }),
  setVoiceSubmitState: (requestId, submitState) => set((state) => ({ voiceSubmitStates: { ...state.voiceSubmitStates, [requestId]: submitState } })),
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
  stopTts: async () => {
    try {
      const status = await ttsStop();
      get().setTtsStatus(status);
    } catch (error) {
      set({ voiceError: sanitizedVoiceError(error) });
    }
  },
  clearVoiceError: () => set({ voiceError: null }),
});
