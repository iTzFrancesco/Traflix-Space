import { useState } from "react";
import { ExternalLink, FileText, RefreshCw, ShieldAlert, TerminalSquare } from "lucide-react";
import { JarvisAgentList, providerName, stateLabel } from "./JarvisAgentList";
import { buildAgentSessionView } from "../../lib/jarvis/sessionView";
import type {
  AgentResult,
  AgentSessionContext,
  ModelContextViewV1,
} from "../../lib/jarvis/types";

interface JarvisExpandedPanelProps {
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceRoot: string | null;
  context: ModelContextViewV1 | null;
  contextStatus: "idle" | "loading" | "ready" | "unavailable";
  contextError: string | null;
  sessions: AgentSessionContext[];
  selectedSessionId: string | null;
  currentResult: AgentResult | null;
  currentResultSessionId: string | null;
  currentResultLoading: boolean;
  currentError: string | null;
  otherWorkspaceAgentCount: number;
  isRefreshing: boolean;
  onSelectSession: (session: AgentSessionContext) => void;
  onOpenTerminal: (session: AgentSessionContext) => void;
  onRefresh: () => void;
}

export function JarvisExpandedPanel({
  workspaceId,
  workspaceName,
  workspaceRoot,
  context,
  contextStatus,
  contextError,
  sessions,
  selectedSessionId,
  currentResult,
  currentResultSessionId,
  currentResultLoading,
  currentError,
  otherWorkspaceAgentCount,
  isRefreshing,
  onSelectSession,
  onOpenTerminal,
  onRefresh,
}: JarvisExpandedPanelProps) {
  const [activeTab, setActiveTab] = useState<"chat" | "agents" | "diagnostics">("agents");
  const selected = sessions.find((session) => session.ref.agentSessionId === selectedSessionId) ?? null;
  const sessionView = buildAgentSessionView(sessions);
  const workingCount = sessions.filter((session) => session.state === "working").length;
  const waitingCount = sessions.filter((session) => session.state === "waiting").length;

  return (
    <div className="mt-3 w-[min(620px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-white/[0.1] bg-neutral-elevated/95 shadow-2xl backdrop-blur-xl">
      <div className="flex items-start justify-between gap-4 border-b border-white/[0.08] px-5 py-4">
        <div className="min-w-0">
          <p className="eyebrow">Jarvis</p>
          <h2 className="mt-1 truncate text-lg font-semibold text-neutral-text">{workspaceName ?? "Select a workspace"}</h2>
          <p className="mt-1 truncate text-xs text-neutral-text-muted">{workspaceRoot ?? "Nessuna workspace attiva"}</p>
        </div>
        <button type="button" onClick={onRefresh} className="ui-icon-button h-9 w-9 shrink-0" title="Aggiorna Jarvis" aria-label="Aggiorna Jarvis">
          <RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} />
        </button>
      </div>

      <nav className="flex gap-1 border-b border-white/[0.08] px-4 py-2" aria-label="Jarvis sections">
        {(["chat", "agents", "diagnostics"] as const).map((tab) => (
          <button
            type="button"
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${activeTab === tab ? "bg-primary/[0.12] text-primary" : "text-neutral-text-muted hover:bg-white/[0.05] hover:text-neutral-text"}`}
          >
            {tab[0].toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </nav>

      {activeTab === "chat" && (
        <div className="p-5">
          <p className="eyebrow">Jarvis chat</p>
          <p className="mt-2 text-sm text-neutral-text">La chat operativa non è ancora collegata.</p>
          <p className="mt-1 text-xs text-neutral-text-muted">Le sessioni e i risultati live sono disponibili nella sezione Agents.</p>
        </div>
      )}

      {activeTab === "agents" && (
        <>
          <div className="grid gap-3 border-b border-white/[0.08] p-4 sm:grid-cols-3">
            <Metric label="Agents" value={`${sessions.length} sessioni`} />
            <Metric label="Workspace" value={`${workingCount} working · ${waitingCount} waiting`} />
            <Metric label="Altre workspace" value={`${otherWorkspaceAgentCount} sessioni`} />
          </div>

          {context && context.documentationSummary.workspaceId === workspaceId && (
            <div className="flex items-center gap-3 border-b border-white/[0.08] px-5 py-3 text-xs text-neutral-text-muted">
              <FileText size={14} className="text-primary" />
              <span>{context.documentationSummary.documentCount} documenti workspace</span>
            </div>
          )}

          <div className="grid max-h-[min(620px,70vh)] gap-4 overflow-y-auto p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-bold uppercase tracking-[0.12em] text-neutral-text-muted">Agents</h3>
                <span className="font-mono text-xs text-neutral-text-muted">{sessionView.visible.length}</span>
              </div>
              <JarvisAgentList sessions={sessionView.visible} history={sessionView.history} selectedSessionId={selectedSessionId} onSelect={onSelectSession} />
            </section>

            <section className="rounded-xl border border-white/[0.08] bg-neutral-bg/50 p-4">
              {!selected ? (
                <div className="flex min-h-40 flex-col items-center justify-center text-center text-neutral-text-muted">
                  <TerminalSquare size={24} className="mb-2 text-neutral-text-muted" />
                  <p className="text-sm">Seleziona un agent.</p>
                  <p className="mt-1 text-xs">Qui restano visibili provider, stato e ultimo risultato.</p>
                </div>
              ) : (
                <SessionDetails
                  session={selected}
                  workspaceName={workspaceName}
                  result={currentResultSessionId === selected.ref.agentSessionId ? currentResult : selected.lastResult ?? null}
                  resultLoading={currentResultLoading}
                  error={currentError}
                  onOpenTerminal={() => onOpenTerminal(selected)}
                />
              )}
            </section>
          </div>
        </>
      )}

      {activeTab === "diagnostics" && (
        <Diagnostics context={context} contextStatus={contextStatus} contextError={contextError} sessions={sessions} isRefreshing={isRefreshing} />
      )}
    </div>
  );
}

function SessionDetails({
  session,
  workspaceName,
  result,
  resultLoading,
  error,
  onOpenTerminal,
}: {
  session: AgentSessionContext;
  workspaceName: string | null;
  result: AgentResult | null;
  resultLoading: boolean;
  error: string | null;
  onOpenTerminal: () => void;
}) {
  const identityWarnings = session.ref.identityWarnings ?? [];
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-neutral-text">{providerName(session.ref.resolvedProvider || session.ref.provider)}</p>
          <p className="mt-1 truncate text-xs text-neutral-text-muted">{workspaceName ?? session.ref.workspaceId}</p>
        </div>
        <span className="rounded-full border border-primary/30 bg-primary/[0.08] px-2 py-1 text-[11px] text-primary">{stateLabel(session.state)}</span>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
        <Detail label="Workspace" value={workspaceName ?? session.ref.workspaceId} />
        <Detail label="Terminale" value={session.ref.terminalId ?? "—"} />
      </dl>

      {identityWarnings.length > 0 && (
        <div className="mt-4 rounded-lg border border-primary/30 bg-primary/[0.08] px-3 py-2 text-xs text-primary">
          {identityWarnings.map((warning) => <p key={warning}>⚠ {warning}</p>)}
        </div>
      )}

      {session.completionNotification && (
        <p className="mt-4 rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2 text-xs text-neutral-text-muted">
          Ultimo turno: {session.completionNotification.resultAvailable ? "risultato disponibile" : "risultato non disponibile"}
        </p>
      )}

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-bold uppercase tracking-[0.12em] text-neutral-text-muted">Ultimo risultato</h4>
        </div>
        {resultLoading ? (
          <div className="h-20 animate-pulse rounded-lg border border-white/[0.08] bg-white/[0.04]" aria-label="Caricamento risultato" />
        ) : result ? (
          <div className="rounded-lg border border-white/[0.08] bg-black/20 p-3">
            <div className="mb-2 flex items-center gap-2 text-[11px] text-primary"><ShieldAlert size={13} /> Dato terminale non fidato{result.truncated && " · risultato limitato"}</div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-neutral-text-dim">{result.content}</pre>
          </div>
        ) : (
          <p className="rounded-lg border border-white/[0.08] px-3 py-3 text-sm text-neutral-text-muted">{error ?? "Risultato non disponibile"}</p>
        )}
      </div>

      <button type="button" disabled={!session.ref.terminalId} onClick={onOpenTerminal} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-neutral-text transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40">
        <ExternalLink size={14} /> Apri terminale
      </button>
    </>
  );
}

function Diagnostics({
  context,
  contextStatus,
  contextError,
  sessions,
  isRefreshing,
}: {
  context: ModelContextViewV1 | null;
  contextStatus: JarvisExpandedPanelProps["contextStatus"];
  contextError: string | null;
  sessions: AgentSessionContext[];
  isRefreshing: boolean;
}) {
  return (
    <div className="max-h-[min(620px,70vh)] space-y-3 overflow-y-auto p-4 text-xs text-neutral-text-muted">
      <Metric label="Registry" value={isRefreshing ? "refreshing" : "ready"} />
      <Metric label="Context Broker" value={contextStatusLabel(contextStatus)} />
      {contextError && <p className="rounded-lg border border-primary/30 bg-primary/[0.08] px-3 py-2 text-primary">{contextError}</p>}
      {context && (
        <div className="space-y-2 rounded-lg border border-white/[0.08] bg-white/[0.025] p-3">
          <Detail label="Cache" value={context.documentationSummary.cacheStatus} />
          <Detail label="Revision" value={context.documentationSummary.revision} />
          <Detail label="Provenance" value={`${context.provenance.source} · confidence ${context.provenance.confidence.toFixed(2)}`} />
          <Detail label="Warnings" value={String(context.warnings.length)} />
        </div>
      )}
      {sessions.map((session) => (
        <div key={session.ref.agentSessionId} className="rounded-lg border border-white/[0.08] bg-white/[0.025] p-3">
          <p className="font-semibold text-neutral-text">{providerName(session.ref.resolvedProvider || session.ref.provider)} · g{session.ref.generation}</p>
          <p className="mt-1 break-all font-mono text-[10px]">{session.ref.agentSessionId}</p>
          <p className="mt-1">source {session.ref.detectionSource} · confidence {session.ref.detectionConfidence.toFixed(2)}</p>
          <p className="mt-1">configured {session.ref.configuredAgentId ?? "—"} · observed {session.ref.observedProvider ?? "—"}</p>
          {session.ref.providerSessionId && <p className="mt-1">provider session {session.ref.providerSessionId}</p>}
          {session.ref.providerTurnId && <p className="mt-1">provider turn {session.ref.providerTurnId}</p>}
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2"><p className="text-[10px] uppercase tracking-wider text-neutral-text-muted">{label}</p><p className="mt-1 truncate text-xs font-semibold text-neutral-text">{value}</p></div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-[10px] uppercase tracking-wider text-neutral-text-muted">{label}</dt><dd className="mt-1 truncate text-xs text-neutral-text-dim" title={value}>{value}</dd></div>;
}

function contextStatusLabel(status: JarvisExpandedPanelProps["contextStatus"]): string {
  return { idle: "non avviato", loading: "loading…", ready: "ready", unavailable: "unavailable" }[status];
}
