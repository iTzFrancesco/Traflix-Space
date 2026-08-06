import { useCallback, useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { subscribeAgentTurnCompleted } from "../../lib/terminalEvents";
import { agentSnapshot, buildModelContext, terminalList } from "../../lib/jarvis/client";
import type { TtsStatusView, VoiceLevelEvent, VoiceRequestStatusView } from "../../lib/jarvis/types";
import { SettingsModal } from "../layout/SettingsModal";
import { useJarvisStore } from "../../stores/jarvisStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { JarvisWidget } from "./JarvisWidget";

export function JarvisGlobalOverlay() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace);
  const setActiveTerminal = useTerminalStore((state) => state.setActiveTerminal);
  const settings = useJarvisStore((state) => state.settings);
  const settingsOpen = useJarvisStore((state) => state.settingsOpen);
  const context = useJarvisStore((state) => state.context);
  const contextStatus = useJarvisStore((state) => state.contextStatus);
  const contextError = useJarvisStore((state) => state.contextError);
  const registrySessions = useJarvisStore((state) => state.registrySessions);
  const isRefreshing = useJarvisStore((state) => state.isRefreshing);
  const conversation = useJarvisStore((state) => state.conversation);
  const pendingActions = useJarvisStore((state) => state.pendingActions);
  const requests = useJarvisStore((state) => state.requests);
  const chatErrors = useJarvisStore((state) => state.chatErrors);
  const providerStatus = useJarvisStore((state) => state.providerStatus);
  const uiIntents = useJarvisStore((state) => state.uiIntents);
  const followUps = useJarvisStore((state) => state.followUps);
  const voiceRequest = useJarvisStore((state) => state.voiceRequest);
  const ttsStatus = useJarvisStore((state) => state.ttsStatus);
  const loadSettings = useJarvisStore((state) => state.loadSettings);
  const loadConversation = useJarvisStore((state) => state.loadConversation);
  const setContext = useJarvisStore((state) => state.setContext);
  const setContextStatus = useJarvisStore((state) => state.setContextStatus);
  const setRegistrySessions = useJarvisStore((state) => state.setRegistrySessions);
  const setRefreshing = useJarvisStore((state) => state.setRefreshing);
  const setRegistryRefreshTimestamp = useJarvisStore((state) => state.setRegistryRefreshTimestamp);
  const sendMessage = useJarvisStore((state) => state.sendMessage);
  const cancelChatRequest = useJarvisStore((state) => state.cancelChatRequest);
  const confirmPendingAction = useJarvisStore((state) => state.confirmPendingAction);
  const rejectPendingAction = useJarvisStore((state) => state.rejectPendingAction);
  const updatePendingAction = useJarvisStore((state) => state.updatePendingAction);
  const refreshPendingActions = useJarvisStore((state) => state.refreshPendingActions);
  const loadProviderStatus = useJarvisStore((state) => state.loadProviderStatus);
  const setSettingsOpen = useJarvisStore((state) => state.setSettingsOpen);
  const startVoice = useJarvisStore((state) => state.startVoice);
  const stopVoice = useJarvisStore((state) => state.stopVoice);
  const cancelVoice = useJarvisStore((state) => state.cancelVoice);
  const discardVoiceTranscript = useJarvisStore((state) => state.discardVoiceTranscript);
  const setVoiceRequest = useJarvisStore((state) => state.setVoiceRequest);
  const setVoiceLevel = useJarvisStore((state) => state.setVoiceLevel);
  const setTtsStatus = useJarvisStore((state) => state.setTtsStatus);
  const stopTts = useJarvisStore((state) => state.stopTts);
  const registryRequestRef = useRef(0);
  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId);
  const conversationForWorkspace = useMemo(() => conversation.filter((message) => message.workspaceId === activeWorkspaceId), [activeWorkspaceId, conversation]);
  const chatError = activeWorkspaceId ? chatErrors[activeWorkspaceId] ?? null : null;

  const refreshRegistry = useCallback(async (targetWorkspaceId: string | null = useWorkspaceStore.getState().activeWorkspaceId) => {
    if (!targetWorkspaceId) return;
    const requestNumber = ++registryRequestRef.current;
    setRefreshing(true);
    try {
      const snapshot = await agentSnapshot(targetWorkspaceId);
      if (requestNumber !== registryRequestRef.current || useWorkspaceStore.getState().activeWorkspaceId !== targetWorkspaceId) return;
      setRegistrySessions(snapshot.data); setRegistryRefreshTimestamp(new Date().toISOString());
    } catch { /* preserve last valid registry snapshot */ }
    finally { if (requestNumber === registryRequestRef.current) setRefreshing(false); }
  }, [setRefreshing, setRegistryRefreshTimestamp, setRegistrySessions]);

  const refreshContext = useCallback(async () => {
    const target = useWorkspaceStore.getState().activeWorkspaceId; if (!target) return;
    setContextStatus("loading");
    try { const result = await buildModelContext("summary"); if (useWorkspaceStore.getState().activeWorkspaceId !== target) return; setContext(result, "ready"); }
    catch (error) { if (useWorkspaceStore.getState().activeWorkspaceId === target) setContext(null, "unavailable", error instanceof Error ? error.message : String(error)); }
  }, [setContext, setContextStatus]);

  useEffect(() => { void loadSettings(); }, [loadSettings]);
  useEffect(() => { if (activeWorkspaceId) void loadConversation(activeWorkspaceId); }, [activeWorkspaceId, loadConversation]);
  useEffect(() => {
    if (!settings.jarvis.enabled) return;
    void refreshRegistry();
    if (settings.jarvis.advancedViewEnabled) void refreshContext();
    const interval = window.setInterval(() => void refreshRegistry(), 5000);
    const unsubscribe = subscribeAgentTurnCompleted(() => void refreshRegistry());
    return () => { window.clearInterval(interval); unsubscribe(); };
  }, [activeWorkspaceId, refreshContext, refreshRegistry, settings.jarvis.advancedViewEnabled, settings.jarvis.enabled]);
  useEffect(() => { if (activeWorkspaceId) void refreshPendingActions(); }, [activeWorkspaceId, refreshPendingActions]);
  useEffect(() => { if (settingsOpen || settings.jarvis.advancedViewEnabled) void loadProviderStatus(); }, [loadProviderStatus, settings.jarvis.advancedViewEnabled, settingsOpen]);
  useEffect(() => {
    let disposed = false;
    const listeners = Promise.all([
      listen<VoiceRequestStatusView>("jarvis://voice-state", (event) => { if (!disposed) setVoiceRequest(event.payload); }),
      listen<VoiceLevelEvent>("jarvis://voice-level", (event) => { if (!disposed) setVoiceLevel(event.payload); }),
      listen<TtsStatusView>("jarvis://tts-state", (event) => { if (!disposed) setTtsStatus(event.payload); }),
    ]);
    return () => { disposed = true; void listeners.then((unlisteners) => unlisteners.forEach((unlisten) => unlisten())).catch(() => undefined); };
  }, [setTtsStatus, setVoiceLevel, setVoiceRequest]);

  const handleOpenTerminal = async (workspaceId: string, terminalId: string, generation: number) => {
    try {
      const result = await terminalList(workspaceId);
      const terminal = result.data.find((item) => item.terminalId === terminalId);
      if (!terminal || terminal.workspaceId !== workspaceId || terminal.generation !== generation || !terminal.processAlive) return;
      if (workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) setActiveWorkspace(workspaceId);
      setActiveTerminal(terminalId);
    } catch { /* stale UI intent is ignored */ }
  };

  if (!settings.jarvis.enabled) return null;
  return <>
    <JarvisWidget workspaceId={activeWorkspaceId} workspaceName={workspace?.name ?? null} conversation={conversationForWorkspace} pendingActions={pendingActions} requests={requests} chatError={chatError} providerStatus={providerStatus} uiIntents={uiIntents} followUps={activeWorkspaceId ? followUps[activeWorkspaceId] ?? [] : []} voiceRequest={voiceRequest} ttsStatus={ttsStatus} onOpenSettings={() => setSettingsOpen(true)} onHide={() => void useJarvisStore.getState().hideJarvis()} onSendMessage={(message) => void sendMessage(message)} onCancelRequest={(requestId) => void cancelChatRequest(requestId)} onConfirmAction={(action) => void confirmPendingAction(action)} onRejectAction={(action) => void rejectPendingAction(action)} onUpdateAction={(action, text) => updatePendingAction(action, text)} onOpenTerminal={handleOpenTerminal} onVoiceStart={() => void startVoice()} onVoiceStop={() => void stopVoice()} onVoiceCancel={() => void cancelVoice()} onVoiceDiscard={() => void discardVoiceTranscript()} onStopTts={() => void stopTts()} />
    <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} advanced={{ context, contextStatus, contextError, sessions: registrySessions, isRefreshing, onRefresh: () => void refreshRegistry(), onRefreshContext: () => void refreshContext() }} />
  </>;
}
