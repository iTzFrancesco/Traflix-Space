import { Bot, Circle } from "lucide-react";
import type { AgentSessionContext } from "../../lib/jarvis/types";

interface JarvisAgentListProps {
  sessions: AgentSessionContext[];
  selectedSessionId: string | null;
  onSelect: (session: AgentSessionContext) => void;
}

export function JarvisAgentList({
  sessions,
  selectedSessionId,
  onSelect,
}: JarvisAgentListProps) {
  if (sessions.length === 0) {
    return <p className="px-1 py-4 text-sm text-neutral-text-muted">No agent sessions in this workspace.</p>;
  }

  return (
    <div className="space-y-2">
      {sessions.map((session) => {
        const selected = session.ref.agentSessionId === selectedSessionId;
        return (
          <button
            type="button"
            key={session.ref.agentSessionId}
            onClick={() => onSelect(session)}
            className="flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors"
            style={{
              borderColor: selected ? "rgba(255,157,36,0.55)" : "rgba(255,255,255,0.08)",
              backgroundColor: selected ? "rgba(255,157,36,0.08)" : "rgba(255,255,255,0.025)",
            }}
          >
            <Bot size={18} className="shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-semibold text-neutral-text">
                <span className="truncate">{providerName(session.ref.provider)}</span>
                <StatusDot state={session.state} />
              </span>
              <span className="mt-1 block truncate text-xs text-neutral-text-muted">
                {session.ref.terminalId ?? "terminal non disponibile"} · {stateLabel(session.state)}
              </span>
            </span>
            <span className="font-mono text-[10px] text-neutral-text-muted">g{session.ref.generation}</span>
          </button>
        );
      })}
    </div>
  );
}

export function providerName(provider: string): string {
  const names: Record<string, string> = {
    "anti-gravity": "Anti-Gravity",
    claude: "Claude",
    codex: "Codex",
    opencode: "OpenCode",
  };
  return names[provider.toLowerCase()] ?? provider;
}

export function stateLabel(state: AgentSessionContext["state"]): string {
  return {
    starting: "starting",
    working: "working",
    waiting: "waiting",
    completed: "completed",
    failed: "failed",
    aborted: "aborted",
    exited: "exited",
    unknown: "unknown",
  }[state];
}

function StatusDot({ state }: { state: AgentSessionContext["state"] }) {
  const color = state === "working" || state === "starting"
    ? "var(--color-primary)"
    : state === "failed"
      ? "var(--color-danger)"
      : state === "waiting"
        ? "var(--color-signal)"
        : "var(--color-neutral-text-muted)";
  return <Circle size={7} fill={color} strokeWidth={0} style={{ color }} />;
}
