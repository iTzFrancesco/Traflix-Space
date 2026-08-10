import { LogIn, LogOut, RefreshCw } from "lucide-react";
import type {
  AgentSessionContext,
  CodexAccountView,
  CodexModelCatalog,
  CodexModelSettings,
  CodexRuntimeStatus,
  CodexStreamingTurn,
  CodexUsageView,
  JarvisCodexThread,
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

export interface CodexSettingsSectionProps {
  runtime: CodexRuntimeStatus | null;
  account: CodexAccountView | null;
  accountLoading: boolean;
  loginBusy: boolean;
  error: string | null;
  models: CodexModelCatalog | null;
  modelsLoading: boolean;
  usage: CodexUsageView | null;
  modelSettings: CodexModelSettings;
  threads: Record<string, JarvisCodexThread>;
  /** C7: per-workspace streaming turns of the current workspace. */
  streamingTurns: CodexStreamingTurn[];
  onModelSettingsChange: (settings: CodexModelSettings) => void;
  onDeleteThread: (workspaceId: string) => void;
  onLoadAccount: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onRestart: () => void;
}

function runtimeLabel(state: CodexRuntimeStatus["state"] | undefined): string {
  switch (state) {
    case "running":
      return "running";
    case "starting":
      return "starting…";
    case "crashed":
      return "crashed";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return "unknown";
  }
}

function accountSummary(account: CodexAccountView | null): {
  label: string;
  connected: boolean;
} {
  if (!account) return { label: "—", connected: false };
  switch (account.account.kind) {
    case "chatgpt":
      return {
        label: `ChatGPT · ${account.account.planType}${account.account.email ? ` · ${account.account.email}` : ""}`,
        connected: true,
      };
    case "apiKey":
      return { label: "API key", connected: true };
    case "other":
      return { label: account.account.accountType, connected: true };
    case "signedOut":
      return { label: "Non connesso", connected: false };
  }
}

export function CodexSettingsSection({
  runtime,
  account,
  accountLoading,
  loginBusy,
  error,
  models,
  modelsLoading,
  usage,
  modelSettings,
  threads,
  streamingTurns,
  onModelSettingsChange,
  onDeleteThread,
  onLoadAccount,
  onLogin,
  onLogout,
  onRestart,
}: CodexSettingsSectionProps) {
  const summary = accountSummary(account);
  const running = runtime?.state === "running";

  return (
    <section className="border-t border-neutral-border pt-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-neutral-text">Codex App Server</h3>
          <p className="mt-0.5 text-[10px] text-neutral-text-muted">
            Runtime e autenticazione ChatGPT.
          </p>
        </div>
        <button
          type="button"
          onClick={onLoadAccount}
          className="ui-icon-button h-8 w-8"
          title="Refresh account"
          aria-label="Refresh account"
          disabled={accountLoading}
        >
          <RefreshCw
            size={13}
            className={accountLoading ? "status-icon--spin" : ""}
          />
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-3 divide-x divide-neutral-border border-y border-neutral-border py-2">
        <Metric
          label="Runtime"
          value={runtimeLabel(runtime?.state)}
          tone={running ? "ok" : runtime?.state === "failed" || runtime?.state === "crashed" ? "bad" : "dim"}
        />
        <Metric label="Version" value={runtime?.version ?? "—"} />
        <Metric label="Restarts" value={String(runtime?.restartCount ?? 0)} />
      </dl>

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[10px] text-neutral-text-muted">
            Account:{" "}
            <span className={summary.connected ? "font-semibold text-signal" : "font-medium text-neutral-text-dim"}>
              {summary.label}
            </span>
          </p>
          {runtime?.lastError && (
            <p className="mt-1 truncate text-[10px] text-danger">{runtime.lastError}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {summary.connected ? (
            <button
              type="button"
              onClick={onLogout}
              disabled={loginBusy || !running}
              className="ui-button h-7 gap-1.5 text-[10px]"
            >
              <LogOut size={12} />
              Sign out
            </button>
          ) : (
            <button
              type="button"
              onClick={onLogin}
              disabled={loginBusy || !running}
              className="ui-button h-7 gap-1.5 text-[10px]"
            >
              <LogIn size={12} />
              {loginBusy ? "Opening…" : "Sign in with ChatGPT"}
            </button>
          )}
          <button
            type="button"
            onClick={onRestart}
            disabled={loginBusy}
            className="ui-icon-button h-7 w-7"
            title="Restart Codex runtime"
            aria-label="Restart Codex runtime"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-3 border-l-2 border-danger px-2 py-1 text-[10px] text-danger">
          {error}
        </p>
      )}

      {/* C3: model + reasoning selectors populated from the App Server
          catalog (never hardcoded; effort order from model/list). */}
      <div className="mt-3 grid gap-3 border-t border-neutral-border pt-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-[10px] text-neutral-text-muted">Modello</span>
          <select
            value={modelSettings.model}
            onChange={(event) =>
              onModelSettingsChange({
                ...modelSettings,
                model: event.target.value,
              })
            }
            disabled={!running || modelsLoading}
            className="mt-1 w-full rounded border border-neutral-border bg-surface-raised px-2 py-1.5 text-xs text-neutral-text"
          >
            {modelsLoading && <option>Caricamento catalogo…</option>}
            {!modelsLoading &&
              (models?.data.length
                ? models.data.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName ?? model.id}
                      {model.isDefault ? " (default)" : ""}
                    </option>
                  ))
                : [
                    <option key={modelSettings.model} value={modelSettings.model}>
                      {modelSettings.model}
                    </option>,
                  ])}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] text-neutral-text-muted">Reasoning</span>
          <select
            value={modelSettings.reasoningEffort}
            onChange={(event) =>
              onModelSettingsChange({
                ...modelSettings,
                reasoningEffort: event.target.value,
              })
            }
            disabled={!running}
            className="mt-1 w-full rounded border border-neutral-border bg-surface-raised px-2 py-1.5 text-xs text-neutral-text"
          >
            {selectedModelEfforts().map((effort) => (
              <option key={effort.reasoningEffort} value={effort.reasoningEffort}>
                {effort.reasoningEffort}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* C3: usage summary from account/usage/read. */}
      {usage && (
        <div className="mt-3 border-t border-neutral-border pt-3 text-[10px] text-neutral-text-muted">
          <p>
            Usage · lifetime{" "}
            <span className="font-mono text-neutral-text">
              {formatTokens(usage.lifetimeTokens)}
            </span>{" "}
            · peak daily{" "}
            <span className="font-mono text-neutral-text">
              {formatTokens(usage.peakDailyTokens)}
            </span>{" "}
            · streak{" "}
            <span className="font-mono text-neutral-text">
              {usage.currentStreakDays ?? 0}d
            </span>
          </p>
        </div>
      )}

      {/* C4: ephemeral threads per workspace (one thread per workspace,
          destroyed by Clear Conversation / clean shutdown). */}
      <div className="mt-3 border-t border-neutral-border pt-3">
        <p className="text-[10px] text-neutral-text-muted">Thread Codex</p>
        {Object.keys(threads).length === 0 ? (
          <p className="mt-1 text-[10px] italic text-neutral-text-muted">
            Nessun thread attivo — viene creato al primo turno del workspace.
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {Object.values(threads).map((thread) => (
              <li
                key={thread.threadId}
                className="flex items-center justify-between gap-2 text-[10px]"
              >
                <span className="truncate text-neutral-text">
                  {thread.workspaceId.slice(0, 8)} · {thread.model}
                  <span
                    className={
                      thread.status === "in_progress"
                        ? "ml-1.5 text-primary"
                        : "ml-1.5 text-neutral-text-muted"
                    }
                  >
                    {thread.status === "in_progress" ? "• in corso" : "idle"}
                  </span>
                </span>
                <button
                  onClick={() => onDeleteThread(thread.workspaceId)}
                  className="text-danger hover:underline"
                  title="Elimina thread"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* C7: live streaming of the active turn — commentary → tool →
          commentary → final → turn completed. Raw reasoning is never
          forwarded by the backend (spec §15). */}
      <div className="mt-3 border-t border-neutral-border pt-3">
        <p className="text-[10px] text-neutral-text-muted">Streaming Codex</p>
        {streamingTurns.length === 0 ? (
          <p className="mt-1 text-[10px] italic text-neutral-text-muted">
            Nessun turno streaming — appare qui quando Codex lavora.
          </p>
        ) : (
          <ul className="mt-1 max-h-64 space-y-3 overflow-y-auto pr-1">
            {streamingTurns.map((turn) => (
              <StreamingTurnView key={turn.turnId} turn={turn} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );

  function selectedModelEfforts() {
    const selected = models?.data.find((model) => model.id === modelSettings.model);
    const efforts = selected?.supportedReasoningEfforts;
    if (efforts?.length) return efforts;
    // Fallback while the catalog is loading: the current persisted value
    // (never a fabricated order).
    return [{ reasoningEffort: modelSettings.reasoningEffort }];
  }
}

/** C7: one streaming turn rendered in event order (commentary → tool → …). */
function StreamingTurnView({ turn }: { turn: CodexStreamingTurn }) {
  return (
    <li className="rounded border border-neutral-border bg-surface-raised/40 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[9px] text-neutral-text-muted">
          turn {turn.turnId.slice(0, 8)}
        </span>
        <span
          className={`shrink-0 text-[9px] font-semibold ${
            turn.status === "active" ? "text-primary" : "text-neutral-text-muted"
          }`}
        >
          {turn.status}
        </span>
      </div>
      <ol className="mt-1.5 space-y-1.5">
        {turn.items.map((item) => {
          if (item.kind === "tool") {
            return (
              <li
                key={item.itemId}
                className="flex items-center gap-1.5 font-mono text-[9px] text-neutral-text-muted"
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    item.status === "completed"
                      ? "bg-signal"
                      : item.status === "started"
                        ? "animate-pulse bg-primary"
                        : "bg-warning"
                  }`}
                />
                <span className="truncate">{item.toolName ?? "tool"}</span>
                <span className="shrink-0">
                  {item.status === "completed" ? "✓" : "…"}
                </span>
              </li>
            );
          }
          const final = item.final;
          return (
            <li
              key={item.itemId}
              className={`rounded px-1.5 py-1 text-[10px] leading-snug ${
                final
                  ? "border-l-2 border-primary bg-surface-raised text-neutral-text"
                  : "text-neutral-text-muted"
              }`}
            >
              {final && (
                <span className="mr-1 font-semibold text-primary">Final ·</span>
              )}
              <span className="whitespace-pre-wrap break-words">
                {item.text || "…"}
              </span>
            </li>
          );
        })}
      </ol>
    </li>
  );
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

function formatTokens(value?: number | null): string {
  if (value === undefined || value === null) return "—";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "bad" | "dim";
}) {
  return (
    <div className="px-2 text-center">
      <dt className="text-[9px] text-neutral-text-muted">{label}</dt>
      <dd
        className={`mt-0.5 font-mono text-[10px] font-semibold ${
          tone === "ok"
            ? "text-signal"
            : tone === "bad"
              ? "text-danger"
              : tone === "dim"
                ? "text-neutral-text-dim"
                : "text-neutral-text"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
