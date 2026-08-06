import { useCallback, useEffect, useMemo } from "react";
import { subscribeAgentTurnCompleted } from "../../lib/terminalEvents";
import {
  agentList,
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
  const selectedAgentSessionId = useJarvisStore((state) => state.selectedAgentSessionId);
  const setContext = useJarvisStore((state) => state.setContext);
  const clearResult = useJarvisStore((state) => state.clearResult);
  const setSelectedAgentSessionId = useJarvisStore((state) => state.setSelectedAgentSessionId);
  const setSettingsOpen = useJarvisStore((state) => state.setSettingsOpen);
  const setRegistryRefreshTimestamp = useJarvisStore((state) => state.setRegistryRefreshTimestamp);
  const otherWorkspaceAgentCount = useJarvisStore((state) => state.otherWorkspaceAgentCount);
  const loadSettings = useJarvisStore((state) => state.loadSettings);
  const loadLastResult = useJarvisStore((state) => state.loadLastResult);
  const sessions = context?.agentSessions ?? [];
  const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId);

  const refresh = useCallback(async () => {
    const targetWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!targetWorkspaceId) {
      setContext(null, "ready");
      return;
    }

    setContext(null, "loading");
    const requestStartedAt = new Date().toISOString();
    try {
      const modelContext = await buildModelContext("summary");
      if (useWorkspaceStore.getState().activeWorkspaceId !== targetWorkspaceId) return;
      setContext(modelContext, "ready");
      setRegistryRefreshTimestamp(requestStartedAt);
    } catch (error) {
      if (useWorkspaceStore.getState().activeWorkspaceId !== targetWorkspaceId) return;
      setContext(null, "unavailable", error instanceof Error ? error.message : String(error));
      setRegistryRefreshTimestamp(requestStartedAt);
    }
  }, [setContext, setRegistryRefreshTimestamp]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (!settings.jarvis.enabled) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    const unsubscribe = subscribeAgentTurnCompleted(() => void refresh());
    return () => {
      window.clearInterval(interval);
      unsubscribe();
    };
  }, [activeWorkspaceId, refresh, settings.jarvis.enabled]);

  useEffect(() => {
    if (
      selectedAgentSessionId &&
      !sessions.some((session) => session.ref.agentSessionId === selectedAgentSessionId)
    ) {
      setSelectedAgentSessionId(null);
      clearResult();
    }
  }, [clearResult, selectedAgentSessionId, sessions, setSelectedAgentSessionId]);

  useOtherWorkspaceAgentCount(activeWorkspaceId, workspaces.map((item) => item.id));

  const handleSelectSession = (session: AgentSessionContext) => {
    setSelectedAgentSessionId(session.ref.agentSessionId);
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
        workspaceName={workspace?.name ?? null}
        workspaceRoot={workspace?.rootPath ?? null}
        context={context}
        contextStatus={contextStatus}
        sessions={sessions}
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
