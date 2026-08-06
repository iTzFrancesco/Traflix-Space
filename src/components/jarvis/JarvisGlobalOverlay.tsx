import { useCallback, useEffect, useMemo, useRef } from "react";
import { subscribeAgentTurnCompleted } from "../../lib/terminalEvents";
import {
  agentList,
  agentSnapshot,
  buildModelContext,
} from "../../lib/jarvis/client";
import { SettingsModal } from "../layout/SettingsModal";
import { useJarvisStore } from "../../stores/jarvisStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { JarvisWidget } from "./JarvisWidget";
import type { AgentSessionContext } from "../../lib/jarvis/types";

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
  const setContext = useJarvisStore((state) => state.setContext);
  const setContextStatus = useJarvisStore((state) => state.setContextStatus);
  const setRegistrySessions = useJarvisStore((state) => state.setRegistrySessions);
  const setRefreshing = useJarvisStore((state) => state.setRefreshing);
  const setResult = useJarvisStore((state) => state.setResult);
  const setSelectedAgentSessionId = useJarvisStore((state) => state.setSelectedAgentSessionId);
  const setSettingsOpen = useJarvisStore((state) => state.setSettingsOpen);
  const setRegistryRefreshTimestamp = useJarvisStore((state) => state.setRegistryRefreshTimestamp);
  const otherWorkspaceAgentCount = useJarvisStore((state) => state.otherWorkspaceAgentCount);
  const loadSettings = useJarvisStore((state) => state.loadSettings);
  const loadLastResult = useJarvisStore((state) => state.loadLastResult);
  const registryRequestRef = useRef(0);
  const sessions = registrySessions;
  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId);

  const refreshRegistry = useCallback(async (targetWorkspaceId: string | null = useWorkspaceStore.getState().activeWorkspaceId) => {
    if (!targetWorkspaceId) {
      setRegistrySessions([]);
      return;
    }
    const requestNumber = ++registryRequestRef.current;
    setRefreshing(true);
    try {
      const snapshot = await agentSnapshot(targetWorkspaceId);
      if (requestNumber !== registryRequestRef.current) return;
      if (useWorkspaceStore.getState().activeWorkspaceId !== targetWorkspaceId) return;
      setRegistrySessions(snapshot.data);
      setRegistryRefreshTimestamp(new Date().toISOString());
    } catch (error) {
      console.warn("[jarvis] agent registry refresh failed", error);
    } finally {
      if (requestNumber === registryRequestRef.current) setRefreshing(false);
    }
  }, [setRegistryRefreshTimestamp, setRefreshing, setRegistrySessions]);

  const refreshContext = useCallback(async () => {
    const targetWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!targetWorkspaceId) return;
    setContextStatus("loading");
    try {
      const modelContext = await buildModelContext("summary");
      if (useWorkspaceStore.getState().activeWorkspaceId !== targetWorkspaceId) return;
      setContext(modelContext, "ready");
    } catch (error) {
      if (useWorkspaceStore.getState().activeWorkspaceId !== targetWorkspaceId) return;
      setContext(null, "unavailable", error instanceof Error ? error.message : String(error));
    }
  }, [setContext, setContextStatus]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshRegistry(), refreshContext()]);
  }, [refreshContext, refreshRegistry]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (!settings.jarvis.enabled) return;
    void refreshContext();
    void refreshRegistry();
    const interval = window.setInterval(() => void refreshRegistry(), 5000);
    const unsubscribe = subscribeAgentTurnCompleted(() => void refreshRegistry());
    return () => {
      window.clearInterval(interval);
      unsubscribe();
    };
  }, [activeWorkspaceId, refreshContext, refreshRegistry, settings.jarvis.enabled]);

  useOtherWorkspaceAgentCount(activeWorkspaceId, workspaces.map((item) => item.id));

  const handleSelectSession = (session: AgentSessionContext) => {
    setSelectedAgentSessionId(session.ref.agentSessionId);
    setResult(session.ref.agentSessionId, session.lastResult ?? null);
    if (activeWorkspaceId && session.ref.agentSessionId) {
      void loadLastResult(activeWorkspaceId, session.ref.agentSessionId);
    }
  };

  const handleOpenTerminal = (session: AgentSessionContext) => {
    if (!session.ref.terminalId) return;
    if (session.ref.workspaceId !== useWorkspaceStore.getState().activeWorkspaceId) {
      setActiveWorkspace(session.ref.workspaceId);
    }
    setActiveTerminal(session.ref.terminalId);
  };

  if (!settings.jarvis.enabled) {
    return null;
  }

  return (
    <>
      <JarvisWidget
        workspaceId={activeWorkspaceId}
        workspaceName={workspace?.name ?? null}
        workspaceRoot={workspace?.rootPath ?? null}
        context={context}
        contextStatus={contextStatus}
        contextError={contextError}
        sessions={sessions}
        isRefreshing={isRefreshing}
        otherWorkspaceAgentCount={otherWorkspaceAgentCount}
        onRefresh={() => void refresh()}
        onSelectSession={handleSelectSession}
        onOpenTerminal={handleOpenTerminal}
        onOpenSettings={() => setSettingsOpen(true)}
        onHide={() => void useJarvisStore.getState().hideJarvis()}
      />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}

function useOtherWorkspaceAgentCount(
  activeWorkspaceId: string | null,
  workspaceIds: string[],
): void {
  const setOtherWorkspaceAgentCount = useJarvisStore((state) => state.setOtherWorkspaceAgentCount);
  const otherIds = useMemo(
    () => workspaceIds.filter((workspaceId) => workspaceId !== activeWorkspaceId),
    [activeWorkspaceId, workspaceIds.join("|")],
  );
  useEffect(() => {
    let cancelled = false;
    if (otherIds.length === 0) {
      setOtherWorkspaceAgentCount(0);
      return;
    }
    void Promise.all(otherIds.map((workspaceId) => agentList(workspaceId).catch(() => ({ data: [], provenance: { source: "jarvis", observedAt: new Date().toISOString(), confidence: 0, untrusted: false }, warnings: [] })))).then((results) => {
      if (cancelled) return;
      const total = results.reduce((sum, result) => sum + result.data.length, 0);
      setOtherWorkspaceAgentCount(total);
    });
    return () => {
      cancelled = true;
    };
  }, [otherIds, setOtherWorkspaceAgentCount]);
}
