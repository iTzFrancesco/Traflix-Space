import {
  FileDiff,
  GitCompareArrows,
  LoaderCircle,
  X,
} from "lucide-react";
import type {
  DiffSide,
  ProjectGitChange,
  ProjectGitDiff,
} from "../../project/types";

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
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-neutral-text-muted";
  }
  if (line.startsWith("+")) return "bg-emerald-400/[0.06] text-emerald-200";
  if (line.startsWith("-")) return "bg-red-400/[0.06] text-red-200";
  if (line.startsWith("@@")) return "bg-sky-400/[0.06] text-sky-200";
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
    <section className="mx-2 flex h-[46%] max-h-[420px] min-h-[180px] min-w-0 max-w-[calc(100%-1rem)] shrink-0 flex-col overflow-hidden border border-neutral-border bg-neutral-darkest">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-border px-2.5">
        <FileDiff size={13} className="shrink-0 text-primary" />
        <p className="min-w-0 flex-1 truncate font-mono text-[10px] text-neutral-text" title={diff?.path}>
          {diff?.path ?? "Review diff"}
        </p>
        <span className="shrink-0 text-[9px] text-neutral-text-muted">
          {readOnly ? "read only" : diff?.side === "staged" ? "staged" : "working tree"}
        </span>
        {loading && <LoaderCircle size={12} className="status-icon--spin text-primary" />}
        <button
          type="button"
          onClick={onClose}
          className="ui-icon-button h-7 w-7 shrink-0"
          title="Close diff"
          aria-label="Close diff"
        >
          <X size={12} />
        </button>
      </div>

      {showSideToggle && (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-neutral-border px-2.5">
          <GitCompareArrows size={12} className="mr-1 text-neutral-text-muted" />
          {(["worktree", "staged"] as const).map((side) => (
            <button
              key={side}
              type="button"
              onClick={() => onSideChange(side)}
              className={`h-6 px-2 text-[9px] font-semibold transition-colors ${
                diff?.side === side
                  ? "bg-primary/[0.10] text-primary"
                  : "text-neutral-text-muted hover:bg-white/[0.035] hover:text-neutral-text"
              }`}
              aria-pressed={diff?.side === side}
            >
              {side === "worktree" ? "Working tree" : "Staged"}
            </button>
          ))}
        </div>
      )}

      {!readOnly && change && (
        <div className="flex min-h-8 shrink-0 items-center gap-2 border-b border-neutral-border px-2.5 py-1">
          {change.index === "clean" && change.worktree !== "clean" && (
            <button
              type="button"
              onClick={() => onStage?.()}
              disabled={actionLoading}
              className="text-[9px] font-semibold text-signal hover:underline disabled:opacity-40"
            >
              Stage
            </button>
          )}
          {change.index !== "clean" && (
            <button
              type="button"
              onClick={() => onUnstage?.()}
              disabled={actionLoading}
              className="text-[9px] font-semibold text-sky-200 hover:underline disabled:opacity-40"
            >
              Unstage
            </button>
          )}
          {actionLoading && <LoaderCircle size={11} className="status-icon--spin text-primary" />}
          {actionMessage && (
            <span className="truncate text-[9px] text-signal">{actionMessage}</span>
          )}
          {actionError && (
            <span className="truncate text-[9px] text-danger">{actionError}</span>
          )}
        </div>
      )}

      {loading && !diff && (
        <div className="flex items-center gap-2 px-3 py-4 text-xs text-neutral-text-muted">
          <LoaderCircle size={13} className="status-icon--spin text-primary" />
          Loading diff…
        </div>
      )}

      {!loading && error && (
        <p className="px-3 py-4 text-xs text-danger">{error}</p>
      )}

      {!error && diff?.binary && (
        <div className="flex items-center gap-2 px-3 py-4 text-xs text-neutral-text-muted">
          <FileDiff size={13} className="text-primary" />
          Binary file — inline patch unavailable.
        </div>
      )}

      {!error && !diff?.binary && lines.length === 0 && (
        <p className="px-3 py-4 text-xs leading-relaxed text-neutral-text-muted">
          No diff available for this side.
        </p>
      )}

      {!error && !diff?.binary && lines.length > 0 && (
        <pre className="min-h-0 min-w-0 max-w-full flex-1 overflow-x-auto overflow-y-auto px-1.5 py-1.5 font-mono text-[9px] leading-relaxed">
          {lines.map((line, index) => (
            <code
              key={`${index}-${line}`}
              className={`block whitespace-pre px-1 ${lineClass(line)}`}
            >
              {line || " "}
            </code>
          ))}
        </pre>
      )}

      {!error && diff?.truncated && (
        <p className="shrink-0 border-t border-warning/20 px-2.5 py-1.5 text-[9px] text-warning">
          Patch truncated to keep review responsive.
        </p>
      )}

      {!error &&
        diff &&
        !diff.binary &&
        (diff.additions > 0 || diff.deletions > 0) && (
          <div className="flex h-7 shrink-0 items-center gap-3 border-t border-neutral-border px-2.5 font-mono text-[9px]">
            <span className="text-signal">+{diff.additions}</span>
            <span className="text-danger">-{diff.deletions}</span>
          </div>
        )}
    </section>
  );
}
