import { ExternalLink, FileText, RefreshCw, ShieldAlert, TerminalSquare } from "lucide-react";
import { JarvisAgentList, providerName, stateLabel } from "./JarvisAgentList";
import type {
  AgentResult,
  AgentSessionContext,
  ModelContextViewV1,
} from "../../lib/jarvis/types";

interface JarvisExpandedPanelProps {
  workspaceName: string | null;
  workspaceRoot: string | null;
  context: ModelContextViewV1 | null;
  contextStatus: "idle" | "loading" | "ready" | "unavailable";
  sessions: AgentSessionContext[];
  selectedSessionId: string | null;
  currentResult: AgentResult | null;
  currentResultLoading: boolean;
  currentError: string | null;
  otherWorkspaceAgentCount: number;
  onSelectSession: (session: AgentSessionContext) => void;
  onOpenTerminal: (session: AgentSessionContext) => void;
  onRefresh: () => void;
}

export function JarvisExpandedPanel({
  workspaceName,
  workspaceRoot,
  context,
  contextStatus,
  sessions,
  selectedSessionId,
  currentResult,
  currentResultLoading,
  currentError,
  otherWorkspaceAgentCount,
  onSelectSession,
  onOpenTerminal,
  onRefresh,
}: JarvisExpandedPanelProps) {
  const selected = sessions.find((session) => session.ref.agentSessionId === selectedSessionId) ?? null;
  const workingCount = sessions.filter((session) => session.state === "working").length;
  const waitingCount = sessions.filter((session) => session.state === "waiting").length;

  return (
    <div className="mt-3 w-[min(620px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-white/[0.1] bg-neutral-elevated/95 shadow-2xl backdrop-blur-xl">
      <div className="flex items-start justify-between gap-4 border-b border-white/[0.08] px-5 py-4">
        <div className="min-w-0">
          <p className="eyebrow">Jarvis context</p>
          <h2 className="mt-1 truncate text-lg font-semibold text-neutral-text">
            {workspaceName ?? "Select a workspace"}
          </h2>
          <p className="mt-1 truncate text-xs text-neutral-text-muted">{workspaceRoot ?? "Nessuna workspace attiva"}</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="ui-icon-button h-9 w-9 shrink-0"
          title="Aggiorna contesto"
          aria-label="Aggiorna contesto"
        >
          <RefreshCw size={16} className={contextStatus === "loading" ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="grid gap-3 border-b border-white/[0.08] p-4 sm:grid-cols-3">
        <Metric label="Context Broker" value={contextStatusLabel(contextStatus)} />
        <Metric label="Workspace" value={`${workingCount} working · ${waitingCount} waiting`} />
        <Metric label="Altre workspace" value={`${otherWorkspaceAgentCount} sessioni`} />
      </div>

      {context && (
        <div className="flex items-center gap-3 border-b border-white/[0.08] px-5 py-3 text-xs text-neutral-text-muted">
          <FileText size={14} className="text-primary" />
          <span>{context.documentationSummary.documentCount} Markdown · cache {context.documentationSummary.cacheStatus}</span>
          <span className="ml-auto font-mono text-[10px]">{context.documentationSummary.revision}</span>
        </div>
      )}

      <div className="grid max-h-[min(620px,70vh)] gap-4 overflow-y-auto p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-neutral-text-muted">Agent sessions</h3>
            <span className="font-mono text-xs text-neutral-text-muted">{sessions.length}</span>
          </div>
          <JarvisAgentList sessions={sessions} selectedSessionId={selectedSessionId} onSelect={onSelectSession} />
        </section>

        <section className="rounded-xl border border-white/[0.08] bg-neutral-bg/50 p-4">
          {!selected ? (
            <div className="flex min-h-40 flex-col items-center justify-center text-center text-neutral-text-muted">
              <TerminalSquare size={24} className="mb-2 text-neutral-text-muted" />
              <p className="text-sm">Seleziona una Agent session.</p>
              <p className="mt-1 text-xs">Jarvis mostra soltanto stato e ultimo risultato.</p>
            </div>
          ) : (
            <SessionDetails
              session={selected}
              result={currentResult}
              resultLoading={currentResultLoading}
              error={currentError}
              onOpenTerminal={() => onOpenTerminal(selected)}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function SessionDetails({
  session,
  result,
  resultLoading,
  error,
  onOpenTerminal,
}: {
  session: AgentSessionContext;
  result: AgentResult | null;
  resultLoading: boolean;
  error: string | null;
  onOpenTerminal: () => void;
}) {
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-neutral-text">{providerName(session.ref.provider)}</p>
          <p className="mt-1 truncate font-mono text-[11px] text-neutral-text-muted">{session.ref.agentSessionId}</p>
        </div>
        <span className="rounded-full border border-primary/30 bg-primary/[0.08] px-2 py-1 text-[11px] text-primary">{stateLabel(session.state)}</span>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
        <Detail label="Terminale" value={session.ref.terminalId ?? "—"} />
        <Detail label="Generation" value={String(session.ref.generation)} />
        <Detail label="Provider session" value={session.ref.providerSessionId ?? "metadata unavailable"} />
        <Detail label="Provider turn" value={session.ref.providerTurnId ?? session.lastTurn?.turnId ?? "metadata unavailable"} />
      </dl>

      {session.completionNotification && (
        <p className="mt-4 rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2 text-xs text-neutral-text-muted">
          Completion osservata · risultato {session.completionNotification.resultAvailable ? "disponibile" : "non disponibile"}
        </p>
      )}

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-bold uppercase tracking-[0.12em] text-neutral-text-muted">Ultimo risultato</h4>
          {result && <span className="text-[10px] text-neutral-text-muted">{result.provenance.source} · confidence {result.provenance.confidence.toFixed(2)}</span>}
        </div>
        {resultLoading ? (
          <p className="text-sm text-neutral-text-muted">Caricamento risultato…</p>
        ) : result ? (
          <div className="rounded-lg border border-white/[0.08] bg-black/20 p-3">
            <div className="mb-2 flex items-center gap-2 text-[11px] text-primary">
              <ShieldAlert size={13} /> Dato terminale non fidato
              {result.truncated && <span>· bounded/truncated</span>}
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-neutral-text-dim">{result.content}</pre>
          </div>
        ) : (
          <p className="rounded-lg border border-white/[0.08] px-3 py-3 text-sm text-neutral-text-muted">
            {error ?? "completion observed, result unavailable"}
          </p>
        )}
      </div>

      {(session.warnings.length > 0 || error) && (
        <div className="mt-4 space-y-1 text-xs text-neutral-text-muted">
          {session.warnings.map((warning) => <p key={warning}>⚠ {warning}</p>)}
          {error && !session.warnings.includes(error) && <p>⚠ {error}</p>}
        </div>
      )}

      <button
        type="button"
        disabled={!session.ref.terminalId}
        onClick={onOpenTerminal}
        className="mt-4 inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-neutral-text transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ExternalLink size={14} /> Apri terminale
      </button>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-neutral-text-muted">{label}</p>
      <p className="mt-1 truncate text-xs font-semibold text-neutral-text">{value}</p>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wider text-neutral-text-muted">{label}</dt>
      <dd className="mt-1 truncate text-xs text-neutral-text-dim" title={value}>{value}</dd>
    </div>
  );
}

function contextStatusLabel(status: JarvisExpandedPanelProps["contextStatus"]): string {
  return {
    idle: "non avviato",
    loading: "loading…",
    ready: "ready",
    unavailable: "unavailable",
  }[status];
}
