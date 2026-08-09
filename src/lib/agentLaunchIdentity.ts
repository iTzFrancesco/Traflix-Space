export interface AgentLaunchRuntime {
  terminalId: string;
  workspaceId: string;
  generation: number;
  processId: number | null;
}

/** Stable queue/dedupe key for one provider CLI launch attempt. */
export function agentLaunchKey(runtime: AgentLaunchRuntime): string {
  return `${runtime.workspaceId}:${runtime.terminalId}:${runtime.generation}:${runtime.processId ?? "none"}`;
}

export function matchesAgentLaunchRuntime(
  left: AgentLaunchRuntime,
  right: AgentLaunchRuntime,
): boolean {
  return left.terminalId === right.terminalId &&
    left.workspaceId === right.workspaceId &&
    left.generation === right.generation &&
    left.processId === right.processId;
}
