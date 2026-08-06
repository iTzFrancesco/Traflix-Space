import { RefreshCw } from "lucide-react";
import type { AgentSessionContext, ModelContextViewV1, JarvisProviderStatus } from "../../lib/jarvis/types";

export interface JarvisAdvancedSettingsProps {
  providerStatus: JarvisProviderStatus | null;
  context: ModelContextViewV1 | null;
  contextStatus: string;
  contextError: string | null;
  sessions: AgentSessionContext[];
  isRefreshing: boolean;
  onRefresh: () => void;
  onRefreshContext: () => void;
}

export function JarvisAdvancedSettings({ providerStatus, context, contextStatus, contextError, sessions, isRefreshing, onRefresh, onRefreshContext }: JarvisAdvancedSettingsProps) {
  const active = sessions.filter((session) => ["starting", "working", "waiting"].includes(session.state)).length;
  return <section className="space-y-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4"><div className="flex items-center justify-between"><div><h3 className="font-semibold text-neutral-text">Strumenti avanzati</h3><p className="text-xs text-neutral-text-muted">Diagnostica runtime per la verifica di Jarvis.</p></div><button type="button" onClick={onRefresh} className="ui-icon-button h-8 w-8" title="Aggiorna diagnostica" aria-label="Aggiorna diagnostica"><RefreshCw size={14} className={isRefreshing ? "animate-spin" : ""} /></button></div>
    <div className="grid gap-2 sm:grid-cols-3"><Metric label="Agenti attivi" value={String(active)} /><Metric label="Sessioni registry" value={String(sessions.length)} /><Metric label="Contesto" value={contextStatus} /></div>
    {sessions.length > 0 && <div className="space-y-2 rounded-lg border border-white/[0.08] bg-neutral-bg/50 p-3"><p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-text-muted">Identità agenti</p>{sessions.slice(0, 32).map((session) => <div key={session.ref.agentSessionId} className="rounded-md border border-white/[0.06] px-2 py-2 text-xs"><div className="flex items-center justify-between gap-2"><span className="font-medium text-neutral-text">{session.ref.resolvedProvider}</span><span className="text-neutral-text-muted">{session.state} · g{session.ref.generation}</span></div><p className="mt-1 text-[10px] text-neutral-text-muted">{session.ref.terminalId ?? "terminale non associato"} · confidenza {session.ref.detectionConfidence.toFixed(2)}</p>{session.identityNeedsConfirmation && <p className="mt-1 text-[10px] text-primary">Conferma identità richiesta</p>}{session.identityWarnings.length > 0 && <p className="mt-1 text-[10px] text-danger">{session.identityWarnings.join(" · ")}</p>}{session.lastResult && <p className="mt-1 text-[10px] text-neutral-text-muted">Ultimo risultato: {session.lastResult.truncated ? "troncato" : "disponibile"} · non trusted</p>}</div>)}</div>}
    {providerStatus && <div className="rounded-lg border border-white/[0.08] bg-neutral-bg/50 p-3 text-xs text-neutral-text-muted"><p className="font-semibold text-neutral-text">OpenCode Zen</p><p className="mt-1">Primario: {providerStatus.primaryModel}</p><p>Fallback: {providerStatus.fallbackEnabled ? providerStatus.fallbackModel : "disattivato"}</p><p>Configurato: {providerStatus.configured ? "sì" : "no"} · Consenso: {providerStatus.privacyConsent ? "attivo" : "necessario"}</p><p>Circuit breaker: {providerStatus.circuitBreakerReason ?? "inattivo"}</p></div>}
    {context && <div className="rounded-lg border border-white/[0.08] bg-neutral-bg/50 p-3 text-xs text-neutral-text-muted"><p>Markdown consentiti: {context.documentationSummary.documentCount}</p><p>Cache: {context.documentationSummary.cacheStatus} · revision: {context.documentationSummary.revision}</p><button type="button" onClick={onRefreshContext} className="mt-2 rounded-md border border-white/10 px-2 py-1">Aggiorna Context Broker</button></div>}
    {contextError && <p className="rounded-lg border border-danger/30 bg-danger/[0.08] px-3 py-2 text-xs text-danger">{contextError}</p>}
  </section>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border border-white/[0.08] bg-neutral-bg/50 px-3 py-2"><p className="text-[10px] uppercase tracking-wider text-neutral-text-muted">{label}</p><p className="mt-1 text-xs font-semibold text-neutral-text">{value}</p></div>; }
