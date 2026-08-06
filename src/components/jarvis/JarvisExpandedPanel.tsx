import { useEffect, useState } from "react";
import { Check, ExternalLink, FileText, RefreshCw, Send, ShieldAlert, TerminalSquare, X } from "lucide-react";
import { JarvisAgentList, providerName, stateLabel } from "./JarvisAgentList";
import { buildAgentSessionView } from "../../lib/jarvis/sessionView";
import type {
  AgentResult,
  AgentSessionContext,
  JarvisConversationMessage,
  JarvisProviderStatus,
  ModelContextViewV1,
  PendingAction,
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
  conversation: JarvisConversationMessage[];
  pendingActions: PendingAction[];
  chatLoading: boolean;
  chatError: string | null;
  providerStatus: JarvisProviderStatus | null;
  onSelectSession: (session: AgentSessionContext) => void;
  onOpenTerminal: (session: AgentSessionContext) => void;
  onRefresh: () => void;
  onSendMessage: (message: string) => void;
  onConfirmAction: (action: PendingAction) => void;
  onRejectAction: (action: PendingAction) => void;
  onClearConversation: () => void;
  onLoadProviderStatus: () => void;
  onIdentityDecision: (session: AgentSessionContext, decision: "confirmed" | "ignored") => void;
}

export function JarvisExpandedPanel(props: JarvisExpandedPanelProps) {
  const [view, setView] = useState<"chat" | "agents" | "advanced">("chat");
  const [draft, setDraft] = useState("");
  useEffect(() => props.onLoadProviderStatus(), [props.onLoadProviderStatus]);

  const submit = () => {
    const message = draft.trim();
    if (!message || props.chatLoading) return;
    setDraft("");
    props.onSendMessage(message);
  };
  const sessionView = buildAgentSessionView(props.sessions);
  const selected = props.sessions.find((session) => session.ref.agentSessionId === props.selectedSessionId) ?? null;

  return (
    <div className="mt-3 w-[min(680px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-white/[0.1] bg-neutral-elevated/95 shadow-2xl backdrop-blur-xl">
      <div className="flex items-start justify-between gap-4 border-b border-white/[0.08] px-5 py-4">
        <div className="min-w-0">
          <p className="eyebrow">Jarvis · Advanced View</p>
          <h2 className="mt-1 truncate text-lg font-semibold text-neutral-text">{props.workspaceName ?? "Seleziona una workspace"}</h2>
          <p className="mt-1 truncate text-xs text-neutral-text-muted">{props.workspaceRoot ?? "Nessuna workspace attiva"}</p>
        </div>
        <button type="button" onClick={props.onRefresh} className="ui-icon-button h-9 w-9 shrink-0" title="Aggiorna registry" aria-label="Aggiorna registry">
          <RefreshCw size={16} className={props.isRefreshing ? "animate-spin" : ""} />
        </button>
      </div>

      <nav className="flex gap-1 border-b border-white/[0.08] px-4 py-2" aria-label="Jarvis advanced view">
        <ViewButton active={view === "chat"} onClick={() => setView("chat")}>Jarvis</ViewButton>
        <ViewButton active={view === "agents"} onClick={() => setView("agents")}>Agenti</ViewButton>
        <ViewButton active={view === "advanced"} onClick={() => setView("advanced")}>Dettagli</ViewButton>
      </nav>

      {view === "chat" && (
        <div className="p-4">
          <div className="max-h-[min(380px,52vh)] space-y-3 overflow-y-auto pr-1">
            {props.conversation.length === 0 && <Welcome workspaceName={props.workspaceName} />}
            {props.conversation.map((message) => <ChatBubble key={message.id} message={message} />)}
            {props.chatLoading && <div className="mr-10 rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2 text-xs text-neutral-text-muted">Jarvis sta pensando…</div>}
          </div>
          {props.chatError && <p className="mt-3 rounded-lg border border-danger/30 bg-danger/[0.08] px-3 py-2 text-xs text-danger">{props.chatError}</p>}
          <div className="mt-3 flex items-end gap-2 rounded-xl border border-white/[0.1] bg-neutral-bg/70 p-2">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder="Chiedi a Jarvis della workspace…" rows={2} className="min-h-12 flex-1 resize-none bg-transparent px-2 py-1 text-sm text-neutral-text outline-none placeholder:text-neutral-text-muted" aria-label="Messaggio per Jarvis" />
            <button type="button" onClick={submit} disabled={!draft.trim() || props.chatLoading || !props.workspaceId} className="ui-icon-button h-9 w-9 shrink-0 bg-primary text-white disabled:opacity-40" title="Invia messaggio" aria-label="Invia messaggio"><Send size={15} /></button>
          </div>
          <PendingActions actions={props.pendingActions} onConfirm={props.onConfirmAction} onReject={props.onRejectAction} />
        </div>
      )}

      {view === "agents" && (
        <div className="grid max-h-[min(620px,70vh)] gap-4 overflow-y-auto p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <section>
            <div className="mb-2 flex items-center justify-between"><h3 className="text-xs font-bold uppercase tracking-[0.12em] text-neutral-text-muted">Agenti</h3><span className="font-mono text-xs text-neutral-text-muted">{sessionView.visible.length}</span></div>
            <JarvisAgentList sessions={sessionView.visible} history={sessionView.history} selectedSessionId={props.selectedSessionId} onSelect={props.onSelectSession} onDecision={props.onIdentityDecision} />
          </section>
          <section className="rounded-xl border border-white/[0.08] bg-neutral-bg/50 p-4">
            {selected ? <SessionDetails session={selected} workspaceName={props.workspaceName} result={props.currentResultSessionId === selected.ref.agentSessionId ? props.currentResult : selected.lastResult ?? null} resultLoading={props.currentResultLoading} error={props.currentError} onOpenTerminal={() => props.onOpenTerminal(selected)} /> : <EmptySelection />}
          </section>
        </div>
      )}

      {view === "advanced" && <AdvancedDetails {...props} />}
    </div>
  );
}

