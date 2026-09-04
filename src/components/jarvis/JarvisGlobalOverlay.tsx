import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { subscribeAgentTurnCompleted } from "../../lib/terminalEvents";
import {
  agentSnapshot,
  buildModelContext,
  ttsSpeak,
  voiceWorkspaceStatus,
} from "../../lib/jarvis/client";
import { SettingsModal } from "../layout/SettingsModal";
import { useJarvisStore, bindCodexEvents } from "../../stores/jarvisStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
  sanitizedVoiceError,
  sanitizedVoiceErrorView,
} from "../../lib/jarvis/voiceSettings";
import { hasPendingVoiceHandoff } from "../../lib/jarvis/voiceState";
import { speechItemKey } from "../../lib/jarvis/ttsState";
import { JarvisWidget } from "./JarvisWidget";
import { useJarvisEventBindings } from "./useJarvisEventBindings";

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
  const voiceHandoffPending = hasPendingVoiceHandoff(voiceRequests, voiceSubmitStates);
  const activeVoiceRequestId = useJarvisStore(
    (state) => state.activeVoiceRequestId,
  );
  const activeVoiceRequest = activeVoiceRequestId
    ? Object.values(voiceRequests).find(
        (request) => request.requestId === activeVoiceRequestId,
      ) ?? null
    : null;
  // Capture/STT ownership is global; after a workspace switch keep the live
  // request visible so the user can stop it, while its immutable workspaceId
  // continues to determine where the transcript is handed off.
  const voiceRequest = activeVoiceRequest ?? (activeWorkspaceId
    ? voiceRequests[activeWorkspaceId] ?? null
    : null);
  const activities = useJarvisStore((state) => state.activities);
  const ttsStatus = useJarvisStore((state) => state.ttsStatus);
  const voiceError = useJarvisStore((state) => state.voiceError);
  const codexSpeechQueue = useJarvisStore((state) => state.codexSpeechQueue);
  const dequeueCodexSpeech = useJarvisStore((state) => state.dequeueCodexSpeech);
  const speechWorkerBusyRef = useRef(false);
  const speechRetryCountsRef = useRef<Map<string, number>>(new Map());
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
  const loadVoiceDraft = useJarvisStore((state) => state.loadVoiceDraft);
  const setVoiceRequest = useJarvisStore((state) => state.setVoiceRequest);
  const applyActivityEvents = useJarvisStore((state) => state.applyActivityEvents);
  const clearWorkspaceActivities = useJarvisStore(
    (state) => state.clearWorkspaceActivities,
  );
  const setVoiceLevel = useJarvisStore((state) => state.setVoiceLevel);
  const setWakeWordStatus = useJarvisStore((state) => state.setWakeWordStatus);
  const clearVoiceError = useJarvisStore((state) => state.clearVoiceError);
  const setTtsStatus = useJarvisStore((state) => state.setTtsStatus);
  const registryRequestRef = useRef(0);
  const chatError = activeWorkspaceId
    ? chatErrors[activeWorkspaceId] ?? null
    : null;

  useEffect(() => {
    // Voice errors are diagnostic UI state, not a global lock.
    if (activeWorkspaceId) clearVoiceError();
  }, [activeWorkspaceId, clearVoiceError]);

  const toggleVoice = useCallback(async () => {
    const store = useJarvisStore.getState();
    const active = store.activeVoiceRequestId
      ? Object.values(store.voiceRequests).find(
          (request) => request.requestId === store.activeVoiceRequestId,
        )
      : null;
    if (active && ["armed", "recording"].includes(active.status)) {
      const stopped = await store.stopVoice();
      if (stopped?.status === "transcript_ready" && stopped.transcript?.trim()) {
        await store.sendVoiceTranscript(stopped.requestId, stopped.transcript);
      }
      return;
    }
    // The start request can be in flight before its first state event reaches
    // the store. A second orb click still means stop, never a second start.
    if (!active && store.activeVoiceRequestId) {
      await store.stopVoice();
      return;
    }
    if (store.voiceStopRequested) return;
    if (store.settings.jarvis.muted) {
      await store.toggleMuted();
    }
    if (active?.status === "transcript_ready" && active.transcript?.trim()) {
      await store.sendVoiceTranscript(active.requestId, active.transcript);
      return;
    }
    if (active && ["stopping", "transcribing"].includes(active.status)) {
      return;
    }
    await store.startVoice({ activationMode: "click_toggle", forceEndpointing: false });
  }, []);

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
  // speaks over the final reply and waits while a manual voice turn owns audio.
  useEffect(() => {
    if (speechWorkerBusyRef.current) return;
    const item = codexSpeechQueue[0];
    if (!item) return;
    // The active request id is cleared at transcript_ready, but the draft or
    // submission still owns the audio channel until the handoff is accepted.
    if (voiceHandoffPending) return;
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
    const speechKey = speechItemKey(item);
    const requestId = `tts-codex-${speechKey}`;
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
        speechRetryCountsRef.current.delete(speechKey);
        useJarvisStore.getState().setTtsStatus(status);
        useJarvisStore.getState().dequeueCodexSpeech(item);
      })
      .catch((error) => {
        const errorView = sanitizedVoiceErrorView(error, "tts_ipc_failed");
        const attempts = (speechRetryCountsRef.current.get(speechKey) ?? 0) + 1;
        speechRetryCountsRef.current.set(speechKey, attempts);
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
          speechRetryCountsRef.current.delete(speechKey);
          useJarvisStore.getState().dequeueCodexSpeech(item);
          return;
        }
        // Keep the failed item at the head of the FIFO. A fresh array reference
        // wakes this effect after a short backoff without losing its text or
        // allowing later steps to overtake it.
        const retryDelayMs = Math.min(2_000, 250 * 2 ** (attempts - 1));
        window.setTimeout(() => {
          const currentQueue = useJarvisStore.getState().codexSpeechQueue;
          if (!currentQueue[0] || speechItemKey(currentQueue[0]) !== speechKey) return;
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
    voiceHandoffPending,
    ttsStatus.status,
  ]);

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

  useEffect(() => {
    if (!activeWorkspaceId || !settings.jarvis.enabled) return;
    void loadVoiceDraft(activeWorkspaceId);
  }, [activeWorkspaceId, loadVoiceDraft, settings.jarvis.enabled]);

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

  useJarvisEventBindings({
    applyActivityEvents,
    setTtsStatus,
    setWakeWordStatus,
    setVoiceLevel,
    setVoiceRequest,
  });

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
        voiceRequest={voiceRequest}
        voiceSubmitState={voiceRequest ? voiceSubmitStates[voiceRequest.requestId] : undefined}
        ttsStatus={ttsStatus}
        activities={activities}
        onOpenSettings={() => setSettingsOpen(true)}
        onHide={() => void useJarvisStore.getState().hideJarvis()}
        onVoiceToggle={toggleVoice}
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
