import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  FileDiff,
  GitBranch,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  X,
  Upload,
} from "lucide-react";
import { useProjectStore } from "../../stores/projectStore";
import { ProjectDiffViewer } from "./ProjectDiffViewer";
import { changeDetail, changeStatusLabel, changeTone } from "./changePresentation";
import type { ProjectGitChange } from "../../project/types";

interface ProjectGitChangesProps {
  workspaceId: string;
  workspaceName: string;
}

export function ProjectGitChanges({ workspaceId, workspaceName }: ProjectGitChangesProps) {
  const workspaceState = useProjectStore((state) => state.workspaces[workspaceId]);
  const ensureWorkspace = useProjectStore((state) => state.ensureWorkspace);
  const refreshGitStatus = useProjectStore((state) => state.refreshGitStatus);
  const loadDiff = useProjectStore((state) => state.loadDiff);
  const clearDiff = useProjectStore((state) => state.clearDiff);
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
  const gitActionLoading = workspaceState?.gitActionLoading ?? false;
  const gitActionError = workspaceState?.gitActionError ?? null;
  const gitActionMessage = workspaceState?.gitActionMessage ?? null;
  const selectedPath = workspaceState?.selectedPath ?? null;
  const revision = workspaceState?.revision ?? 0;
  const [commitMessage, setCommitMessage] = useState("");

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

  useEffect(() => {
    ensureWorkspace(workspaceId);
    void refreshGitStatus(workspaceId);
  }, [ensureWorkspace, refreshGitStatus, workspaceId]);

  const runDiscard = (paths: string[], label: string) => {
    if (!paths.length) return;
    if (window.confirm(`Scartare ${label}? Questa operazione non è annullabile.`)) {
      void discardPaths(workspaceId, paths);
    }
  };

  const selectChange = (change: ProjectGitChange) => {
    selectPath(workspaceId, change.path);
  };

  const handleCommit = () => {
    if (!commitMessage.trim() || !stagedChanges.length || gitActionLoading) return;
    void commitStaged(workspaceId, commitMessage, stagedChanges.map((change) => change.path));
    setCommitMessage("");
  };

  useEffect(() => {
    if (!selectedPath) return;
    const selectedChange = changes.find((change) => change.path === selectedPath);
    if (!selectedChange) {
      clearDiff(workspaceId);
      return;
    }
    const side = selectedChange.worktree !== "clean" ? "worktree" : "staged";
    void loadDiff(workspaceId, selectedPath, side);
  }, [changes, clearDiff, loadDiff, revision, selectedPath, workspaceId]);

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
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left ${
            selectedPath === change.path ? "bg-primary/[0.12] text-neutral-text" : "text-neutral-text-dim"
          }`}
          title={changeDetail(change)}
          aria-selected={selectedPath === change.path}
        >
          <FileDiff size={14} className="shrink-0 text-neutral-text-muted" />
          <span className="min-w-0 flex-1 truncate whitespace-nowrap text-[0.7rem]">{change.path}</span>
          <span
            className={`shrink-0 rounded border px-1 py-0.5 font-mono text-[0.52rem] font-bold leading-none ${changeTone(change)}`}
          >
            {changeStatusLabel(change)}
          </span>
        </button>
        <button
          type="button"
          onClick={() => void (staged ? unstagePaths(workspaceId, [change.path]) : stagePaths(workspaceId, [change.path]))}
          disabled={gitActionLoading}
          className="ui-icon-button h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30"
          title={staged ? "Rimuovi dallo stage" : "Aggiungi allo stage"}
          aria-label={staged ? `Rimuovi ${change.path} dallo stage` : `Aggiungi ${change.path} allo stage`}
        >
          {staged ? <Minus size={13} /> : <Plus size={13} />}
        </button>
        {canDiscard && (
          <button
            type="button"
            onClick={() => runDiscard([change.path], `le modifiche di ${change.path}`)}
            disabled={gitActionLoading}
            className="ui-icon-button h-7 w-7 shrink-0 text-red-300/70 opacity-0 transition-opacity hover:text-red-200 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30"
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
        <div className="border-b border-white/[0.06] px-4 pb-3 pt-4">
          <p className="eyebrow text-[0.58rem]">Source control</p>
          <h2 className="mt-1 truncate text-[0.95rem] font-bold text-neutral-text">Git changes</h2>
          <p className="mt-1 truncate text-[0.68rem] text-neutral-text-muted">{workspaceName}</p>
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
      <div className="shrink-0 border-b border-white/[0.06] bg-black/[0.06] px-4 pb-3 pt-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="eyebrow text-[0.58rem]">Source control</p>
            <h2 className="mt-1 truncate text-[0.95rem] font-bold text-neutral-text">Git changes</h2>
            <div className="mt-1 flex min-w-0 items-center gap-2 text-[0.64rem] text-neutral-text-muted">
              <GitBranch size={12} className="shrink-0 text-sky-300" />
              <span className="truncate font-mono">{gitStatus.branch ?? "detached"}</span>
              {gitStatus.upstream ? (
                <span className="truncate text-neutral-text-muted/70">→ {gitStatus.upstream}</span>
              ) : (
                <span className="text-amber-200/75">no upstream</span>
              )}
              {gitStatus.ahead > 0 && <span className="shrink-0 text-primary">↑{gitStatus.ahead} da inviare</span>}
              {gitStatus.behind > 0 && <span className="shrink-0 text-sky-200">↓{gitStatus.behind} da scaricare</span>}
              {gitLoading && <LoaderCircle size={11} className="shrink-0 animate-spin text-primary" />}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void refreshGitStatus(workspaceId)}
            className="ui-icon-button h-8 w-8 shrink-0"
            title="Aggiorna stato Git"
            aria-label="Aggiorna stato Git"
          >
            <RefreshCw size={14} className={gitLoading ? "animate-spin" : ""} />
          </button>
        </div>

        <div className="mt-3 min-w-0 overflow-hidden rounded-lg border border-white/[0.08] bg-black/[0.14] p-2">
          <div className="flex min-w-0 gap-1.5">
            <input
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.ctrlKey) handleCommit();
              }}
              placeholder={`Messaggio commit (Ctrl+Enter su ${gitStatus.branch ?? "branch"})`}
              className="w-0 min-w-0 flex-1 rounded-md border border-white/[0.09] bg-black/20 px-2.5 py-2 text-[0.68rem] text-neutral-text outline-none placeholder:text-neutral-text-muted focus:border-primary/60"
              aria-label="Messaggio commit"
            />
            {showSyncAfterCommit ? (
              <button
                type="button"
                onClick={() => void syncGit(workspaceId, "push")}
                disabled={gitActionLoading}
                className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 text-[0.62rem] font-bold text-neutral-bg transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-35"
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
                className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 text-[0.62rem] font-bold text-neutral-bg transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-35"
                title={stagedChanges.length ? "Crea commit" : "Metti prima almeno un file in stage"}
              >
                <Check size={13} />
                Commit
              </button>
            )}
          </div>
          <p className="mt-1.5 px-0.5 text-[0.55rem] text-neutral-text-muted">
            {showSyncAfterCommit
              ? "Commit creato localmente. Premi Sync changes per fare push."
              : stagedChanges.length
                ? `${stagedChanges.length} ${stagedChanges.length === 1 ? "file pronto" : "file pronti"} per il commit`
                : "Metti in stage almeno un file per creare un commit"}
          </p>
        </div>

        <div className="mt-2 flex items-center gap-1.5">
          <span className="flex-1 text-[0.62rem] text-neutral-text-muted">
            {changes.length === 0 ? "Working tree pulito" : `${changes.length} ${changes.length === 1 ? "modifica" : "modifiche"}`}
          </span>
        </div>
        {(gitActionMessage || gitActionError) && (
          <p className={`mt-1.5 truncate text-[0.58rem] ${gitActionError ? "text-red-200" : "text-emerald-200"}`}>
            {gitActionError ?? gitActionMessage}
          </p>
        )}
      </div>

      {gitError && <p className="shrink-0 border-b border-amber-300/15 bg-amber-300/[0.05] px-4 py-2 text-[0.62rem] text-amber-100">{gitError}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <ChangeGroup
          label="Staged Changes"
          changes={stagedChanges}
          emptyLabel="Nessun file staged"
          actionLabel="Rimuovi tutti dallo stage"
          onAction={() => void unstagePaths(workspaceId, stagedChanges.map((change) => change.path))}
          actionIcon={<Minus size={13} />}
          actionDisabled={!stagedChanges.length || gitActionLoading}
          renderChange={(change) => renderChangeRow(change, true)}
        />
        <ChangeGroup
          label="Changes"
          changes={workingChanges}
          emptyLabel="Nessuna modifica non staged"
          actionLabel="Stage tutte"
          onAction={() => void stagePaths(workspaceId, workingChanges.map((change) => change.path))}
          actionIcon={<Plus size={13} />}
          actionDisabled={!workingChanges.length || gitActionLoading}
          renderChange={(change) => renderChangeRow(change, false)}
        />
      </div>

      {(diff || diffLoading || diffError) && (
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
          onDiscard={() => {
            const selectedChange = selectedPath
              ? changes.find((change) => change.path === selectedPath)
              : undefined;
            if (selectedChange && selectedChange.worktree !== "clean") {
              runDiscard([selectedChange.path], `le modifiche di ${selectedChange.path}`);
            }
          }}
        />
      )}
    </section>
  );
}

interface ChangeGroupProps {
  label: string;
  changes: ProjectGitChange[];
  emptyLabel: string;
  actionLabel: string;
  onAction: () => void;
  actionIcon: ReactNode;
  actionDisabled: boolean;
  renderChange: (change: ProjectGitChange) => ReactNode;
}

function ChangeGroup({
  label,
  changes,
  emptyLabel,
  actionLabel,
  onAction,
  actionIcon,
  actionDisabled,
  renderChange,
}: ChangeGroupProps) {
  return (
    <section className="mb-3 rounded-lg border border-white/[0.07] bg-black/[0.11] p-1.5 last:mb-0">
      <div className="mb-1 flex items-center gap-1.5 px-1">
        <span className="flex-1 text-[0.62rem] font-bold uppercase tracking-[0.12em] text-neutral-text-muted">
          {label}
          <span className="ml-1 font-mono text-primary">{changes.length}</span>
        </span>
        <button
          type="button"
          onClick={onAction}
          disabled={actionDisabled}
          className="ui-icon-button h-6 w-6 text-neutral-text-muted hover:text-neutral-text disabled:cursor-not-allowed disabled:opacity-25"
          title={actionLabel}
          aria-label={actionLabel}
        >
          {actionIcon}
        </button>
      </div>
      {changes.length ? (
        <div className="space-y-0.5">{changes.map(renderChange)}</div>
      ) : (
        <p className="px-2 py-2 text-[0.65rem] text-neutral-text-muted">{emptyLabel}</p>
      )}
    </section>
  );
}
