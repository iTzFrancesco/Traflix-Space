import { useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { subscribeAgentTurnCompleted } from "../../lib/terminalEvents";
import { agentSnapshot, buildModelContext } from "../../lib/jarvis/client";
import type {
  TtsStatusView,
  VoiceLevelEvent,
  VoiceRequestStatusView,
} from "../../lib/jarvis/types";
import type { ActivityCheckpoint } from "../../lib/jarvis/activityState";
import { SettingsModal } from "../layout/SettingsModal";
import { useJarvisStore } from "../../stores/jarvisStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
  beginVoicePress,
  releaseVoicePress,
  type VoicePress,
} from "../../lib/jarvis/voiceActivation";
import { isJarvisOwnerModeReady } from "../../lib/jarvis/settings";
import { JarvisWidget } from "./JarvisWidget";

const AUTO_ARM_DELAY_MS = 180;

export function JarvisGlobalOverlay() {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
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
      return;
    }
    const chatBusy = Object.values(requests).some(
      (request) =>
        request.workspaceId === activeWorkspaceId &&
        (request.status === "running" || request.status === "cancellation_requested"),
    );
    // Keep the microphone armed while Jarvis speaks so VAD can detect a real
    // user interruption. TTS is stopped only after the request transitions to
    // `recording`, not merely when it is armed.
    if (chatBusy) return;

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
      if (!liveChatBusy) void store.startVoice();
    }, AUTO_ARM_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [
    activeVoiceRequestId,
    activeWorkspaceId,
    requests,
    settings,
    settingsLoaded,
    settingsOpen,
    voiceError,
    voiceRequest?.requestId,
    voiceRequest?.status,
  ]);

  useEffect(() => {
    if (!settings.jarvis.enabled) return;
    void refreshRegistry();
    if (settings.jarvis.advancedViewEnabled) void refreshContext();
    const interval = window.setInterval(() => void refreshRegistry(), 5000);
    const unsubscribe = subscribeAgentTurnCompleted(() => void refreshRegistry());
    return () => {
      window.clearInterval(interval);
      unsubscribe();
    };
  }, [
    activeWorkspaceId,
    refreshContext,
    refreshRegistry,
    settings.jarvis.advancedViewEnabled,
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
    if (settingsOpen || settings.jarvis.advancedViewEnabled) {
      void loadProviderStatus();
    }
  }, [
    loadProviderStatus,
    settings.jarvis.advancedViewEnabled,
    settingsOpen,
  ]);

  useEffect(() => {
    let disposed = false;
    const listeners = Promise.all([
      listen<VoiceRequestStatusView>("jarvis://voice-state", (event) => {
        if (!disposed) setVoiceRequest(event.payload);
      }),
      listen<VoiceLevelEvent>("jarvis://voice-level", (event) => {
        if (!disposed) setVoiceLevel(event.payload);
      }),
      listen<TtsStatusView>("jarvis://tts-state", (event) => {
        if (!disposed) setTtsStatus(event.payload);
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
    ]);

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