function Welcome({ workspaceName }: { workspaceName: string | null }) {
  return <div className="rounded-xl border border-primary/20 bg-primary/[0.06] p-4"><p className="text-sm font-semibold text-neutral-text">Sono Jarvis.</p><p className="mt-1 text-xs leading-relaxed text-neutral-text-muted">Posso leggere il contesto Markdown consentito, osservare terminali e agenti, ricordare questa conversazione e preparare operazioni da confermare. Workspace: {workspaceName ?? "nessuna"}.</p></div>;
}

function ChatBubble({ message }: { message: JarvisConversationMessage }) {
  return <div className={message.role === "user" ? "ml-10 rounded-xl bg-primary/[0.14] px-3 py-2" : "mr-10 rounded-xl border border-white/[0.08] bg-white/[0.025] px-3 py-2"}><p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-text">{message.content}</p>{message.provider && <p className="mt-1 text-[10px] text-neutral-text-muted">{message.provider}</p>}</div>;
}

function PendingActions({ actions, onConfirm, onReject }: { actions: PendingAction[]; onConfirm: (action: PendingAction) => void; onReject: (action: PendingAction) => void }) {
  const pending = actions.filter((action) => action.status === "pending");
  if (pending.length === 0) return null;
  return <div className="mt-3 space-y-2"><p className="eyebrow text-primary">Conferme richieste</p>{pending.map((action) => <div key={action.id} className="rounded-xl border border-primary/30 bg-primary/[0.06] p-3"><p className="text-xs font-semibold text-neutral-text">{action.description}</p><p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-neutral-text-muted">{action.preview}</p><div className="mt-2 flex gap-2"><button type="button" onClick={() => onConfirm(action)} className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-semibold text-white"><Check size={13} /> Conferma</button><button type="button" onClick={() => onReject(action)} className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-neutral-text-muted"><X size={13} /> Rifiuta</button></div></div>)}</div>;
}

function AdvancedDetails(props: JarvisExpandedPanelProps) {
  const status = props.providerStatus;
  const active = props.sessions.filter((session) => ["starting", "working", "waiting"].includes(session.state)).length;
  return <div className="max-h-[min(620px,70vh)] space-y-3 overflow-y-auto p-4 text-xs text-neutral-text-muted">
    <div className="grid gap-2 sm:grid-cols-3"><Metric label="Agenti attivi" value={String(active)} /><Metric label="Altre workspace" value={String(props.otherWorkspaceAgentCount)} /><Metric label="Contesto" value={props.contextStatus} /></div>
    {status && <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-3"><p className="font-semibold text-neutral-text">Provider modello</p><p className="mt-1">Primario: {status.primary} · {status.model}</p><p>Fallback: {status.fallbackEnabled ? status.fallback : "disattivato"}</p><p>LongCat: {status.longCatConfigured ? "configurato" : "non configurato"} · DeepSeek: {status.deepSeekConfigured ? "configurato" : "non configurato"}</p><p className={status.privacyConsent ? "text-signal" : "text-primary"}>Consenso privacy: {status.privacyConsent ? "attivo" : "necessario"}</p></div>}
    {props.context && <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-3"><div className="flex items-center gap-2"><FileText size={14} className="text-primary" /> {props.context.documentationSummary.documentCount} Markdown consentiti</div><p className="mt-1">Cache {props.context.documentationSummary.cacheStatus} · {props.context.warnings.length} avvisi</p></div>}
    {props.contextError && <p className="rounded-lg border border-primary/30 bg-primary/[0.08] px-3 py-2 text-primary">{props.contextError}</p>}
    <button type="button" onClick={props.onClearConversation} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-neutral-text-muted hover:bg-white/[0.06]">Cancella memoria conversazione workspace</button>
  </div>;
}

function SessionDetails({ session, workspaceName, result, resultLoading, error, onOpenTerminal }: { session: AgentSessionContext; workspaceName: string | null; result: AgentResult | null; resultLoading: boolean; error: string | null; onOpenTerminal: () => void }) {
  return <><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold text-neutral-text">{providerName(session.ref.resolvedProvider || session.ref.provider)}</p><p className="mt-1 text-xs text-neutral-text-muted">{workspaceName ?? session.ref.workspaceId}</p></div><span className="rounded-full border border-primary/30 px-2 py-1 text-[11px] text-primary">{stateLabel(session.state)}</span></div><p className="mt-3 text-xs text-neutral-text-muted">Terminale: {session.ref.terminalId ?? "—"} · generation {session.ref.generation}</p>{session.identityWarnings.map((warning) => <p key={warning} className="mt-2 text-xs text-primary">⚠ {warning}</p>)}<div className="mt-4">{resultLoading ? <div className="h-20 animate-pulse rounded-lg bg-white/[0.04]" /> : result ? <div className="rounded-lg border border-white/[0.08] bg-black/20 p-3"><div className="mb-2 flex items-center gap-2 text-[11px] text-primary"><ShieldAlert size={13} /> Output terminale non fidato</div><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-neutral-text-dim">{result.content}</pre></div> : <p className="text-xs text-neutral-text-muted">{error ?? "Risultato non disponibile"}</p>}</div><button type="button" disabled={!session.ref.terminalId} onClick={onOpenTerminal} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-neutral-text disabled:opacity-40"><ExternalLink size={14} /> Apri terminale</button></>;
}

function EmptySelection() { return <div className="flex min-h-40 flex-col items-center justify-center text-center text-neutral-text-muted"><TerminalSquare size={24} className="mb-2" /><p className="text-sm">Seleziona un agent.</p></div>; }
function ViewButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) { return <button type="button" onClick={onClick} className={`rounded-lg px-3 py-2 text-xs font-semibold ${active ? "bg-primary/[0.12] text-primary" : "text-neutral-text-muted hover:bg-white/[0.05]"}`}>{children}</button>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2"><p className="text-[10px] uppercase tracking-wider">{label}</p><p className="mt-1 truncate text-xs font-semibold text-neutral-text">{value}</p></div>; }
