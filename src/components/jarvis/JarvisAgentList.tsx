import { useState } from "react";
import { Bot, Circle } from "lucide-react";
import type { AgentSessionContext } from "../../lib/jarvis/types";
import type { AgentSessionHistoryGroup } from "../../lib/jarvis/sessionView";

interface JarvisAgentListProps {
  sessions: AgentSessionContext[];
  history: AgentSessionHistoryGroup[];
  selectedSessionId: string | null;
  onSelect: (session: AgentSessionContext) => void;
}

export function JarvisAgentList({ sessions, history, selectedSessionId, onSelect }: JarvisAgentListProps) {
  const [decisions, setDecisions] = useState<Record<string, "confirmed" | "ignored">>({});
  const visibleSessions = sessions.filter((session) => decisions[session.ref.agentSessionId] !== "ignored");

  if (visibleSessions.length === 0 && history.length === 0) {
    return <p className="px-1 py-4 text-sm text-neutral-text-muted">Nessuna agent session nella workspace.</p>;
  }

  return (
    <div className="space-y-2">
      {visibleSessions.map((session) => (
        <AgentRow
          key={session.ref.agentSessionId}
          session={session}
          selected={session.ref.agentSessionId === selectedSessionId}
          confirmed={decisions[session.ref.agentSessionId] === "confirmed"}
          onSelect={() => onSelect(session)}
          onDecision={(decision) => setDecisions((current) => ({ ...current, [session.ref.agentSessionId]: decision }))}
        />
      ))}
      {history.length > 0 && (
        <details className="pt-2">
          <summary className="cursor-pointer rounded-lg px-3 py-2 text-xs font-semibold text-neutral-text-muted hover:bg-white/[0.05]">History · {history.reduce((count, group) => count + group.sessions.length, 0)}</summary>
          <div className="mt-2 space-y-2 border-l border-white/[0.08] pl-2">
            {history.map((group) => (
              <details key={group.terminalId}>
                <summary className="cursor-pointer px-2 py-1 text-[11px] text-neutral-text-muted">{group.terminalId} · {group.sessions.length} generazioni</summary>
                <div className="mt-1 space-y-1">
                  {group.sessions.map((session) => <AgentRow key={session.ref.agentSessionId} session={session} selected={session.ref.agentSessionId === selectedSessionId} confirmed onSelect={() => onSelect(session)} onDecision={() => undefined} compact />)}
                </div>
              </details>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function AgentRow({
  session,
  selected,
  confirmed,
  compact = false,
  onSelect,
  onDecision,
}: {
  session: AgentSessionContext;
  selected: boolean;
  confirmed: boolean;
  compact?: boolean;
  onSelect: () => void;
  onDecision: (decision: "confirmed" | "ignored") => void;
}) {
  const possible = session.ref.identityNeedsConfirmation && !confirmed;
  return (
    <div className={`rounded-xl border ${selected ? "border-primary/55 bg-primary/[0.08]" : "border-white/[0.08] bg-white/[0.025]"}`}>
      <button type="button" onClick={onSelect} className="flex min-h-11 w-full items-center gap-3 px-3 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <Bot size={compact ? 15 : 18} className="shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-semibold text-neutral-text"><span className="truncate">{providerName(session.ref.resolvedProvider || session.ref.provider)}</span><StatusDot state={session.state} /></span>
          <span className="mt-1 block truncate text-xs text-neutral-text-muted">{session.ref.terminalId ?? "terminale non disponibile"} · {stateLabel(session.state)}</span>
        </span>
        {compact && <span className="font-mono text-[10px] text-neutral-text-muted">g{session.ref.generation}</span>}
      </button>
      {possible && (
        <div className="border-t border-primary/20 px-3 py-2 text-xs text-primary">
          <p>Possible agent detected: {providerName(session.ref.observedProvider ?? session.ref.resolvedProvider)}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => onDecision("confirmed")} className="rounded-md border border-primary/30 px-2 py-1 font-semibold hover:bg-primary/[0.12]">Conferma</button>
            <button type="button" onClick={() => onDecision("ignored")} className="rounded-md border border-white/10 px-2 py-1 text-neutral-text-muted hover:bg-white/[0.06]">Ignora</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function providerName(provider: string): string {
  const names: Record<string, string> = { "anti-gravity": "Anti-Gravity", claude: "Claude", codex: "Codex", freebuff: "Freebuff", opencode: "OpenCode", pi: "Pi" };
  return names[provider.toLowerCase()] ?? provider;
}

export function stateLabel(state: AgentSessionContext["state"]): string {
  return { starting: "starting", working: "working", waiting: "waiting", completed: "completed", failed: "failed", aborted: "aborted", exited: "exited", unknown: "unknown" }[state];
}

function StatusDot({ state }: { state: AgentSessionContext["state"] }) {
  const color = state === "working" || state === "starting" ? "var(--color-primary)" : state === "failed" ? "var(--color-danger)" : state === "waiting" ? "var(--color-signal)" : "var(--color-neutral-text-muted)";
  return <Circle size={7} fill={color} strokeWidth={0} style={{ color }} />;
}
