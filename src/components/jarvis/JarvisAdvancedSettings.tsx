import { LogIn, LogOut, RefreshCw } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useJarvisStore } from "../../stores/jarvisStore";
import {
  installNotificationAdapters,
  notificationAdapterStatus,
  setIdentityDecision,
} from "../../lib/jarvis/client";
import type {
  AgentSessionContext,
  CodexAccountView,
  CodexModelCatalog,
  CodexModelSettings,
  CodexRateLimitsView,
  CodexRuntimeStatus,
  CodexStreamingTurn,
  CodexUsageView,
  JarvisCodexThread,
  ModelContextViewV1,
  NotificationAdapterHealth,
} from "../../lib/jarvis/types";

export interface JarvisAdvancedSettingsProps {
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
  rateLimits: CodexRateLimitsView | null;
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

/** Review #9: shared props for the settings blocks split out of the old
 *  all-in-one CodexSettingsSection (account / model+usage / diagnostics). */
export type CodexCommonProps = CodexSettingsSectionProps;

function rateLimitSummary(snapshot: unknown): string | null {
  // Review #8: the official rate-limit shape is
  // { primary: { usedPercent, windowDurationMins, resetsAt }, secondary: {...} };
  // legacy payloads (rateLimitsByLimitId / used+limit pairs) stay supported.
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const root = snapshot as Record<string, unknown>;
  const readBucket = (value: unknown): string | null => {
    if (typeof value !== "object" || value === null) return null;
    const entry = value as Record<string, unknown>;
    const percent = entry.usedPercent ?? entry.percent;
    if (typeof percent === "number") {
      const window = entry.windowDurationMins;
      const windowLabel = typeof window === "number" ? ` / ${window}m` : "";
      const reset = entry.resetsAt ?? entry.resetAt;
      const when = typeof reset === "string" ? ` · reset ${reset}` : "";
      return `${Math.round(percent)}%${windowLabel}${when}`;
    }
    const used = entry.used ?? entry.usage ?? entry.consumed;
    const limit = entry.limit ?? entry.limitValue ?? entry.total;
    if (typeof used === "number" && typeof limit === "number" && limit > 0) {
      return `${Math.round((used / limit) * 100)}% (${used}/${limit})`;
    }
    return null;
  };
  const byId = root.rateLimitsByLimitId as Record<string, unknown> | undefined;
  const buckets: string[] = [];
  if (byId && typeof byId === "object") {
    for (const [id, value] of Object.entries(byId)) {
      const summary = readBucket(value);
      if (summary) buckets.push(`${id} ${summary}`);
    }
  } else {
    for (const key of ["primary", "secondary"]) {
      const summary = readBucket(root[key]);
      if (summary) buckets.push(`${key} ${summary}`);
    }
  }
  return buckets.length > 0 ? buckets.join(" · ") : null;
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
      // Review #4: API-key auth is NOT a valid Jarvis backend (cost guard).
      return { label: "API key · non supportato per Jarvis", connected: false };
    case "other":
      return {
        label: `${account.account.accountType} · non supportato`,
        connected: false,
      };
    case "signedOut":
      return { label: "Non connesso", connected: false };
  }
}

/** Review #9: ChatGPT/Codex account block — lives in the normal
 *  "Connessioni" settings (login, plan, email). Sign in/out only. */
