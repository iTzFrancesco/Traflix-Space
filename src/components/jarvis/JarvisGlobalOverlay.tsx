import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useState } from "react";
import { subscribeAgentTurnCompleted } from "../../lib/terminalEvents";
import {
  agentSnapshot,
  buildModelContext,
  ttsSpeak,
  voiceWorkspaceStatus,
} from "../../lib/jarvis/client";
import type {
  TtsStatusView,
  VoiceActivationMode,
  VoiceLevelEvent,
  VoiceRequestStatusView,
  WakeWordStatusView,
} from "../../lib/jarvis/types";
import type { ActivityCheckpoint } from "../../lib/jarvis/activityState";
import { SettingsModal } from "../layout/SettingsModal";
import { useJarvisStore, bindCodexEvents } from "../../stores/jarvisStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
  beginVoicePress,
  releaseVoicePress,
  type VoicePress,
} from "../../lib/jarvis/voiceActivation";
import { isJarvisOwnerModeReady } from "../../lib/jarvis/settings";
import {
  reportFrontendDiagnostic,
  reportFrontendDiagnosticCode,
} from "../../lib/crashDiagnostics";
import {
  sanitizedVoiceError,
  sanitizedVoiceErrorView,
} from "../../lib/jarvis/voiceSettings";
import { JarvisWidget } from "./JarvisWidget";

const AUTO_ARM_DELAY_MS = 180;
const VOICE_TRANSCRIPTION_RECONCILE_MS = 1_000;

