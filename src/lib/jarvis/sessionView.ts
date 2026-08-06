import type { AgentSessionContext } from "./types";

export interface AgentSessionHistoryGroup {
  terminalId: string;
  sessions: AgentSessionContext[];
}

export interface AgentSessionView {
  visible: AgentSessionContext[];
  history: AgentSessionHistoryGroup[];
}

const RECENT_EXITED_LIMIT = 3;
const RECENT_WAITING_MS = 30 * 60 * 1000;

function timestamp(session: AgentSessionContext): number {
  const value = Date.parse(session.ref.updatedAt);
  return Number.isFinite(value) ? value : 0;
}

/** Keep the main list useful while retaining bounded, navigable history. */
export function buildAgentSessionView(
  sessions: AgentSessionContext[],
  now = Date.now(),
): AgentSessionView {
  const sorted = [...sessions].sort((left, right) => timestamp(right) - timestamp(left));
  const latestGenerationByTerminal = new Map<string, number>();
  for (const session of sorted) {
    const terminalId = session.ref.terminalId ?? "terminal-unknown";
    latestGenerationByTerminal.set(terminalId, Math.max(latestGenerationByTerminal.get(terminalId) ?? 0, session.ref.generation));
  }
  const recentExited = sorted
    .filter((session) => session.state === "exited" && latestGenerationByTerminal.get(session.ref.terminalId ?? "terminal-unknown") === session.ref.generation)
    .slice(0, RECENT_EXITED_LIMIT);
  const recentExitedIds = new Set(recentExited.map((session) => session.ref.agentSessionId));
  const visible = sorted.filter((session) =>
    session.state !== "exited" ||
    recentExitedIds.has(session.ref.agentSessionId) ||
    now - timestamp(session) <= RECENT_WAITING_MS &&
    latestGenerationByTerminal.get(session.ref.terminalId ?? "terminal-unknown") === session.ref.generation,
  );
  const historyByTerminal = new Map<string, AgentSessionContext[]>();
  for (const session of sorted) {
    if (visible.some((candidate) => candidate.ref.agentSessionId === session.ref.agentSessionId)) continue;
    const terminalId = session.ref.terminalId ?? "terminal-unknown";
    const group = historyByTerminal.get(terminalId) ?? [];
    group.push(session);
    historyByTerminal.set(terminalId, group);
  }
  return {
    visible,
    history: [...historyByTerminal.entries()].map(([terminalId, grouped]) => ({ terminalId, sessions: grouped })),
  };
}
