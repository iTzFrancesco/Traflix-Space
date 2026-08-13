import { LogIn, LogOut, RefreshCw } from "lucide-react";
import { useState } from "react";
import type {
  CodexAccountView,
  CodexModelCatalog,
  CodexModelSettings,
  CodexRateLimitsView,
  CodexRuntimeStatus,
  CodexUsageView,
} from "../../lib/jarvis/types";

interface RateLimitBucket {
  key: string;
  usedPercent: number;
  leftPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractRateLimitBuckets(snapshot: unknown): RateLimitBucket[] {
  const root = asRecord(snapshot);
  if (!root) return [];

  // account/rateLimits/read returns { rateLimits: { primary, secondary, ... } }.
  // account/rateLimits/updated is forwarded as the rateLimits object itself.
  const limits = asRecord(root.rateLimits) ?? root;
  const buckets: RateLimitBucket[] = [];

  for (const key of ["primary", "secondary"]) {
    const entry = asRecord(limits[key]);
    if (!entry) continue;
    const usedPercent = asFiniteNumber(entry.usedPercent ?? entry.percent);
    if (usedPercent === null) continue;
    const windowDurationMins = asFiniteNumber(entry.windowDurationMins);
    const resetsAt =
      typeof entry.resetsAt === "number" || typeof entry.resetsAt === "string"
        ? entry.resetsAt
        : null;
    const used = Math.max(0, Math.min(100, usedPercent));
    buckets.push({
      key,
      usedPercent: used,
      leftPercent: 100 - used,
      windowDurationMins,
      resetsAt,
    });
  }

  return buckets;
}

function findFiveHourBucket(buckets: RateLimitBucket[]): RateLimitBucket | null {
  return (
    buckets.find((bucket) => bucket.windowDurationMins === 300) ??
    buckets.find(
      (bucket) =>
        bucket.key === "primary" &&
        (bucket.windowDurationMins === null || bucket.windowDurationMins < 1_440),
    ) ??
    null
  );
}

function findWeeklyBucket(buckets: RateLimitBucket[]): RateLimitBucket | null {
  return (
    buckets.find((bucket) => bucket.windowDurationMins === 10_080) ??
    buckets.find((bucket) => bucket.key === "secondary") ??
    null
  );
}

function resetDate(value: number | string | null): Date | null {
  if (value === null) return null;
  if (typeof value === "number") {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const numeric = Number(value);
  if (value.trim() && Number.isFinite(numeric)) {
    const date = new Date(numeric * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatReset(value: number | string | null): string | null {
  const date = resetDate(value);
  if (!date) return null;
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = new Intl.DateTimeFormat("it-IT", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  if (sameDay) return `reset ${time}`;
  const day = new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "short",
  }).format(date);
  return `reset ${time} · ${day}`;
}

function accountConnected(account: CodexAccountView | null): boolean {
  return account?.account.kind === "chatgpt";
}

function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

export function CodexConnectionRow({
  account,
  accountLoading,
  loginBusy,
  error,
  running,
  onLogin,
  onLogout,
}: {
  account: CodexAccountView | null;
  accountLoading: boolean;
  loginBusy: boolean;
  error: string | null;
  running: boolean;
  onLogin: () => void;
  onLogout: () => void;
}) {
  const connected = accountConnected(account);
  return (
    <div className="border-y border-neutral-border">
      <div className="flex min-h-14 items-center justify-between gap-3 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={connected ? "status-dot status-dot--ok" : "status-dot"}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-neutral-text">
              ChatGPT / Codex
            </p>
            <p className="truncate text-[10px] text-neutral-text-muted">
              {accountLoading
                ? "Caricamento account…"
                : connected
                  ? "ChatGPT subscription"
                  : "Non connesso"}
            </p>
          </div>
        </div>
        {connected ? (
          <button
            type="button"
            onClick={onLogout}
            disabled={loginBusy || accountLoading || !running}
            className="ui-button h-8 gap-1.5 px-3 text-xs"
          >
            <LogOut size={12} />
            Sign out
          </button>
        ) : (
          <button
            type="button"
            onClick={onLogin}
            disabled={loginBusy || accountLoading || !running}
            className="ui-button h-8 gap-1.5 px-3 text-xs"
          >
            <LogIn size={12} />
            {loginBusy ? "Opening…" : "Sign in with ChatGPT"}
          </button>
        )}
      </div>
      {error && (
        <p className="border-l-2 border-danger px-3 py-2 text-[10px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function StatusLimitRow({
  label,
  bucket,
  inactiveMessage,
}: {
  label: string;
  bucket: RateLimitBucket | null;
  inactiveMessage: string;
}) {
  if (!bucket) {
    return (
      <div>
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="font-medium text-neutral-text">{label}</span>
          <span className="text-neutral-text-muted">{inactiveMessage}</span>
        </div>
        <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-neutral-darkest" />
      </div>
    );
  }

  const reset = formatReset(bucket.resetsAt);
  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-neutral-text">{label}</span>
        <span className="font-mono text-neutral-text">
          {Math.round(bucket.leftPercent)}% left
          {reset ? ` · ${reset}` : ""}
        </span>
      </div>
      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-neutral-darkest">
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          // Match Codex /status: the bar fills with quota consumed while the
          // label reports the complementary percentage left.
          style={{ width: `${bucket.usedPercent}%` }}
        />
      </div>
      <p className="mt-1 text-right font-mono text-[10px] text-neutral-text-muted">
        {Math.round(bucket.usedPercent)}% used
      </p>
    </div>
  );
}

export function CodexStatusSettings({
  account,
  accountLoading,
  runtime,
  rateLimits,
  rateLimitsLoading,
  usage,
  usageLoading,
  onRefresh,
}: {
  account: CodexAccountView | null;
  accountLoading: boolean;
  runtime: CodexRuntimeStatus | null;
  rateLimits: CodexRateLimitsView | null;
  rateLimitsLoading: boolean;
  usage: CodexUsageView | null;
  usageLoading: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const connected = accountConnected(account);
  const buckets = extractRateLimitBuckets(rateLimits?.snapshot);
  const fiveHour = findFiveHourBucket(buckets);
  const weekly = findWeeklyBucket(buckets);
  const accountLabel =
    account?.account.kind === "chatgpt"
      ? `ChatGPT ${account.account.planType}${account.account.email ? ` · ${account.account.email}` : ""}`
      : "Non connesso";

  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="border border-neutral-border bg-neutral-elevated/20">
      <div className="flex items-start justify-between gap-3 border-b border-neutral-border px-3 py-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-neutral-text">{accountLabel}</p>
          <p className="mt-0.5 text-[10px] text-neutral-text-muted">
            {accountLoading || rateLimitsLoading || usageLoading
              ? "Caricamento account e statistiche…"
              : runtime?.state === "running"
                ? `${runtime.version ?? "Codex"} · runtime attivo`
                : `runtime ${runtime?.state ?? "non disponibile"}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="ui-icon-button h-7 w-7 shrink-0"
          title="Aggiorna Codex status"
          aria-label="Aggiorna Codex status"
        >
          <RefreshCw size={12} className={refreshing ? "status-icon--spin" : ""} />
        </button>
      </div>

      <div className="px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-text-muted">
            Codex status
          </p>
          <span className="text-[10px] text-neutral-text-muted">quota</span>
        </div>

        {(accountLoading || rateLimitsLoading) && !rateLimits ? (
          <p className="mt-2 text-[10px] text-neutral-text-muted">
            Caricamento limiti Codex…
          </p>
        ) : !connected ? (
          <p className="mt-2 text-[10px] text-neutral-text-muted">
            Accedi con ChatGPT per leggere i limiti Codex.
          </p>
        ) : (
          <div className="mt-3 space-y-4">
            <StatusLimitRow
              label="Session · 5h"
              bucket={fiveHour}
              inactiveMessage="No active 5h session"
            />
            <StatusLimitRow
              label="Weekly"
              bucket={weekly}
              inactiveMessage="Weekly limit non disponibile"
            />
            {!fiveHour && !weekly && (
              <p className="text-[10px] leading-relaxed text-neutral-text-muted">
                Codex non ha restituito finestre attive. Aggiorna lo status dopo il prossimo turno.
              </p>
            )}
          </div>
        )}

        {connected && (
          <div className="mt-4 border-t border-neutral-border pt-3 text-[10px] text-neutral-text-muted">
            <div className="flex items-center justify-between gap-3">
              <span className="font-semibold uppercase tracking-wide">Statistiche</span>
              {usageLoading ? (
                <span>Caricamento…</span>
              ) : usage ? (
                <span className="font-mono text-neutral-text">
                  lifetime {formatTokens(usage.lifetimeTokens)} · daily {formatTokens(usage.peakDailyTokens)} · streak {usage.currentStreakDays ?? 0}d
                </span>
              ) : (
                <span>Non disponibili</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function CodexIntelligenceSettings({
  models,
  modelsLoading,
  modelSettings,
  running,
  onModelSettingsChange,
}: {
  models: CodexModelCatalog | null;
  modelsLoading: boolean;
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

      <label className="col-span-full flex items-center justify-between gap-2 border-t border-neutral-border pt-3">
        <span>
          <span className="block text-[10px] font-medium text-neutral-text">
            Parla commentary
          </span>
          <span className="mt-0.5 block text-[10px] text-neutral-text-muted">
            TTS progressivo durante il turno Codex.
          </span>
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
    </div>
  );
}
