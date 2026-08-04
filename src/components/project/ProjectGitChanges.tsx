import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  GitBranch,
  LoaderCircle,
  Minus,
  Plus,
  X,
  Upload,
} from "lucide-react";
import { useProjectStore } from "../../stores/projectStore";
import { useUIStore } from "../../stores/uiStore";
import { ProjectDiffViewer } from "./ProjectDiffViewer";
import { ProjectFilePreview } from "./ProjectFilePreview";
import { changeDetail, changeStatusCode, changeTone } from "./changePresentation";
import { getFileIcon, isPreviewableImage } from "./fileIcons";
import type { ProjectGitChange } from "../../project/types";

interface ProjectGitChangesProps {
  workspaceId: string;
  workspaceName: string;
}

interface PendingDiscard {
  paths: string[];
  label: string;
  untracked: boolean;
}

export function ProjectGitChanges({ workspaceId, workspaceName }: ProjectGitChangesProps) {
  const workspaceState = useProjectStore((state) => state.workspaces[workspaceId]);
  const isGitView = useUIStore((state) => state.rightPanelActiveView === "git");
  const loadDiff = useProjectStore((state) => state.loadDiff);
  const clearDiff = useProjectStore((state) => state.clearDiff);
  const loadFilePreview = useProjectStore((state) => state.loadFilePreview);
  const clearPreview = useProjectStore((state) => state.clearPreview);
  const stagePaths = useProjectStore((state) => state.stagePaths);
  const unstagePaths = useProjectStore((state) => state.unstagePaths);
  const discardPaths = useProjectStore((state) => state.discardPaths);
  const commitStaged = useProjectStore((state) => state.commitStaged);
  const syncGit = useProjectStore((state) => state.syncGit);
  const selectPath = useProjectStore((state) => state.selectPath);

  const gitStatus = workspaceState?.gitStatus;
  const changes = gitStatus?.changes ?? [];
  const gitLoading = workspaceState?.gitLoading ?? false;
  const gitError = workspaceState?.gitError;
  const diff = workspaceState?.diff ?? null;
  const diffLoading = workspaceState?.diffLoading ?? false;
  const diffError = workspaceState?.diffError ?? null;
  const preview = workspaceState?.preview ?? null;
  const previewLoading = workspaceState?.previewLoading ?? false;
  const previewError = workspaceState?.previewError ?? null;
  const gitActionLoading = workspaceState?.gitActionLoading ?? false;
  const gitActionError = workspaceState?.gitActionError ?? null;
  const gitActionMessage = workspaceState?.gitActionMessage ?? null;
  const selectedPath = workspaceState?.selectedPath ?? null;
  const revision = workspaceState?.revision ?? 0;
  const [commitMessage, setCommitMessage] = useState("");
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);

  const stagedChanges = useMemo(
    () => changes.filter((change) => change.index !== "clean"),
    [changes],
  );
  const workingChanges = useMemo(
    () => changes.filter((change) => change.worktree !== "clean"),
    [changes],
  );
  const canSync = Boolean(gitStatus?.upstream && gitStatus.ahead > 0);
  const showSyncAfterCommit = gitActionMessage === "Commit creato" && canSync && !gitActionLoading;

  const requestDiscard = (change: ProjectGitChange) => {
    setPendingDiscard({
      paths: [change.path],
      label: change.path,
      untracked: change.untracked,
    });
  };

  const selectChange = (change: ProjectGitChange) => {
    if (selectedPath === change.path) {
      if (isPreviewableImage(change.path)) {
        void loadFilePreview(workspaceId, change.path);
      } else {
        const side = change.worktree !== "clean" ? "worktree" : "staged";
        void loadDiff(workspaceId, change.path, side);
      }
      return;
    }
    selectPath(workspaceId, change.path);
  };

  const handleCommit = () => {
    if (!commitMessage.trim() || !stagedChanges.length || gitActionLoading) return;
    void commitStaged(workspaceId, commitMessage, stagedChanges.map((change) => change.path));
    setCommitMessage("");
  };

  useEffect(() => {
    if (!isGitView || !selectedPath) return;
    const selectedChange = changes.find((change) => change.path === selectedPath);
    if (!selectedChange) {
      clearDiff(workspaceId);
      clearPreview(workspaceId);
      return;
    }
    if (isPreviewableImage(selectedPath)) {
      void loadFilePreview(workspaceId, selectedPath);
      return;
    }
    const side = selectedChange.worktree !== "clean" ? "worktree" : "staged";
    void loadDiff(workspaceId, selectedPath, side);
  }, [changes, clearDiff, clearPreview, isGitView, loadDiff, loadFilePreview, revision, selectedPath, workspaceId]);

  const renderChangeRow = (change: ProjectGitChange, staged: boolean) => {
    const canDiscard = change.worktree !== "clean";
    return (
      <div
        key={`${staged ? "staged" : "changes"}-${change.path}`}
        className="group flex min-w-0 items-center gap-1 rounded-md transition-colors hover:bg-white/[0.055]"
      >
        <button
          type="button"
          onClick={() => selectChange(change)}
          className={`flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-2 text-left ${
            selectedPath === change.path ? "bg-primary/[0.12] text-neutral-text" : "text-neutral-text-dim"
          }`}
          title={changeDetail(change)}
          aria-selected={selectedPath === change.path}
        >
          {(() => {
            const Icon = getFileIcon(change.path);
            return <Icon size={14} className={`shrink-0 ${staged ? "text-signal" : "text-primary"}`} />;
          })()}
          <span className="min-w-0 flex-1 truncate whitespace-nowrap text-[0.76rem]" title={change.path}>
            <span className="text-neutral-text">{change.path.split("/").pop()}</span>
            {change.path.includes("/") && (
              <span className="ml-1 text-[0.64rem] text-neutral-text-muted">{change.path.slice(0, change.path.lastIndexOf("/"))}</span>
            )}
          </span>
          <span
            className={`shrink-0 rounded border px-1.5 py-1 font-mono text-[0.64rem] font-bold leading-none ${changeTone(change)}`}
          >
            {changeStatusCode(change, staged)}
          </span>
        </button>
        <button
          type="button"
          onClick={() => void (staged ? unstagePaths(workspaceId, [change.path]) : stagePaths(workspaceId, [change.path]))}
          disabled={gitActionLoading}
          className={`ui-icon-button h-8 w-8 shrink-0 border transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30 ${
            staged
              ? "border-sky-300/20 bg-sky-300/[0.08] text-sky-200 hover:bg-sky-300/[0.16]"
              : "border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-200 hover:bg-emerald-300/[0.16]"
          }`}
          title={staged ? "Rimuovi dallo stage" : "Aggiungi allo stage"}
          aria-label={staged ? `Rimuovi ${change.path} dallo stage` : `Aggiungi ${change.path} allo stage`}
        >
          {staged ? <Minus size={13} /> : <Plus size={13} />}
        </button>
        {canDiscard && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              requestDiscard(change);
            }}
            disabled={gitActionLoading}
            className="ui-icon-button h-8 w-8 shrink-0 border border-red-300/20 bg-red-300/[0.08] text-red-300/80 opacity-0 transition-colors hover:bg-red-300/[0.16] hover:text-red-200 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30"
            title="Scarta modifiche"
            aria-label={`Scarta modifiche di ${change.path}`}
          >
            <X size={12} />
          </button>
        )}
      </div>
    );
  };

  if (!workspaceState || gitLoading || gitStatus?.repositoryState !== "repository") {
    return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-b border-white/[0.06] px-4 pb-3 pt-4 text-center">
          <h2 className="truncate text-[0.95rem] font-bold text-neutral-text">Changes</h2>
          <p className="mt-1 truncate text-[0.64rem] text-neutral-text-muted">{workspaceName}</p>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <GitBranch size={28} className="mb-3 text-neutral-text-muted" strokeWidth={1.3} />
          {gitLoading || !gitStatus ? (
            <>
              <p className="text-sm font-semibold text-neutral-text">Lettura stato Git…</p>
              <LoaderCircle size={15} className="mx-auto mt-3 animate-spin text-primary" />
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-neutral-text">
                {gitStatus.repositoryState === "unavailable" ? "Git non disponibile" : "Repository non rilevata"}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-neutral-text-muted">
                {gitError ?? "Questa workspace non contiene una repository Git."}
              </p>
            </>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-white/[0.06] bg-black/[0.06] px-4 pb-4 pt-5">
        <div className="relative min-w-0 text-center">
          <h2 className="truncate text-[1.05rem] font-bold leading-tight text-neutral-text">Changes</h2>
          <p className="mt-1 truncate text-[0.68rem] text-neutral-text-muted">{workspaceName}</p>
          <div className="mt-3 flex min-w-0 items-center justify-center gap-2 text-[0.66rem] text-neutral-text-muted">
            <GitBranch size={12} className="shrink-0 text-sky-300" />
            <span className="truncate rounded bg-white/[0.05] px-1.5 py-0.5 font-mono text-[0.6rem] text-neutral-text">
              {gitStatus.branch ?? "detached"}
            </span>
            {gitStatus.upstream && (
              <span className="truncate text-neutral-text-muted/70" title={gitStatus.upstream}>
                ↔
              </span>
            )}
            {gitStatus.ahead > 0 && (
              <span className="shrink-0 text-primary" title="Commit da inviare">
                ↑{gitStatus.ahead}
              </span>
            )}
            {gitStatus.behind > 0 && (
              <span className="shrink-0 text-sky-200" title="Commit da scaricare">
                ↓{gitStatus.behind}
              </span>
            )}
            {gitLoading && <LoaderCircle size={11} className="shrink-0 animate-spin text-primary" />}
          </div>
        </div>

        <div className="mt-4 min-w-0 overflow-hidden rounded-lg border border-white/[0.08] bg-black/[0.14] p-3">
          <div className="flex min-w-0 gap-2">
            <input
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.ctrlKey) handleCommit();
              }}
              placeholder="Messaggio commit…"
              className="h-10 w-0 min-w-0 flex-1 rounded-md border border-white/[0.09] bg-black/20 px-3 text-[0.72rem] text-neutral-text outline-none placeholder:text-neutral-text-muted focus:border-primary/60"
              aria-label="Messaggio commit"
            />
            {showSyncAfterCommit ? (
              <button
                type="button"
                onClick={() => void syncGit(workspaceId, "push")}
                disabled={gitActionLoading}
                className="flex min-h-10 shrink-0 items-center gap-1 rounded-md bg-primary px-3 text-[0.68rem] font-bold text-neutral-bg transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-35"
                title="Invia il commit al remote"
              >
                <Upload size={13} />
                Sync changes
              </button>
            ) : (
              <button
                type="button"
                onClick={handleCommit}
                disabled={!commitMessage.trim() || !stagedChanges.length || gitActionLoading}
                className="flex min-h-10 shrink-0 items-center gap-1 rounded-md bg-primary px-3 text-[0.68rem] font-bold text-neutral-bg transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-35"
                title={stagedChanges.length ? "Crea commit" : "Metti prima almeno un file in stage"}
              >
                <Check size={13} />
                Commit
              </button>
            )}
          </div>
          {(showSyncAfterCommit || stagedChanges.length > 0) && (
            <p className="mt-2 px-0.5 text-[0.62rem] text-neutral-text-muted">
              {showSyncAfterCommit ? "Commit locale pronto per il push." : `${stagedChanges.length} staged`}
            </p>
          )}
        </div>
        {(gitActionMessage || gitActionError) && (
          <p className={`mt-2 truncate text-[0.62rem] ${gitActionError ? "text-red-200" : "text-emerald-200"}`}>
            {gitActionError ?? gitActionMessage}
          </p>
        )}
      </div>

      {gitError && <p className="shrink-0 border-b border-amber-300/15 bg-amber-300/[0.05] px-4 py-2 text-[0.62rem] text-amber-100">{gitError}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <ChangeGroup
          label="STAGED"
          changes={stagedChanges}
          actionLabel="Rimuovi tutti dallo stage"
          onAction={() => void unstagePaths(workspaceId, stagedChanges.map((change) => change.path))}
          actionIcon={<Minus size={13} />}
          actionDisabled={!stagedChanges.length || gitActionLoading}
          renderChange={(change) => renderChangeRow(change, true)}
        />
        <ChangeGroup
          label="CHANGES"
          changes={workingChanges}
          actionLabel="Stage tutte"
          onAction={() => void stagePaths(workspaceId, workingChanges.map((change) => change.path))}
          actionIcon={<Plus size={13} />}
          actionDisabled={!workingChanges.length || gitActionLoading}
          renderChange={(change) => renderChangeRow(change, false)}
        />
      </div>

      {isPreviewableImage(selectedPath ?? "") && (preview || previewLoading || previewError) && (
        <ProjectFilePreview
          preview={preview}
          loading={previewLoading}
          error={previewError}
          onClose={() => clearPreview(workspaceId)}
        />
      )}

      {!isPreviewableImage(selectedPath ?? "") && (diff || diffLoading || diffError) && (
        <ProjectDiffViewer
          diff={diff}
          loading={diffLoading}
          error={diffError}
          change={selectedPath ? changes.find((change) => change.path === selectedPath) ?? null : null}
          actionLoading={gitActionLoading}
          actionError={gitActionError}
          actionMessage={gitActionMessage}
          showSideToggle={false}
          onClose={() => clearDiff(workspaceId)}
          onSideChange={(side) => {
            if (selectedPath) void loadDiff(workspaceId, selectedPath, side);
          }}
          onStage={() => {
            if (selectedPath) void stagePaths(workspaceId, [selectedPath]);
          }}
          onUnstage={() => {
            if (selectedPath) void unstagePaths(workspaceId, [selectedPath]);
          }}
        />
      )}

      {pendingDiscard && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-4">
          <div
            className="w-full max-w-[340px] rounded-xl border border-red-300/25 bg-neutral-elevated p-4 shadow-xl"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="discard-confirm-title"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-300/[0.12] text-red-200">
                <AlertTriangle size={17} />
              </div>
              <div className="min-w-0">
                <h3 id="discard-confirm-title" className="text-sm font-bold text-neutral-text">
                  {pendingDiscard.untracked ? "Eliminare il file?" : "Scartare la modifica?"}
                </h3>
                <p className="mt-1 break-words text-xs leading-relaxed text-neutral-text-muted">
                  {pendingDiscard.untracked
                    ? `“${pendingDiscard.label}” verrà rimosso dalla workspace.`
                    : `Le modifiche locali a “${pendingDiscard.label}” verranno ripristinate.`}
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDiscard(null)}
                className="rounded-md border border-white/[0.1] bg-white/[0.04] px-3 py-2 text-[0.68rem] font-semibold text-neutral-text-muted transition-colors hover:bg-white/[0.08] hover:text-neutral-text"
              >
                Annulla
              </button>
              <button
                type="button"
                onClick={() => {
                  const discard = pendingDiscard;
                  setPendingDiscard(null);
                  void discardPaths(workspaceId, discard.paths);
                }}
                className="rounded-md border border-red-300/30 bg-red-400/[0.16] px-3 py-2 text-[0.68rem] font-bold text-red-100 transition-colors hover:bg-red-400/[0.25]"
              >
                Scarta definitivamente
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

interface ChangeGroupProps {
  label: string;
  changes: ProjectGitChange[];
  actionLabel: string;
  onAction: () => void;
  actionIcon: ReactNode;
  actionDisabled: boolean;
  renderChange: (change: ProjectGitChange) => ReactNode;
}

function ChangeGroup({
  label,
  changes,
  actionLabel,
  onAction,
  actionIcon,
  actionDisabled,
  renderChange,
}: ChangeGroupProps) {
  return (
    <section className="mb-3 border-b border-white/[0.07] pb-3 last:mb-0 last:border-b-0">
      <div className="mb-2 flex items-center gap-1.5 px-1">
        <div className="flex flex-1 items-center gap-2">
          <span className="text-[0.72rem] font-bold uppercase tracking-[0.14em] text-neutral-text">
            {label}
          </span>
          <span className="inline-flex min-w-5 items-center justify-center rounded border border-primary/30 bg-primary/[0.12] px-1.5 py-0.5 font-mono text-[0.66rem] font-bold leading-none text-primary">
            {changes.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onAction}
          disabled={actionDisabled}
          className={`ui-icon-button h-8 w-8 border transition-colors disabled:cursor-not-allowed disabled:opacity-25 ${
            label === "STAGED"
              ? "border-sky-300/20 bg-sky-300/[0.08] text-sky-200 hover:bg-sky-300/[0.16]"
              : "border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-200 hover:bg-emerald-300/[0.16]"
          }`}
          title={actionLabel}
          aria-label={actionLabel}
        >
          {actionIcon}
        </button>
      </div>
      {changes.length ? (
        <div className="space-y-0.5">{changes.map(renderChange)}</div>
      ) : null}
    </section>
  );
}
