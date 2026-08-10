import { RefreshCw } from "lucide-react";
import type {
  AgentSessionContext,
  JarvisProviderStatus,
  ModelContextViewV1,
} from "../../lib/jarvis/types";

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

export function JarvisAdvancedSettings({
  providerStatus,
  context,
  contextStatus,
  contextError,
  sessions,
  isRefreshing,
  onRefresh,
  onRefreshContext,
}: JarvisAdvancedSettingsProps) {
  const active = sessions.filter((session) =>
    ["starting", "working", "waiting"].includes(session.state),
  ).length;

  return (
    <section className="border-t border-neutral-border pt-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-neutral-text">Runtime diagnostics</h3>
          <p className="mt-0.5 text-[10px] text-neutral-text-muted">
            Internal registry and context state.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="ui-icon-button h-8 w-8"
          title="Refresh diagnostics"
          aria-label="Refresh diagnostics"
        >
          <RefreshCw
            size={13}
            className={isRefreshing ? "status-icon--spin" : ""}
          />
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-3 divide-x divide-neutral-border border-y border-neutral-border py-2">
        <Metric label="Active" value={String(active)} />
        <Metric label="Registry" value={String(sessions.length)} />
        <Metric label="Context" value={contextStatus} />
      </dl>

      {sessions.length > 0 && (
        <div className="mt-3 divide-y divide-neutral-border">
          {sessions.slice(0, 32).map((session) => (
            <div key={session.ref.agentSessionId} className="py-2 text-[10px]">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium text-neutral-text">
                  {session.ref.resolvedProvider}
                </span>
                <span className="font-mono text-neutral-text-muted">
                  {session.state} · g{session.ref.generation}
                </span>
              </div>
              <p className="mt-0.5 truncate font-mono text-[9px] text-neutral-text-muted">
                {session.ref.terminalId ?? "unbound"} · confidence {session.ref.detectionConfidence.toFixed(2)}
              </p>
              {session.identityNeedsConfirmation && (
                <p className="mt-1 text-warning">Identity confirmation required</p>
              )}
              {session.identityWarnings.length > 0 && (
                <p className="mt-1 text-danger">{session.identityWarnings.join(" · ")}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {providerStatus && (
        <div className="mt-3 border-t border-neutral-border pt-3 text-[10px] text-neutral-text-muted">
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-neutral-text">OpenCode Zen</span>
            <span className={providerStatus.configured ? "text-signal" : "text-warning"}>
              {providerStatus.configured ? "configured" : "not configured"}
            </span>
          </div>
          <p className="mt-1 font-mono">{providerStatus.primaryModel}</p>
          <p>Circuit breaker: {providerStatus.circuitBreakerReason ?? "inactive"}</p>
        </div>
      )}

      {context && (
        <div className="mt-3 border-t border-neutral-border pt-3 text-[10px] text-neutral-text-muted">
          <p>
            Markdown docs: {context.documentationSummary.documentCount} · cache {context.documentationSummary.cacheStatus} · rev {context.documentationSummary.revision}
          </p>
          <button
            type="button"
            onClick={onRefreshContext}
            className="mt-2 text-[10px] font-semibold text-neutral-text-dim hover:text-primary"
          >
            Refresh Context Broker
          </button>
        </div>
      )}

      {contextError && (
        <p className="mt-3 border-l-2 border-danger px-2 py-1 text-[10px] text-danger">
          {contextError}
        </p>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-2 text-center">
      <dt className="text-[9px] text-neutral-text-muted">{label}</dt>
      <dd className="mt-0.5 font-mono text-[10px] font-semibold text-neutral-text">
        {value}
      </dd>
    </div>
  );
}
