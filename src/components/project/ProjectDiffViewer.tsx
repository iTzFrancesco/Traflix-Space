import {
  FileDiff,
  GitCompareArrows,
  LoaderCircle,
  X,
} from "lucide-react";
import type { DiffSide, ProjectGitDiff } from "../../project/types";
import type { ProjectGitChange } from "../../project/types";

interface ProjectDiffViewerProps {
  diff: ProjectGitDiff | null;
  loading: boolean;
  error: string | null;
  change: ProjectGitChange | null;
  actionLoading?: boolean;
  actionError?: string | null;
  actionMessage?: string | null;
  readOnly?: boolean;
  onClose: () => void;
  onSideChange: (side: DiffSide) => void;
  showSideToggle?: boolean;
  onStage?: () => void;
  onUnstage?: () => void;
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-neutral-text-muted";
  if (line.startsWith("+")) return "bg-emerald-400/[0.08] text-emerald-200";
  if (line.startsWith("-")) return "bg-red-400/[0.08] text-red-200";
  if (line.startsWith("@@")) return "bg-sky-400/[0.08] text-sky-200";
  if (line.startsWith("diff --git")) return "text-primary";
  return "text-neutral-text-dim";
}

export function ProjectDiffViewer({
  diff,
  loading,
  error,
  change,
  actionLoading = false,
  actionError = null,
  actionMessage = null,
  readOnly = false,
  showSideToggle = true,
  onClose,
  onSideChange,
  onStage,
  onUnstage,
}: ProjectDiffViewerProps) {
  const lines = diff?.patch ? diff.patch.split("\n") : [];

  return (
    <section className="mx-2 flex h-[46%] max-h-[420px] min-h-[180px] min-w-0 max-w-[calc(100%-1rem)] shrink-0 flex-col overflow-hidden rounded-lg border border-white/[0.08] bg-black/20">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] px-3 py-2">
        <FileDiff size={14} className="shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[0.68rem] font-semibold text-neutral-text" title={diff?.path}>
            {diff?.path ?? "Review diff"}
          </p>
          <p className="mt-0.5 text-[0.56rem] uppercase tracking-wider text-neutral-text-muted">
            {readOnly ? "Diff read-only" : "Review locale"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ui-icon-button h-7 w-7 shrink-0"
          title="Chiudi review"
          aria-label="Chiudi review"
        >
          <X size={13} />
        </button>
        {loading && <LoaderCircle size={13} className="shrink-0 animate-spin text-primary" />}
      </div>

      {showSideToggle ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2">
          <GitCompareArrows size={13} className="text-neutral-text-muted" />
          <div className="flex flex-1 gap-1 rounded-md border border-white/[0.06] p-0.5">
            {(["worktree", "staged"] as const).map((side) => (
              <button
                key={side}
                type="button"
                onClick={() => onSideChange(side)}
                className={`flex-1 rounded px-2 py-1 text-[0.58rem] font-semibold transition-colors ${
                  diff?.side === side
                    ? "bg-primary/[0.13] text-primary"
                    : "text-neutral-text-muted hover:bg-white/[0.04] hover:text-neutral-text"
                }`}
                aria-pressed={diff?.side === side}
              >
                {side === "worktree" ? "Working tree" : "Staged"}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-2 text-[0.58rem] text-neutral-text-muted">
          <GitCompareArrows size={13} />
          <span>{diff?.side === "staged" ? "Staged diff" : "Working tree"}</span>
        </div>
      )}

      {!readOnly && change && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-white/[0.06] px-3 py-2">
          {change.index === "clean" && change.worktree !== "clean" && (
            <button
              type="button"
              onClick={() => onStage?.()}
              disabled={actionLoading}
              className="rounded-md border border-emerald-300/20 bg-emerald-300/[0.08] px-2 py-1 text-[0.58rem] font-semibold text-emerald-200 transition-colors hover:bg-emerald-300/[0.14] disabled:opacity-50"
            >
              Stage
            </button>
          )}
          {change.index !== "clean" && (
            <button
              type="button"
              onClick={() => onUnstage?.()}
              disabled={actionLoading}
              className="rounded-md border border-sky-300/20 bg-sky-300/[0.08] px-2 py-1 text-[0.58rem] font-semibold text-sky-200 transition-colors hover:bg-sky-300/[0.14] disabled:opacity-50"
            >
              Unstage
            </button>
          )}
          {actionLoading && <LoaderCircle size={12} className="animate-spin text-primary" />}
          {actionMessage && <span className="text-[0.58rem] text-emerald-200">{actionMessage}</span>}
          {actionError && <span className="truncate text-[0.58rem] text-red-200">{actionError}</span>}
        </div>
      )}

      {loading && !diff && (
        <div className="flex items-center gap-2 px-3 py-4 text-xs text-neutral-text-muted">
          <LoaderCircle size={14} className="animate-spin text-primary" />
          Caricamento diff…
        </div>
      )}

      {!loading && error && <p className="px-3 py-4 text-xs text-red-200">{error}</p>}

      {!error && diff?.binary && (
        <div className="flex items-center gap-2 px-3 py-4 text-xs text-neutral-text-muted">
          <FileDiff size={14} className="text-primary" />
          File binario: la patch non è visualizzabile in linea.
        </div>
      )}

      {!error && !diff?.binary && lines.length === 0 && (
        <p className="px-3 py-4 text-xs leading-relaxed text-neutral-text-muted">
          Nessun diff disponibile per questo lato.
        </p>
      )}

      {!error && !diff?.binary && lines.length > 0 && (
        <pre className="min-h-0 min-w-0 max-w-full flex-1 overflow-x-auto overflow-y-auto px-2 py-2 font-mono text-[0.58rem] leading-relaxed">
          {lines.map((line, index) => (
            <code key={`${index}-${line}`} className={`block whitespace-pre px-1 ${lineClass(line)}`}>
              {line || " "}
            </code>
          ))}
        </pre>
      )}

      {!error && diff?.truncated && (
        <p className="shrink-0 border-t border-amber-300/15 bg-amber-300/[0.05] px-3 py-2 text-[0.6rem] text-amber-100">
          Patch troncata per mantenere fluida la review.
        </p>
      )}

      {!error && diff && !diff.binary && (diff.additions > 0 || diff.deletions > 0) && (
        <div className="flex shrink-0 gap-3 border-t border-white/[0.06] px-3 py-2 font-mono text-[0.58rem]">
          <span className="text-emerald-300">+{diff.additions}</span>
          <span className="text-red-300">-{diff.deletions}</span>
        </div>
      )}
    </section>
  );
}