export function CodexAccountSettings({
  account,
  accountLoading,
  loginBusy,
  error,
  running,
  onLoadAccount,
  onLogin,
  onLogout,
}: {
  account: CodexAccountView | null;
  accountLoading: boolean;
  loginBusy: boolean;
  error: string | null;
  running: boolean;
  onLoadAccount: () => void;
  onLogin: () => void;
  onLogout: () => void;
}) {
  const summary = accountSummary(account);
  return (
    <div className="divide-y divide-neutral-border border-y border-neutral-border">
      <div className="grid gap-3 py-3 sm:grid-cols-[170px_1fr] sm:items-center">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={
              summary.connected ? "status-dot status-dot--ok" : "status-dot"
            }
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-neutral-text">
              ChatGPT / Codex
            </p>
            <p className="truncate text-[10px] text-neutral-text-muted">
              {summary.connected ? "ChatGPT subscription" : "Non connesso"}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 items-center justify-end gap-2">
          <p className="min-w-0 flex-1 truncate text-right text-[10px] text-neutral-text-muted">
            {summary.label}
          </p>
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
            onClick={onLoadAccount}
            className="ui-icon-button h-7 w-7"
            title="Refresh account"
            aria-label="Refresh account"
            disabled={accountLoading}
          >
            <RefreshCw
              size={12}
              className={accountLoading ? "status-icon--spin" : ""}
            />
          </button>
        </div>
      </div>
      {error && (
        <p className="border-l-2 border-danger px-3 py-2 text-[10px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** Review #9: model + reasoning + usage block — lives in the normal
 *  "Intelligenza" settings. Single source of truth: codex.model +
 *  reasoningEffort (review #7). Changing model normalizes the reasoning to
 *  the new model's default effort (review #5). */
export function CodexModelSettingsSection({
  models,
  modelsLoading,
  usage,
  rateLimits,
  modelSettings,
  running,
  onModelSettingsChange,
}: {
  models: CodexModelCatalog | null;
  modelsLoading: boolean;
  usage: CodexUsageView | null;
  rateLimits: CodexRateLimitsView | null;
  modelSettings: CodexModelSettings;
  running: boolean;
  onModelSettingsChange: (settings: CodexModelSettings) => void;
}) {
  const selected = models?.data.find((model) => model.id === modelSettings.model);
  const efforts = selected?.supportedReasoningEfforts;
  const handleModelChange = (model: string) => {
    const next = models?.data.find((candidate) => candidate.id === model);
    const defaultEffort = next?.defaultReasoningEffort;
    onModelSettingsChange({
      ...modelSettings,
      model,
      // Review #5: switching model resets the reasoning to the new model's
      // default effort (read from model/list) instead of keeping a stale
      // value the new model may not support.
      ...(defaultEffort ? { reasoningEffort: defaultEffort } : {}),
    });
  };
  return (
    <div className="grid gap-3 border-y border-neutral-border py-3 sm:grid-cols-2">
      <label className="block">
        <span className="text-[10px] text-neutral-text-muted">Modello</span>
        <select
          value={modelSettings.model}
          onChange={(event) => handleModelChange(event.target.value)}
          disabled={!running || modelsLoading}
          className="mt-1 w-full rounded border border-neutral-border bg-neutral-elevated px-2 py-1.5 text-xs text-neutral-text"
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
          className="mt-1 w-full rounded border border-neutral-border bg-neutral-elevated px-2 py-1.5 text-xs text-neutral-text"
        >
          {(efforts?.length
            ? efforts
            : [{ reasoningEffort: modelSettings.reasoningEffort }]
          ).map((effort) => (
            <option key={effort.reasoningEffort} value={effort.reasoningEffort}>
              {effort.reasoningEffort}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-neutral-text-muted">
          Parla commentary (TTS progressivo)
        </span>
        <input
          type="checkbox"
          checked={modelSettings.speakCommentary}
          onChange={(event) =>
            onModelSettingsChange({
              ...modelSettings,
              speakCommentary: event.target.checked,
            })
          }
          disabled={!running}
          className="size-3.5 accent-[var(--color-primary)]"
        />
      </label>
      <div className="flex items-center justify-end text-[10px] text-neutral-text-muted">
        <span className="truncate">
          {usage ? (
            <>
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
            </>
          ) : (
            "Usage non disponibile"
          )}
        </span>
      </div>
      {rateLimits && rateLimitSummary(rateLimits.snapshot) && (
        <p className="col-span-full text-[10px] text-neutral-text-muted">
          Rate limits ·{" "}
          <span className="font-mono text-neutral-text">
            {rateLimitSummary(rateLimits.snapshot)}
          </span>
        </p>
      )}
    </div>
  );
}

/** Review #9: runtime/thread/streaming block — stays in "Diagnostica
 *  avanzata" (technical state only). */
export function CodexDiagnosticsSection({
  runtime,
  threads,
  streamingTurns,
  loginBusy,
  onDeleteThread,
  onRestart,
}: {
  runtime: CodexRuntimeStatus | null;
  threads: Record<string, JarvisCodexThread>;
  streamingTurns: CodexStreamingTurn[];
  loginBusy: boolean;
  onDeleteThread: (workspaceId: string) => void;
  onRestart: () => void;
}) {
  const running = runtime?.state === "running";
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-neutral-text">
            Runtime Codex
          </h3>
          <p className="mt-0.5 text-[10px] text-neutral-text-muted">
            Stato tecnico del processo App Server.
          </p>
        </div>
        <button
          type="button"
          onClick={onRestart}
          disabled={loginBusy}
          className="ui-icon-button h-8 w-8"
          title="Restart Codex runtime"
          aria-label="Restart Codex runtime"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-4 divide-x divide-neutral-border border-y border-neutral-border py-2">
        <Metric
          label="Runtime"
          value={runtimeLabel(runtime?.state)}
          tone={running ? "ok" : runtime?.state === "failed" || runtime?.state === "crashed" ? "bad" : "dim"}
        />
        <Metric label="Version" value={runtime?.version ?? "—"} />
        <Metric label="PID" value={runtime?.pid != null ? String(runtime.pid) : "—"} />
        <Metric label="Restarts" value={String(runtime?.restartCount ?? 0)} />
      </dl>
      {runtime?.lastError && (
        <p className="mt-2 truncate text-[10px] text-danger">
          {runtime.lastError}
        </p>
      )}

      {/* C4: ephemeral threads per workspace (one thread per workspace,
          destroyed by Clear Conversation / clean shutdown). */}
      <div className="mt-3 border-t border-neutral-border pt-3">
        <p className="text-[10px] text-neutral-text-muted">Thread Codex per workspace</p>
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
    </div>
  );
}

/** C7: one streaming turn rendered in event order (commentary → tool → …). */
function StreamingTurnView({ turn }: { turn: CodexStreamingTurn }) {
  const interruptCodexTurn = useJarvisStore((state) => state.interruptCodexTurn);
  const steerCodexTurn = useJarvisStore((state) => state.steerCodexTurn);
  const [steerText, setSteerText] = useState("");
  const active = turn.status === "active";
  const submitSteer = (event: FormEvent) => {
    event.preventDefault();
    const text = steerText.trim();
    if (!text || !active) return;
    void steerCodexTurn(turn.workspaceId ?? "", text);
    setSteerText("");
  };
  return (
    <li className="rounded border border-neutral-border bg-surface-raised/40 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-[9px] text-neutral-text-muted">
          turn {turn.turnId.slice(0, 8)}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className={`shrink-0 text-[9px] font-semibold ${
              active ? "text-primary" : "text-neutral-text-muted"
            }`}
          >
            {turn.status}
          </span>
          {active && (
            <button
              type="button"
              title="Interrompi turno (cancella il plan in esecuzione)"
              onClick={() => void interruptCodexTurn(turn.workspaceId ?? "")}
              className="rounded border border-neutral-border px-1.5 py-0.5 text-[9px] text-neutral-text-muted transition-colors hover:border-warning hover:text-warning"
            >
              ⏹ Interrompi
            </button>
          )}
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
      {active && (
        <form onSubmit={submitSteer} className="mt-1.5 flex gap-1.5">
          <input
            value={steerText}
            onChange={(event) => setSteerText(event.target.value)}
            placeholder="Steer (max 240 char)…"
            maxLength={240}
            className="min-w-0 flex-1 rounded border border-neutral-border bg-surface-raised px-1.5 py-1 text-[10px] text-neutral-text outline-none placeholder:text-neutral-text-muted focus:border-primary"
          />
          <button
            type="submit"
            disabled={!steerText.trim()}
            className="rounded border border-neutral-border px-1.5 py-1 text-[10px] text-neutral-text-muted transition-colors hover:border-primary hover:text-primary disabled:opacity-40"
          >
            Invia
          </button>
        </form>
      )}
    </li>
  );
}

export function JarvisAdvancedSettings({
  context,
  contextStatus,
  contextError,
  sessions,
  isRefreshing,
  onRefresh,
  onRefreshContext,
}: JarvisAdvancedSettingsProps) {
  const [decidingIdentity, setDecidingIdentity] = useState<string | null>(null);
  const [adapterHealth, setAdapterHealth] =
    useState<NotificationAdapterHealth | null>(null);
  const [adapterBusy, setAdapterBusy] = useState(false);
  const [adapterError, setAdapterError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void notificationAdapterStatus()
      .then((health) => {
        if (!disposed) setAdapterHealth(health);
      })
      .catch((error) => {
        if (!disposed) setAdapterError(String(error));
      });
    return () => {
      disposed = true;
    };
  }, []);
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
                  {session.ref.terminalTitle ?? session.ref.resolvedProvider}
                </span>
                <span className="font-mono text-neutral-text-muted">
                  {session.state} · g{session.ref.generation}
                </span>
              </div>
              <p className="mt-0.5 truncate font-mono text-[9px] text-neutral-text-muted">
                {session.ref.terminalId ?? "unbound"} · confidence {session.ref.detectionConfidence.toFixed(2)}
              </p>
              {session.identityNeedsConfirmation && session.state !== "exited" && (
                <div className="mt-1">
                  <p className="text-warning">Identity confirmation required</p>
                  <p className="mt-0.5 text-neutral-text-muted">
                    Agente rilevato dal comando di lancio: conferma che questo
                    terminale è davvero l&apos;agente per sbloccare l&apos;invio dei
                    prompt.
                  </p>
                  <div className="mt-1 flex gap-1.5">
                    <button
                      type="button"
                      disabled={decidingIdentity !== null}
                      onClick={() => {
                        setDecidingIdentity(session.ref.agentSessionId);
                        void setIdentityDecision("confirm", session.ref)
                          .catch(() => undefined)
                          .finally(() => {
                            setDecidingIdentity(null);
                            onRefresh();
                          });
                      }}
                      className="rounded border border-primary/40 px-1.5 py-0.5 text-[10px] font-semibold text-primary transition-colors hover:border-primary disabled:opacity-40"
                    >
                      Conferma agente
                    </button>
                    <button
                      type="button"
                      disabled={decidingIdentity !== null}
                      onClick={() => {
                        setDecidingIdentity(session.ref.agentSessionId);
                        void setIdentityDecision("ignore", session.ref)
                          .catch(() => undefined)
                          .finally(() => {
                            setDecidingIdentity(null);
                            onRefresh();
                          });
                      }}
                      className="rounded border border-neutral-border px-1.5 py-0.5 text-[10px] text-neutral-text-muted transition-colors hover:border-danger hover:text-danger disabled:opacity-40"
                    >
                      Ignora
                    </button>
                  </div>
                </div>
              )}
              {session.identityWarnings.length > 0 && (
                <p className="mt-1 text-danger">{session.identityWarnings.join(" · ")}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 border-t border-neutral-border pt-3 text-[10px]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-neutral-text">Notifiche agenti</p>
            <p className="mt-0.5 text-neutral-text-muted">
              {adapterHealth?.message ?? "Controllo adapter…"}
            </p>
          </div>
          {adapterHealth && !adapterHealth.ready && (
            <button
              type="button"
              disabled={adapterBusy}
              onClick={() => {
                setAdapterBusy(true);
                setAdapterError(null);
                void installNotificationAdapters()
                  .then(setAdapterHealth)
                  .catch((error) => setAdapterError(String(error)))
                  .finally(() => setAdapterBusy(false));
              }}
              className="shrink-0 rounded border border-primary/40 px-2 py-1 font-semibold text-primary transition-colors hover:border-primary disabled:opacity-40"
            >
              {adapterBusy ? "Installazione…" : "Installa/Ripara"}
            </button>
          )}
        </div>
        {adapterHealth && (
          <p className="mt-1.5 text-neutral-text-muted">
            {adapterHealth.adapters
              .map((adapter) => `${adapter.provider}: ${adapter.installed ? "ok" : "manca"}`)
              .join(" · ")}
          </p>
        )}
        {adapterError && <p className="mt-1 text-danger">{adapterError}</p>}
      </div>

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