export function JarvisGlobalOverlay() {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const activeWorkspaceName = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId)?.name ?? null,
  );
  const settings = useJarvisStore((state) => state.settings);
  const settingsLoaded = useJarvisStore((state) => state.settingsLoaded);
  const settingsOpen = useJarvisStore((state) => state.settingsOpen);
  const context = useJarvisStore((state) => state.context);
  const contextStatus = useJarvisStore((state) => state.contextStatus);
  const contextError = useJarvisStore((state) => state.contextError);
  const registrySessions = useJarvisStore((state) => state.registrySessions);
  const isRefreshing = useJarvisStore((state) => state.isRefreshing);
  const pendingActions = useJarvisStore((state) => state.pendingActions);
  const requests = useJarvisStore((state) => state.requests);
  const chatErrors = useJarvisStore((state) => state.chatErrors);
  const voiceRequests = useJarvisStore((state) => state.voiceRequests);
  const voiceSubmitStates = useJarvisStore((state) => state.voiceSubmitStates);
  const activeVoiceRequestId = useJarvisStore(
    (state) => state.activeVoiceRequestId,
  );
  const voiceRequest = activeWorkspaceId
    ? voiceRequests[activeWorkspaceId] ?? null
    : null;
  // Audio ownership is global even when the user changes workspace during a
  // recording/transcription. The visible request remains workspace-scoped,
  // but commentary TTS must not speak over a voice turn in another workspace.
  const activeVoiceRequest = activeVoiceRequestId
    ? Object.values(voiceRequests).find(
        (request) => request.requestId === activeVoiceRequestId,
      ) ?? null
    : null;
  const activities = useJarvisStore((state) => state.activities);
  const ttsStatus = useJarvisStore((state) => state.ttsStatus);
  const wakeWordStatus = useJarvisStore((state) => state.wakeWordStatus);
  const voiceError = useJarvisStore((state) => state.voiceError);
  const codexSpeechQueue = useJarvisStore((state) => state.codexSpeechQueue);
  const clearCodexSpeech = useJarvisStore((state) => state.clearCodexSpeech);
  const dequeueCodexSpeech = useJarvisStore((state) => state.dequeueCodexSpeech);
  const speechWorkerBusyRef = useRef(false);
  const speechRetryCountsRef = useRef<Map<string, number>>(new Map());
  const previousVoiceCaptureRef = useRef<{
    requestId: string;
    status: VoiceRequestStatusView["status"];
  } | null>(null);
  const loadSettings = useJarvisStore((state) => state.loadSettings);
  const bootstrapCodex = useJarvisStore((state) => state.bootstrapCodex);
  const setContext = useJarvisStore((state) => state.setContext);
  const setContextStatus = useJarvisStore((state) => state.setContextStatus);
  const setRegistrySessions = useJarvisStore((state) => state.setRegistrySessions);
  const setRefreshing = useJarvisStore((state) => state.setRefreshing);
  const setRegistryRefreshTimestamp = useJarvisStore(
    (state) => state.setRegistryRefreshTimestamp,
  );
  const refreshPendingActions = useJarvisStore(
    (state) => state.refreshPendingActions,
  );
  const loadProviderStatus = useJarvisStore((state) => state.loadProviderStatus);
  const setSettingsOpen = useJarvisStore((state) => state.setSettingsOpen);
  const startVoice = useJarvisStore((state) => state.startVoice);
  const stopVoice = useJarvisStore((state) => state.stopVoice);
  const sendVoiceTranscript = useJarvisStore((state) => state.sendVoiceTranscript);
  const loadVoiceDraft = useJarvisStore((state) => state.loadVoiceDraft);
  const setVoiceRequest = useJarvisStore((state) => state.setVoiceRequest);
  const applyActivityEvents = useJarvisStore((state) => state.applyActivityEvents);
  const clearWorkspaceActivities = useJarvisStore(
    (state) => state.clearWorkspaceActivities,
  );
  const setVoiceLevel = useJarvisStore((state) => state.setVoiceLevel);
  const clearVoiceError = useJarvisStore((state) => state.clearVoiceError);
  const setTtsStatus = useJarvisStore((state) => state.setTtsStatus);
  const setWakeWordStatus = useJarvisStore((state) => state.setWakeWordStatus);
  const shortcutPressedRef = useRef<VoicePress | null>(null);
  const shortcutGenerationRef = useRef(0);
  const registryRequestRef = useRef(0);
  const resumeVoiceDraftRef = useRef<Set<string>>(new Set());
  const settingsRecoveryDraftRef = useRef<Set<string>>(new Set());
  const settingsWasOpenRef = useRef(settingsOpen);
  const [bargeInRequestId, setBargeInRequestId] = useState<string | null>(null);
  const chatError = activeWorkspaceId
    ? chatErrors[activeWorkspaceId] ?? null
    : null;

  const startBargeIn = useCallback((activationMode: VoiceActivationMode = "vad") => {
    const currentTtsStatus = useJarvisStore.getState().ttsStatus.status;
    const ttsActive = currentTtsStatus === "synthesizing" || currentTtsStatus === "playing";
    void startVoice({
      activationMode,
      forceEndpointing: activationMode === "vad" && ttsActive,
    }).then(() => {
      const requestId = useJarvisStore.getState().activeVoiceRequestId;
      if (ttsActive && requestId) setBargeInRequestId(requestId);
    });
  }, [startVoice]);

  useEffect(() => {
    // Voice errors are diagnostic UI state, not a global lock. A failed
    // request in workspace A must not prevent hands-free auto-arm in B.
    if (activeWorkspaceId) clearVoiceError();
  }, [activeWorkspaceId, clearVoiceError]);

  useEffect(() => {
    if (!bargeInRequestId) return;
    if (activeVoiceRequestId === bargeInRequestId) return;
    if (
      voiceRequest?.requestId === bargeInRequestId &&
      voiceRequest.status !== "cancelled" &&
      voiceRequest.status !== "failed"
    ) {
      return;
    }
    setBargeInRequestId(null);
  }, [activeVoiceRequestId, bargeInRequestId, voiceRequest]);

  const refreshRegistry = useCallback(
    async (
      targetWorkspaceId: string | null =
        useWorkspaceStore.getState().activeWorkspaceId,
    ) => {
      if (!targetWorkspaceId) return;
      const requestNumber = ++registryRequestRef.current;
      setRefreshing(true);
      try {
        const snapshot = await agentSnapshot(targetWorkspaceId);
        if (
          requestNumber !== registryRequestRef.current ||
          useWorkspaceStore.getState().activeWorkspaceId !== targetWorkspaceId
        ) {
          return;
        }
        setRegistrySessions(snapshot.data);
        setRegistryRefreshTimestamp(new Date().toISOString());
      } catch {
        // Preserve the last valid registry snapshot.
      } finally {
        if (requestNumber === registryRequestRef.current) setRefreshing(false);
      }
    },
    [setRefreshing, setRegistryRefreshTimestamp, setRegistrySessions],
  );

  const refreshContext = useCallback(async () => {
    const target = useWorkspaceStore.getState().activeWorkspaceId;
    if (!target) return;
    setContextStatus("loading");
    try {
      const result = await buildModelContext("summary");
      if (useWorkspaceStore.getState().activeWorkspaceId !== target) return;
      setContext(result, "ready");
    } catch (error) {
      if (useWorkspaceStore.getState().activeWorkspaceId === target) {
        setContext(
          null,
          "unavailable",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }, [setContext, setContextStatus]);

  // C8: progressive commentary speech worker. Speaks the completed
  // commentary/final items in FIFO order while Codex keeps working; never
  // speaks over the final reply (waits until TTS is idle) and stops
  // instantly on barge-in (user speech) or mute.
  useEffect(() => {
    if (speechWorkerBusyRef.current) return;
    const item = codexSpeechQueue[0];
    if (!item) return;
    const voiceTurnActive = activeVoiceRequest
      && ["armed", "recording", "stopping", "transcribing", "transcript_ready"].includes(
        activeVoiceRequest.status,
      );
    // Voice capture owns the audio channel. Keep Codex commentary queued and
    // resume it after the voice turn instead of dropping messages mid-speech.
    if (voiceTurnActive) return;
    const busy =
      ttsStatus.status === "synthesizing" ||
      ttsStatus.status === "playing";
    if (busy) return;
    const store = useJarvisStore.getState();
    if (
      !store.settings.jarvis.voiceOutput.enabled ||
      !store.settings.jarvis.voiceOutput.autoSpeak ||
      store.settings.jarvis.muted
    ) {
      store.clearCodexSpeech();
      return;
    }
    speechWorkerBusyRef.current = true;
    const settings = store.settings.jarvis.voiceOutput;
    const requestId = `tts-codex-${item.itemId}`;
    console.info("[Jarvis TTS] commentary speaking", {
      itemId: item.itemId,
      turnId: item.turnId,
      requestId,
      workspaceId: item.workspaceId,
    });
    void ttsSpeak({
      requestId,
      workspaceId: item.workspaceId,
      text: item.text,
      voice: settings.voice,
      rate: settings.rate,
      volume: settings.volume,
      pitch: settings.pitch,
    })
      .then((status) => {
        console.info("[Jarvis TTS] commentary completed", {
          itemId: item.itemId,
          turnId: item.turnId,
          requestId,
        });
        speechRetryCountsRef.current.delete(item.itemId);
        useJarvisStore.getState().setTtsStatus(status);
        useJarvisStore.getState().dequeueCodexSpeech(item.itemId);
      })
      .catch((error) => {
        const errorView = sanitizedVoiceErrorView(error, "tts_ipc_failed");
        const attempts = (speechRetryCountsRef.current.get(item.itemId) ?? 0) + 1;
        speechRetryCountsRef.current.set(item.itemId, attempts);
        console.warn("[Jarvis TTS] commentary failed", {
          itemId: item.itemId,
          turnId: item.turnId,
          requestId,
          errorCode: errorView.code,
          attempt: attempts,
        });
        if (attempts >= 3) {
          // The helper already retries internally. After three client-level
          // attempts, release this item so one broken provider cannot block
          // every later step forever; successful items are dequeued above.
          speechRetryCountsRef.current.delete(item.itemId);
          useJarvisStore.getState().dequeueCodexSpeech(item.itemId);
          return;
        }
        // Keep the failed item at the head of the FIFO. A fresh array reference
        // wakes this effect after a short backoff without losing its text or
        // allowing later steps to overtake it.
        const retryDelayMs = Math.min(2_000, 250 * 2 ** (attempts - 1));
        window.setTimeout(() => {
          const currentQueue = useJarvisStore.getState().codexSpeechQueue;
          if (currentQueue[0]?.itemId !== item.itemId) return;
          useJarvisStore.setState({ codexSpeechQueue: [...currentQueue] });
        }, retryDelayMs);
      })
      .finally(() => {
        speechWorkerBusyRef.current = false;
      });
  }, [
    activeVoiceRequest?.requestId,
    activeVoiceRequest?.status,
    codexSpeechQueue,
    dequeueCodexSpeech,
    ttsStatus.status,
  ]);

  // Pending commentary is stale at the moment a new voice turn starts. The
  // backend stops active playback at the audio boundary; this clears queued
  // items so an interrupted turn cannot speak old instructions afterward.
  useEffect(() => {
    const current = activeVoiceRequest;
    const previous = previousVoiceCaptureRef.current;
    const enteringRecording = current?.status === "recording"
      && (previous?.requestId !== current.requestId || previous.status !== "recording");
    if (enteringRecording) {
      const queued = useJarvisStore.getState().codexSpeechQueue;
      if (queued.length > 0) {
        console.info("[Jarvis TTS] queue cleared by barge-in", {
          droppedItems: queued.length,
          itemIds: queued.map((entry) => entry.itemId),
        });
        clearCodexSpeech();
      }
    }
    previousVoiceCaptureRef.current = current
      ? { requestId: current.requestId, status: current.status }
      : null;
  }, [activeVoiceRequest?.requestId, activeVoiceRequest?.status, clearCodexSpeech]);

  const toggleMicrophoneMuted = useCallback(async () => {
    const store = useJarvisStore.getState();
    const nextMuted = !store.settings.jarvis.muted;
    if (nextMuted && store.activeVoiceRequestId) {
      try {
        await store.cancelVoice();
      } catch {
        // Mute still wins even if an already-finished request races the cancel.
      }
      store.clearVoiceError();
    }
    if (!nextMuted) store.clearVoiceError();
    await store.toggleMuted();
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Codex runtime + account events (C1/C2): refresh diagnostics state
  // whenever the App Server emits a status or account notification.
  useEffect(() => {
    const unlisten = bindCodexEvents();
    return unlisten;
  }, []);

  // The runtime is lazy, but a persisted/enabled Jarvis widget is already an
  // explicit activation boundary. Start Codex only after settings are known,
  // then load account and status data through the single-flight bootstrap.
  useEffect(() => {
    if (!settingsLoaded || !settings.jarvis.enabled) return;
    void bootstrapCodex();
  }, [bootstrapCodex, settings.jarvis.enabled, settingsLoaded]);

  // A failed transcript submission must not create an automatic retry loop.
  // Closing Settings is an explicit recovery boundary: if the user just fixed
  // credentials/configuration, permit exactly one retry of the preserved draft.
  useEffect(() => {
    const wasOpen = settingsWasOpenRef.current;
    settingsWasOpenRef.current = settingsOpen;
    if (!wasOpen || settingsOpen || !activeWorkspaceId) return;
    const draft = useJarvisStore.getState().voiceRequests[activeWorkspaceId];
    if (draft?.status === "transcript_ready") {
      settingsRecoveryDraftRef.current.add(draft.requestId);
    }
  }, [activeWorkspaceId, settingsOpen]);

  useEffect(() => {
    if (!activeWorkspaceId || !settings.jarvis.enabled || settingsOpen) return;
    const workspaceId = activeWorkspaceId;
    let disposed = false;

    void loadVoiceDraft(workspaceId).then(() => {
      if (
        disposed ||
        useWorkspaceStore.getState().activeWorkspaceId !== workspaceId
      ) {
        return;
      }
      const store = useJarvisStore.getState();
      const draft = store.voiceRequests[workspaceId];
      const chatBusy = Object.values(store.requests).some(
        (request) =>
          request.workspaceId === workspaceId &&
          (request.status === "running" ||
            request.status === "cancellation_requested"),
      );
      const recoveryAllowed = draft
        ? settingsRecoveryDraftRef.current.has(draft.requestId)
        : false;
      const previousChatFailed = Boolean(store.chatErrors[workspaceId]);
      if (
        store.settings.jarvis.enabled &&
        !store.settingsOpen &&
        draft?.status === "transcript_ready" &&
        Boolean(draft.transcript?.trim()) &&
        store.settings.jarvis.voiceInput.autoSubmitTranscript &&
        !chatBusy &&
        (!previousChatFailed || recoveryAllowed) &&
        !resumeVoiceDraftRef.current.has(draft.requestId)
      ) {
        settingsRecoveryDraftRef.current.delete(draft.requestId);
        resumeVoiceDraftRef.current.add(draft.requestId);
        void store
          .sendVoiceTranscript(draft.requestId, draft.transcript ?? "")
          .then((accepted) => {
            if (!accepted) {
              console.warn("[Jarvis voice] draft submission was rejected", {
                requestId: draft.requestId,
              });
            }
          })
          .catch((error) => {
            console.error("[Jarvis voice] draft submission failed", {
              requestId: draft.requestId,
              error: sanitizedVoiceError(error),
            });
          })
          .finally(() => resumeVoiceDraftRef.current.delete(draft.requestId));
      }
    });

    return () => {
      disposed = true;
    };
  }, [
    activeWorkspaceId,
    chatErrors,
    loadVoiceDraft,
    requests,
    settings.jarvis.enabled,
    settingsOpen,
  ]);

  // Reconcile a terminal backend snapshot if the WebView missed or reordered
  // the Tauri event. This is deliberately a status read, not a cancellation
  // watchdog: long manual captures and slow uploads remain user-controlled.
  useEffect(() => {
    if (
      !activeWorkspaceId ||
      !voiceRequest ||
      voiceRequest.status !== "transcribing"
    ) {
      return;
    }
    const workspaceId = activeWorkspaceId;
    const requestId = voiceRequest.requestId;
    let disposed = false;

    const reconcile = async () => {
      try {
        const status = await voiceWorkspaceStatus(workspaceId);
        if (
          disposed ||
          !status ||
          status.requestId !== requestId ||
          !["transcript_ready", "cancelled", "failed", "idle"].includes(status.status)
        ) {
          return;
        }
        console.warn("[Jarvis voice] reconciled missed terminal state", {
          requestId,
          workspaceId,
          status: status.status,
        });
        setVoiceRequest(status);
      } catch (error) {
        if (!disposed) {
          console.debug("[Jarvis voice] terminal state reconciliation skipped", {
            requestId,
            workspaceId,
            error: sanitizedVoiceError(error),
          });
        }
      }
    };

    void reconcile();
    const timer = window.setInterval(
      () => void reconcile(),
      VOICE_TRANSCRIPTION_RECONCILE_MS,
    );
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [
    activeWorkspaceId,
    setVoiceRequest,
    voiceRequest?.requestId,
    voiceRequest?.status,
  ]);

  // A transcript that reached the endpoint while the current turn was still
  // running remains a draft. Retry only queued request ids; the store owns the
  // single-flight guard and never drops the transcript.
  useEffect(() => {
    if (!activeWorkspaceId || settingsOpen || !settings.jarvis.voiceInput.autoSubmitTranscript) return;
    const draft = voiceRequests[activeWorkspaceId];
    if (
      draft?.status !== "transcript_ready" ||
      !draft.transcript?.trim() ||
      voiceSubmitStates[draft.requestId] !== "queued"
    ) {
      return;
    }
    void sendVoiceTranscript(draft.requestId, draft.transcript, { automatic: true }).catch((error) => {
      console.warn("[Jarvis voice] queued transcript retry failed", {
        requestId: draft.requestId,
        error: sanitizedVoiceError(error),
      });
    });
  }, [
    activeWorkspaceId,
    requests,
    sendVoiceTranscript,
    settings.jarvis.voiceInput.autoSubmitTranscript,
    settingsOpen,
    voiceRequests,
    voiceSubmitStates,
  ]);

  // Barge-in is a VAD-only capture path. It is allowed while TTS is active,
  // but it never calls chat/task cancellation; startVoice owns only the
  // audio/TTS stop token and preserves the running turn.
  useEffect(() => {
    if (
      !activeWorkspaceId ||
      !settingsLoaded ||
      settingsOpen ||
      !settings.jarvis.enabled ||
      settings.jarvis.muted ||
      settings.jarvis.voiceInput.activationMode !== "vad" ||
      !settings.jarvis.voiceOutput.stopOnUserSpeech ||
      activeVoiceRequestId ||
      (ttsStatus.status !== "synthesizing" && ttsStatus.status !== "playing")
    ) {
      return;
    }

    const workspaceId = activeWorkspaceId;
    const timer = window.setTimeout(() => {
      const store = useJarvisStore.getState();
      const ttsBusy =
        store.ttsStatus.status === "synthesizing" ||
        store.ttsStatus.status === "playing";
      if (
        useWorkspaceStore.getState().activeWorkspaceId === workspaceId &&
        ttsBusy &&
        !store.activeVoiceRequestId &&
        store.settings.jarvis.enabled &&
        !store.settings.jarvis.muted &&
        store.settings.jarvis.voiceInput.activationMode === "vad" &&
        store.settings.jarvis.voiceOutput.stopOnUserSpeech
      ) {
        void startBargeIn();
      }
    }, AUTO_ARM_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [
    activeVoiceRequestId,
    activeWorkspaceId,
    settings.jarvis.enabled,
    settings.jarvis.muted,
    settings.jarvis.voiceInput.activationMode,
    settings.jarvis.voiceOutput.stopOnUserSpeech,
    settingsLoaded,
    settingsOpen,
    startBargeIn,
    ttsStatus.status,
  ]);

  // An armed VAD capture is only ambient readiness, so it follows workspace
  // focus. A capture that already heard speech keeps its original immutable
  // workspace binding and is allowed to finish before the new workspace arms.
  useEffect(() => {
    if (!activeVoiceRequestId) return;
    const activeRequest = Object.values(voiceRequests).find(
      (request) => request.requestId === activeVoiceRequestId,
    );
    if (
      activeRequest?.status !== "armed" ||
      activeRequest.workspaceId === activeWorkspaceId
    ) {
      return;
    }
    const requestId = activeVoiceRequestId;
    void useJarvisStore
      .getState()
      .cancelVoice()
      .then(() => {
        const store = useJarvisStore.getState();
        if (store.activeVoiceRequestId !== requestId) store.clearVoiceError();
      })
      .catch(() => undefined);
  }, [activeVoiceRequestId, activeWorkspaceId, voiceRequests]);

  // Hands-free mode: while unmuted, keep either a local wake-word capture or
  // the existing VAD capture armed in the focused workspace. If the local
  // engine is unavailable, fall back to VAD instead of opening a microphone
  // session that cannot ever trigger.
  useEffect(() => {
    if (!activeWorkspaceId || !settings.jarvis.enabled || settingsOpen) return;
    if (settings.jarvis.wakeWordEnabled && !wakeWordStatus) return;
    const wakeWordReady = settings.jarvis.wakeWordEnabled
      && wakeWordStatus?.enabled === true
      && wakeWordStatus.state !== "unavailable"
      && wakeWordStatus.state !== "error";
    const vadFallbackReady = !wakeWordReady
      && settings.jarvis.voiceInput.activationMode === "vad";
    if (
      !settingsLoaded ||
      voiceError ||
      !isJarvisOwnerModeReady(settings.jarvis) ||
      settings.jarvis.muted ||
      (!wakeWordReady && !vadFallbackReady) ||
      activeVoiceRequestId
    ) {
      return;
    }
    if (
      voiceRequest &&
      ["armed", "recording", "stopping", "transcribing", "transcript_ready"].includes(
        voiceRequest.status,
      )
    ) {
      // transcript_ready is still in the handoff window: the store is either
      // submitting it to chat or preserving it for an explicit retry. Never
      // start a second VAD capture over that draft.
      return;
    }
    const chatBusy = Object.values(requests).some(
      (request) =>
        request.workspaceId === activeWorkspaceId &&
        (request.status === "running" || request.status === "cancellation_requested"),
    );
    const ttsBusy = ttsStatus.status === "synthesizing" || ttsStatus.status === "playing";
    const bargeInReady = vadFallbackReady && settings.jarvis.voiceOutput.stopOnUserSpeech && ttsBusy;
    // During active TTS, VAD is intentionally allowed to arm for barge-in.
    // The backend cancels only the TTS token; chat/task cancellation remains
    // an explicit action. Wake-word capture keeps its existing gate.
    if ((chatBusy || ttsBusy) && !bargeInReady) return;

    const workspaceId = activeWorkspaceId;
    const timer = window.setTimeout(() => {
      const store = useJarvisStore.getState();
      // Reconcile a stale active request: if the backend already finished or
      // pruned the request but its terminal event was missed, clear the
      // latch so hands-free capture can arm again instead of staying blocked.
      const latchedRequestId = store.activeVoiceRequestId;
      if (latchedRequestId) {
        const latched = Object.values(store.voiceRequests).find(
          (request) => request.requestId === latchedRequestId,
        );
        if (
          !latched ||
          ["idle", "transcript_ready", "cancelled", "failed"].includes(
            latched.status,
          )
        ) {
          useJarvisStore.setState({ activeVoiceRequestId: null });
        }
      }
      if (
        !store.settingsLoaded ||
        store.voiceError ||
        !isJarvisOwnerModeReady(store.settings.jarvis) ||
        useWorkspaceStore.getState().activeWorkspaceId !== workspaceId ||
        !store.settings.jarvis.enabled ||
        store.settings.jarvis.muted ||
        (
          !(
            store.settings.jarvis.wakeWordEnabled
            && store.wakeWordStatus?.enabled === true
            && store.wakeWordStatus.state !== "unavailable"
            && store.wakeWordStatus.state !== "error"
          )
          && store.settings.jarvis.voiceInput.activationMode !== "vad"
        ) ||
        store.settingsOpen ||
        store.activeVoiceRequestId
      ) {
        return;
      }
      const liveChatBusy = Object.values(store.requests).some(
        (request) =>
          request.workspaceId === workspaceId &&
          (request.status === "running" ||
            request.status === "cancellation_requested"),
      );
      const liveTtsBusy =
        store.ttsStatus.status === "synthesizing" ||
        store.ttsStatus.status === "playing";
      const liveWakeWordReady = store.settings.jarvis.wakeWordEnabled
        && store.wakeWordStatus?.enabled === true
        && store.wakeWordStatus.state !== "unavailable"
        && store.wakeWordStatus.state !== "error";
      const liveVadFallbackReady = !liveWakeWordReady
        && store.settings.jarvis.voiceInput.activationMode === "vad";
      const liveBargeInReady = liveVadFallbackReady
        && store.settings.jarvis.voiceOutput.stopOnUserSpeech
        && liveTtsBusy;
      if (
        (!liveChatBusy && !liveTtsBusy && (liveWakeWordReady || liveVadFallbackReady)) ||
        (liveBargeInReady && !liveWakeWordReady)
      ) {
        console.info("[Jarvis voice] auto-arm after turn", { workspaceId });
        if (liveWakeWordReady) {
          void store.startVoice({ activationMode: "wake_word" });
        } else {
          void store.startVoice();
        }
      }
    }, AUTO_ARM_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [
    activeVoiceRequestId,
    activeWorkspaceId,
    requests,
    settings,
    settingsLoaded,
    settingsOpen,
    wakeWordStatus,
    settings.jarvis.wakeWordEnabled,
    ttsStatus.status,
    voiceError,
    voiceRequest?.requestId,
    voiceRequest?.status,
  ]);

  useEffect(() => {
    if (!settings.jarvis.enabled) return;
    void refreshRegistry();
    void refreshContext();
    const interval = window.setInterval(() => void refreshRegistry(), 5000);
    const unsubscribe = subscribeAgentTurnCompleted(() => void refreshRegistry());
    let disposed = false;
    let unlistenRegistry: (() => void) | undefined;
    void listen<{ workspaceId?: string }>(
      "jarvis://agent-registry-changed",
      (event) => {
        if (
          !disposed &&
          (!event.payload.workspaceId ||
            event.payload.workspaceId ===
              useWorkspaceStore.getState().activeWorkspaceId)
        ) {
          void refreshRegistry();
        }
      },
    ).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenRegistry = unlisten;
    });
    return () => {
      disposed = true;
      window.clearInterval(interval);
      unsubscribe();
      unlistenRegistry?.();
    };
  }, [
    activeWorkspaceId,
    refreshContext,
    refreshRegistry,
    settings.jarvis.enabled,
  ]);

  useEffect(() => {
    if (activeWorkspaceId) void refreshPendingActions();
  }, [activeWorkspaceId, refreshPendingActions]);

  useEffect(() => {
    const workspaceId = activeWorkspaceId;
    return () => {
      if (workspaceId) clearWorkspaceActivities(workspaceId);
    };
  }, [activeWorkspaceId, clearWorkspaceActivities]);

  useEffect(() => {
    if (settingsOpen || settings.jarvis.enabled) {
      void loadProviderStatus();
    }
  }, [loadProviderStatus, settings.jarvis.enabled, settingsOpen]);

  useEffect(() => {
    let disposed = false;
    const listeners = Promise.allSettled([
      listen<WakeWordStatusView>("jarvis://wake-state", (event) => {
        if (!disposed) setWakeWordStatus(event.payload);
      }),
      listen<VoiceRequestStatusView>("jarvis://voice-state", (event) => {
        if (disposed) return;
        console.info("[Jarvis voice] frontend state event", {
          requestId: event.payload.requestId,
          workspaceId: event.payload.workspaceId,
          status: event.payload.status,
          errorCode: event.payload.error?.code,
          transcriptChars: event.payload.transcript?.length ?? 0,
        });
        if (event.payload.status === "failed" && event.payload.error?.code) {
          reportFrontendDiagnosticCode(
            "jarvis-voice-error",
            event.payload.error.code,
            {
              requestId: event.payload.requestId,
              workspaceId: event.payload.workspaceId ?? undefined,
              state: "failed",
            },
          );
        }
        setVoiceRequest(event.payload);
      }),
      listen<VoiceLevelEvent>("jarvis://voice-level", (event) => {
        if (disposed) return;
        setVoiceLevel(event.payload);
      }),
      listen<TtsStatusView>("jarvis://tts-state", (event) => {
        if (disposed) return;
        console.info("[Jarvis TTS] frontend state event", {
          requestId: event.payload.requestId,
          workspaceId: event.payload.workspaceId,
          sequence: event.payload.sequence,
          status: event.payload.status,
          errorCode: event.payload.error?.code,
          errorMessage: event.payload.error?.message,
        });
        if (event.payload.status === "failed" && event.payload.error?.code) {
          reportFrontendDiagnosticCode(
            "jarvis-tts-error",
            event.payload.error.code,
            {
              requestId: event.payload.requestId,
              workspaceId: event.payload.workspaceId ?? undefined,
              state: "failed",
            },
          );
        }
        setTtsStatus(event.payload);
      }),
      listen<ActivityCheckpoint>("jarvis://activity", (event) => {
        if (!disposed) applyActivityEvents([event.payload]);
      }),
      listen<{ shortcut: string; state: "pressed" | "released" }>(
        "jarvis://voice-shortcut",
        (event) => {
          if (disposed) return;
          const store = useJarvisStore.getState();
          const currentSettings = store.settings.jarvis.voiceInput;
          if (
            !store.settings.jarvis.enabled ||
            !currentSettings.globalShortcutEnabled
          ) {
            shortcutPressedRef.current = null;
            return;
          }

          if (
            currentSettings.activationMode === "vad" &&
            currentSettings.shortcutBehavior === "toggle"
          ) {
            if (event.payload.state === "pressed") {
              void toggleMicrophoneMuted();
            }
            shortcutPressedRef.current = null;
            return;
          }

          const activeRequestId = store.activeVoiceRequestId;
          const current = activeRequestId
            ? Object.values(store.voiceRequests).find(
                (request) => request.requestId === activeRequestId,
              )
            : undefined;

          if (event.payload.state === "pressed") {
            const press = beginVoicePress(
              shortcutPressedRef.current,
              ++shortcutGenerationRef.current,
            );
            if (!press) return;
            shortcutPressedRef.current = press;
            if (currentSettings.shortcutBehavior === "hold") {
              if (
                !current ||
                !["recording", "armed", "transcribing", "stopping"].includes(
                  current.status,
                )
              ) {
                void startBargeIn(currentSettings.activationMode);
              }
            } else if (
              current?.status === "recording" ||
              current?.status === "armed"
            ) {
              void stopVoice();
            } else if (
              !current ||
              !["transcribing", "stopping"].includes(current.status)
            ) {
              void startBargeIn(currentSettings.activationMode);
            }
          } else {
            const press = releaseVoicePress(shortcutPressedRef.current);
            shortcutPressedRef.current = null;
            if (press && currentSettings.shortcutBehavior === "hold") {
              void stopVoice();
            }
          }
        },
      ),
    ]).then((results) => {
      const active: Array<() => void> = [];
      for (const result of results) {
        if (result.status === "fulfilled") {
          active.push(result.value);
        } else {
          reportFrontendDiagnostic("jarvis-listener-error", result.reason, {
            state: "voice-events",
          });
          console.error("[Jarvis voice] event listener setup failed", result.reason);
        }
      }
      return active;
    });

    return () => {
      disposed = true;
      void listeners
        .then((unlisteners) => unlisteners.forEach((unlisten) => unlisten()))
        .catch(() => undefined);
    };
  }, [
    applyActivityEvents,
    setTtsStatus,
    setWakeWordStatus,
    setVoiceLevel,
    setVoiceRequest,
    startBargeIn,
    startVoice,
    stopVoice,
    toggleMicrophoneMuted,
  ]);

  useEffect(() => {
    const releaseHeldVoice = () => {
      const currentSettings =
        useJarvisStore.getState().settings.jarvis.voiceInput;
      const press = releaseVoicePress(shortcutPressedRef.current);
      shortcutPressedRef.current = null;
      if (press && currentSettings.shortcutBehavior === "hold") {
        void stopVoice();
      }
    };
    window.addEventListener("blur", releaseHeldVoice);
    document.addEventListener("visibilitychange", releaseHeldVoice);
    return () => {
      window.removeEventListener("blur", releaseHeldVoice);
      document.removeEventListener("visibilitychange", releaseHeldVoice);
    };
  }, [stopVoice]);

  if (!settings.jarvis.enabled) return null;

  return (
    <>
      <JarvisWidget
        workspaceId={activeWorkspaceId}
        workspaceName={activeWorkspaceName}
        pendingActions={pendingActions}
        requests={requests}
        chatError={chatError}
        voiceError={voiceError}
        muted={settings.jarvis.muted}
        wakeWordStatus={wakeWordStatus}
        voiceRequest={voiceRequest}
        voiceSubmitState={voiceRequest ? voiceSubmitStates[voiceRequest.requestId] : undefined}
        bargeIn={bargeInRequestId === voiceRequest?.requestId}
        activationMode={settings.jarvis.voiceInput.activationMode}
        ttsStatus={ttsStatus}
        activities={activities}
        onOpenSettings={() => setSettingsOpen(true)}
        onHide={() => void useJarvisStore.getState().hideJarvis()}
        onToggleMuted={() => toggleMicrophoneMuted()}
        onVoiceStart={() => startVoice()}
        onVoiceStop={() => void stopVoice()}
        onVoiceSend={() => {
          if (voiceRequest?.transcript?.trim()) {
            void sendVoiceTranscript(voiceRequest.requestId, voiceRequest.transcript);
          }
        }}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        advanced={{
          context,
          contextStatus,
          contextError,
          sessions: registrySessions,
          isRefreshing,
          onRefresh: () => void refreshRegistry(),
          onRefreshContext: () => void refreshContext(),
        }}
      />
    </>
  );
}
