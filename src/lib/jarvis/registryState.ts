import type { AgentResult, AgentSessionContext } from "./types";

export interface RegistryViewState {
  sessions: AgentSessionContext[];
  selectedSessionId: string | null;
  currentResult: AgentResult | null;
  currentResultSessionId: string | null;
  currentResultLoading: boolean;
  currentError: string | null;
}

/** Apply a successful light-registry refresh without tearing down UI state. */
export function applyRegistrySnapshot(
  state: RegistryViewState,
  sessions: AgentSessionContext[],
): RegistryViewState {
  const selectedStillExists = state.selectedSessionId === null
    || sessions.some((session) => session.ref.agentSessionId === state.selectedSessionId);
  const selectedSessionId = selectedStillExists ? state.selectedSessionId : null;
  const resultStillBelongs = state.currentResultSessionId === null
    || sessions.some((session) => session.ref.agentSessionId === state.currentResultSessionId);
  const selected = selectedSessionId
    ? sessions.find((session) => session.ref.agentSessionId === selectedSessionId)
    : undefined;
  const shouldAdoptSnapshotResult =
    !state.currentResultLoading &&
    selected?.lastResult !== undefined &&
    state.currentResultSessionId === selectedSessionId;

  return {
    sessions,
    selectedSessionId,
    currentResultSessionId: resultStillBelongs ? state.currentResultSessionId : null,
    currentResult: resultStillBelongs
      ? shouldAdoptSnapshotResult
        ? selected?.lastResult ?? null
        : state.currentResult
      : null,
    currentResultLoading: resultStillBelongs ? state.currentResultLoading : false,
    currentError: resultStillBelongs ? state.currentError : null,
  };
}
