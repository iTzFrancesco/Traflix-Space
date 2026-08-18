import { agentGetLastResult } from "../../lib/jarvis/client";
import { applyRegistrySnapshot } from "../../lib/jarvis/registryState";
import { errorMessage } from "./runtime";
import type { JarvisSlice } from "./types";

export const createRegistrySlice: JarvisSlice = (set, get) => ({
  setExpanded: (expanded) => set({ expanded }),
  setDragging: (dragging) => set({ dragging }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSelectedAgentSessionId: (selectedAgentSessionId) => set({ selectedAgentSessionId }),
  clearResult: () => set({ currentResult: null, currentResultSessionId: null, currentResultLoading: false, currentError: null }),
  setContext: (context, contextStatus, contextError = null) => set((state) => ({ context: context ?? state.context, contextStatus, contextError })),
  setContextStatus: (contextStatus, contextError = null) => set({ contextStatus, contextError }),
  setRegistrySessions: (sessions) => set((state) => {
    const next = applyRegistrySnapshot({
      sessions: state.registrySessions,
      selectedSessionId: state.selectedAgentSessionId,
      currentResult: state.currentResult,
      currentResultSessionId: state.currentResultSessionId,
      currentResultLoading: state.currentResultLoading,
      currentError: state.currentError,
    }, sessions);
    return {
      registrySessions: next.sessions,
      selectedAgentSessionId: next.selectedSessionId,
      currentResult: next.currentResult,
      currentResultSessionId: next.currentResultSessionId,
      currentResultLoading: next.currentResultLoading,
      currentError: next.currentError,
    };
  }),
  setRefreshing: (isRefreshing) => set({ isRefreshing }),
  setResult: (sessionId, currentResult) => set({ currentResultSessionId: sessionId, currentResult, currentResultLoading: false }),
  setResultLoading: (currentResultLoading) => set({ currentResultLoading }),
  setCurrentError: (currentError) => set({ currentError }),
  setRegistryRefreshTimestamp: (registryRefreshTimestamp) => set({ registryRefreshTimestamp }),
  setOtherWorkspaceAgentCount: (otherWorkspaceAgentCount) => set({ otherWorkspaceAgentCount }),

  loadLastResult: async (workspaceId, sessionId) => {
    set({ currentResultLoading: true, currentResultSessionId: sessionId, currentError: null });
    try {
      const envelope = await agentGetLastResult(workspaceId, sessionId);
      if (get().currentResultSessionId !== sessionId) return;
      set({
        currentResult: envelope.data,
        currentResultLoading: false,
        currentError: envelope.warnings.length ? envelope.warnings.join(" · ") : null,
      });
    } catch (error) {
      if (get().currentResultSessionId === sessionId) {
        set({ currentResultLoading: false, currentError: errorMessage(error) });
      }
    }
  },
});
