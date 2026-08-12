import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { subscribeAgentTurnCompleted } from "../../lib/terminalEvents";
import { agentSnapshot, buildModelContext, ttsSpeak } from "../../lib/jarvis/client";
import type {
  TtsStatusView,
  VoiceLevelEvent,
  VoiceRequestStatusView,
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
  const activeVoiceRequestId = useJarvisStore(
    (state) => state.activeVoiceRequestId,
  );
  const voiceRequest = activeWorkspaceId
    ? voiceRequests[activeWorkspaceId] ?? null
    : null;
  const activities = useJarvisStore((state) => state.activities);
  const ttsStatus = useJarvisStore((state) => state.ttsStatus);
  const voiceError = useJarvisStore((state) => state.voiceError);
  const codexSpeechQueue = useJarvisStore((state) => state.codexSpeechQueue);
  const dequeueCodexSpeech = useJarvisStore((state) => state.dequeueCodexSpeech);
  const clearCodexSpeech = useJarvisStore((state) => state.clearCodexSpeech);
  const speechWorkerBusyRef = useRef(false);
  const loadSettings = useJarvisStore((state) => state.loadSettings);
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
  const loadVoiceDraft = useJarvisStore((state) => state.loadVoiceDraft);
  const setVoiceRequest = useJarvisStore((state) => state.setVoiceRequest);
  const applyActivityEvents = useJarvisStore((state) => state.applyActivityEvents);
  const clearWorkspaceActivities = useJarvisStore(
    (state) => state.clearWorkspaceActivities,
  );
  const setVoiceLevel = useJarvisStore((state) => state.setVoiceLevel);
  const setTtsStatus = useJarvisStore((state) => state.setTtsStatus);
  const shortcutPressedRef = useRef<VoicePress | null>(null);
  const shortcutGenerationRef = useRef(0);
  const registryRequestRef = useRef(0);
  const resumeVoiceDraftRef = useRef<Set<string>>(new Set());
  const settingsRecoveryDraftRef = useRef<Set<string>>(new Set());
  const settingsWasOpenRef = useRef(settingsOpen);
  const chatError = activeWorkspaceId
    ? chatErrors[activeWorkspaceId] ?? null
    : null;

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
        useJarvisStore.getState().setTtsStatus(status);
      })
      .catch((error) => {
        const errorView = sanitizedVoiceErrorView(error, "tts_ipc_failed");
        console.warn("[Jarvis TTS] commentary failed", {
          itemId: item.itemId,
          turnId: item.turnId,
          requestId,
          errorCode: errorView.code,
        });
      })
      .finally(() => {
        speechWorkerBusyRef.current = false;
        useJarvisStore.getState().dequeueCodexSpeech(item.itemId);
      });
  }, [codexSpeechQueue, dequeueCodexSpeech, ttsStatus.status]);

  // C8 barge-in: the moment the user starts speaking, drop pending
  // commentary speech (the existing voice pipeline stops the active TTS).
  useEffect(() => {
    if (voiceRequest?.status === "recording") {
      const queued = useJarvisStore.getState().codexSpeechQueue;
      if (queued.length > 0) {
        console.info("[Jarvis TTS] queue cleared by barge-in", {
          droppedItems: queued.length,
          itemIds: queued.map((entry) => entry.itemId),
        });
      }
      clearCodexSpeech();
    }
  }, [clearCodexSpeech, voiceRequest?.status]);

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
    void useJarvisStore.getState().loadCodexRuntime();
    return unlisten;
  }, []);

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

  // Hands-free mode: while unmuted, keep a VAD capture armed in the focused
  // workspace. Armed is intentionally visually neutral; only actual detected
  // speech changes the request to Recording and turns the widget green.
  useEffect(() => {
    if (!activeWorkspaceId || !settings.jarvis.enabled || settingsOpen) return;
    if (
      !settingsLoaded ||
      voiceError ||
      !isJarvisOwnerModeReady(settings.jarvis) ||
      settings.jarvis.muted ||
      settings.jarvis.voiceInput.activationMode !== "vad" ||
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
    // Do not arm the microphone while Jarvis is generating or playing a reply.
    // Otherwise VAD can capture Jarvis's own voice, submit a phantom transcript,
    // and start a second turn before the first one is visibly finished.
    if (chatBusy || ttsBusy) return;

    const workspaceId = activeWorkspaceId;
    const timer = window.setTimeout(() => {
      const store = useJarvisStore.getState();
      if (
        !store.settingsLoaded ||
        store.voiceError ||
        !isJarvisOwnerModeReady(store.settings.jarvis) ||
        useWorkspaceStore.getState().activeWorkspaceId !== workspaceId ||
        !store.settings.jarvis.enabled ||
        store.settings.jarvis.muted ||
        store.settings.jarvis.voiceInput.activationMode !== "vad" ||
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
      if (!liveChatBusy && !liveTtsBusy) {
        console.info("[Jarvis voice] auto-arm after turn", { workspaceId });
        void store.startVoice();
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
                void startVoice({ interruptTts: true });
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
              void startVoice({ interruptTts: true });
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
    setVoiceLevel,
    setVoiceRequest,
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
        voiceRequest={voiceRequest}
        activationMode={settings.jarvis.voiceInput.activationMode}
        ttsStatus={ttsStatus}
        activities={activities}
        onOpenSettings={() => setSettingsOpen(true)}
        onHide={() => void useJarvisStore.getState().hideJarvis()}
        onToggleMuted={() => toggleMicrophoneMuted()}
        onVoiceStart={() => startVoice()}
        onVoiceStop={() => void stopVoice()}
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
