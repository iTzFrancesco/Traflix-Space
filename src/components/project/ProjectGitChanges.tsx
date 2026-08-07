import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  GitBranch,
  LoaderCircle,
  Minus,
  Plus,
  Upload,
  X,
} from "lucide-react";
import { useProjectStore } from "../../stores/projectStore";
import { useUIStore } from "../../stores/uiStore";
import { ProjectDiffViewer } from "./ProjectDiffViewer";
import { ProjectFilePreview } from "./ProjectFilePreview";
import {
  changeDetail,
  changeStatusCode,
  changeTone,
} from "./changePresentation";
import { getFileIcon, isPreviewableImage } from "./fileIcons";
import type { DiffSide, ProjectGitChange } from "../../project/types";

interface ProjectGitChangesProps {
  workspaceId: string;
  workspaceName: string;
}

interface PendingDiscard {
  paths: string[];
  label: string;
  untracked: boolean;
}

interface SelectedGitRow {
  path: string;
  side: DiffSide;
}

function availableSide(change: ProjectGitChange, preferred: DiffSide): DiffSide {
  if (preferred === "staged" && change.index !== "clean") return "staged";
  if (preferred === "worktree" && change.worktree !== "clean") return "worktree";
  return change.worktree !== "clean" ? "worktree" : "staged";
}

export function ProjectGitChanges({
  workspaceId,
  workspaceName,
}: ProjectGitChangesProps) {
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
  const [selectedRow, setSelectedRow] = useState<SelectedGitRow | null>(null);

  const stagedChanges = useMemo(
    () => changes.filter((change) => change.index !== "clean"),
    [changes],
  );
  const workingChanges = useMemo(
    () => changes.filter((change) => change.worktree !== "clean"),
    [changes],
  );
  const canSync = Boolean(gitStatus?.upstream && gitStatus.ahead > 0);
  const showSyncAfterCommit =
    gitActionMessage === "Commit creato" && canSync && !gitActionLoading;

  const requestDiscard = (change: ProjectGitChange) => {
    setPendingDiscard({
      paths: [change.path],
      label: change.path,
      untracked: change.untracked,
    });
  };

  const selectChange = (change: ProjectGitChange, stagedRow: boolean) => {
    const side: DiffSide = stagedRow ? "staged" : "worktree";
    setSelectedRow({ path: change.path, side });

    if (selectedPath === change.path) {
      if (isPreviewableImage(change.path)) {
        void loadFilePreview(workspaceId, change.path);
      } else {
        void loadDiff(workspaceId, change.path, availableSide(change, side));
      }
      return;
    }
    selectPath(workspaceId, change.path);
  };

  const handleCommit = () => {
    if (!commitMessage.trim() || !stagedChanges.length || gitActionLoading) return;
    void commitStaged(
      workspaceId,
      commitMessage,
      stagedChanges.map((change) => change.path),
    );
    setCommitMessage("");
  };

  useEffect(() => {
    if (!isGitView || !selectedPath) return;
    const selectedChange = changes.find((change) => change.path === selectedPath);
    if (!selectedChange) {
      clearDiff(workspaceId);
      clearPreview(workspaceId);
      setSelectedRow(null);
      return;
    }
    if (isPreviewableImage(selectedPath)) {
      void loadFilePreview(workspaceId, selectedPath);
      return;
    }

    const preferred =
      selectedRow?.path === selectedPath
        ? selectedRow.side
        : selectedChange.worktree !== "clean"
          ? "worktree"
          : "staged";
    const side = availableSide(selectedChange, preferred);
    if (selectedRow?.path === selectedPath && selectedRow.side !== side) {
      setSelectedRow({ path: selectedPath, side });
    }
    void loadDiff(workspaceId, selectedPath, side);
  }, [
    changes,
    clearDiff,
    clearPreview,
    isGitView,
    loadDiff,
    loadFilePreview,
    revision,
    selectedPath,
    selectedRow,
    workspaceId,
  ]);

  const renderChangeRow = (change: ProjectGitChange, staged: boolean) => {
    const canDiscard = change.worktree !== "clean";
    const Icon = getFileIcon(change.path);
    const slash = change.path.lastIndexOf("/");
    const filename = slash >= 0 ? change.path.slice(slash + 1) : change.path;
    const directory = slash >= 0 ? change.path.slice(0, slash) : "";
    const rowSide: DiffSide = staged ? "staged" : "worktree";
    const selected =
      selectedPath === change.path &&
      (selectedRow?.path !== change.path || selectedRow.side === rowSide);

    return (
      <div
        key={`${staged ? "staged" : "changes"}-${change.path}`}
        className="group flex min-w-0 items-center border-b border-neutral-border-light last:border-b-0"
      >
        <button
          type="button"
          onClick={() => selectChange(change, staged)}
          className={`flex min-h-9 min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left transition-colors ${
            selected
              ? "bg-primary/[0.08] text-neutral-text"
              : "text-neutral-text-dim hover:bg-white/[0.025]"
          }`}
          title={changeDetail(change)}
          aria-selected={selected}
        >
          <Icon
            size={13}
            className={`shrink-0 ${staged ? "text-signal" : "text-primary"}`}
          />
          <span className="min-w-0 flex-1 truncate text-[11px]">
            <span className="text-neutral-text">{filename}</span>
            {directory && (
              <span className="ml-1.5 font-mono text-[9px] text-neutral-text-muted">
                {directory}
              </span>
            )}
          </span>
          <span
            className={`shrink-0 font-mono text-[9px] font-bold ${changeTone(change)}`}
          >
            {changeStatusCode(change, staged)}
          </span>
        </button>

        <button
          type="button"
          onClick={() =>
            void (staged
              ? unstagePaths(workspaceId, [change.path])
              : stagePaths(workspaceId, [change.path]))
          }
          disabled={gitActionLoading}
          className="ui-icon-button h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-30"
          title={staged ? "Unstage" : "Stage"}
          aria-label={staged ? `Unstage ${change.path}` : `Stage ${change.path}`}
        >
          {staged ? <Minus size={12} /> : <Plus size={12} />}
        </button>

        {canDiscard && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              requestDiscard(change);
            }}
            disabled={gitActionLoading}
            className="ui-icon-button h-7 w-7 shrink-0 text-neutral-text-muted opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger disabled:opacity-30"
            title="Discard changes"
            aria-label={`Discard changes in ${change.path}`}
          >
            <X size={12} />
          </button>
        )}
      </div>
    );
  };

  if (
    !workspaceState ||
    (!gitStatus && gitLoading) ||
    gitStatus?.repositoryState !== "repository"
  ) {
    return (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-b border-neutral-border px-3 py-3">
          <h2 className="truncate text-xs font-semibold text-neutral-text">Changes</h2>
          <p className="mt-1 truncate text-[10px] text-neutral-text-muted">
            {workspaceName}
          </p>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <GitBranch size={24} className="text-neutral-text-muted" strokeWidth={1.4} />
          {gitLoading || !gitStatus ? (
            <div className="mt-3 flex items-center gap-2 text-xs text-neutral-text-muted">
              <LoaderCircle size={13} className="status-icon--spin" /> Reading Git…
            </div>
          ) : (
            <>
              <p className="mt-3 text-xs font-semibold text-neutral-text">
                {gitStatus.repositoryState === "unavailable"
                  ? "Git unavailable"
                  : "No repository detected"}
              </p>
              <p className="mt-1 max-w-[240px] text-[10px] leading-relaxed text-neutral-text-muted">
                {gitError ?? "This workspace does not contain a Git repository."}
              </p>
            </>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-neutral-border px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch size={13} className="shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-neutral-text-dim">
            {gitStatus.branch ?? "detached"}
          </span>
          {gitStatus.ahead > 0 && (
            <span className="font-mono text-[9px] text-primary">↑{gitStatus.ahead}</span>
          )}
          {gitStatus.behind > 0 && (
            <span className="font-mono text-[9px] text-neutral-text-muted">
              ↓{gitStatus.behind}
            </span>
          )}
          {gitLoading && <LoaderCircle size={11} className="status-icon--spin text-primary" />}
        </div>

        <div className="mt-3 flex min-w-0 gap-2">
          <input
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.ctrlKey) handleCommit();
            }}
            placeholder="Commit message"
            className="field-input h-8 min-h-8 min-w-0 flex-1"
            aria-label="Commit message"
          />
          {showSyncAfterCommit ? (
            <button
              type="button"
              onClick={() => void syncGit(workspaceId, "push")}
              disabled={gitActionLoading}
              className="primary-button h-8 min-h-8 px-3"
              title="Push commit"
            >
              <Upload size={12} /> Push
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCommit}
              disabled={!commitMessage.trim() || !stagedChanges.length || gitActionLoading}
              className="primary-button h-8 min-h-8 px-3"
              title={stagedChanges.length ? "Create commit" : "Stage a file first"}
            >
              <Check size={12} /> Commit
            </button>
          )}
        </div>

        {(gitActionMessage || gitActionError) && (
          <p
            className={`mt-2 truncate text-[10px] ${
              gitActionError ? "text-danger" : "text-signal"
            }`}
          >
            {gitActionError ?? gitActionMessage}
          </p>
        )}
      </div>

      {gitError && (
        <p className="shrink-0 border-b border-warning/20 px-3 py-2 text-[10px] text-warning">
          {gitError}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <ChangeGroup
          label="Staged"
          changes={stagedChanges}
          actionLabel="Unstage all"
          onAction={() =>
            void unstagePaths(
              workspaceId,
              stagedChanges.map((change) => change.path),
            )
          }
          actionIcon={<Minus size={12} />}
          actionDisabled={!stagedChanges.length || gitActionLoading}
          renderChange={(change) => renderChangeRow(change, true)}
        />
        <ChangeGroup
          label="Changes"
          changes={workingChanges}
          actionLabel="Stage all"
          onAction={() =>
            void stagePaths(
              workspaceId,
              workingChanges.map((change) => change.path),
            )
          }
          actionIcon={<Plus size={12} />}
          actionDisabled={!workingChanges.length || gitActionLoading}
          renderChange={(change) => renderChangeRow(change, false)}
        />
      </div>

      {isPreviewableImage(selectedPath ?? "") &&
        (preview || previewLoading || previewError) && (
          <ProjectFilePreview
            preview={preview}
            loading={previewLoading}
            error={previewError}
            onClose={() => clearPreview(workspaceId)}
          />
        )}

      {!isPreviewableImage(selectedPath ?? "") &&
        (diff || diffLoading || diffError) && (
          <ProjectDiffViewer
            diff={diff}
            loading={diffLoading}
            error={diffError}
            change={
              selectedPath
                ? changes.find((change) => change.path === selectedPath) ?? null
                : null
            }
            actionLoading={gitActionLoading}
            actionError={gitActionError}
            actionMessage={gitActionMessage}
            showSideToggle={false}
            onClose={() => clearDiff(workspaceId)}
            onSideChange={(side) => {
              if (selectedPath) {
                setSelectedRow({ path: selectedPath, side });
                void loadDiff(workspaceId, selectedPath, side);
              }
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
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/65 p-4">
          <div
            className="w-full max-w-[330px] border border-danger/25 bg-neutral-elevated p-4 shadow-[0_12px_28px_rgba(0,0,0,0.34)]"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="discard-confirm-title"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle size={17} className="mt-0.5 shrink-0 text-danger" />
              <div className="min-w-0">
                <h3 id="discard-confirm-title" className="text-sm font-semibold text-neutral-text">
                  {pendingDiscard.untracked ? "Delete file?" : "Discard changes?"}
                </h3>
                <p className="mt-1 break-words text-xs leading-relaxed text-neutral-text-muted">
                  {pendingDiscard.untracked
                    ? `“${pendingDiscard.label}” will be removed from the workspace.`
                    : `Local changes to “${pendingDiscard.label}” will be restored.`}
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDiscard(null)}
                className="secondary-button"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const discard = pendingDiscard;
                  setPendingDiscard(null);
                  void discardPaths(workspaceId, discard.paths);
                }}
                className="secondary-button border-danger/30 text-danger hover:border-danger/50"
              >
                Discard
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
    <section className="mb-4 last:mb-0">
      <div className="mb-1.5 flex h-7 items-center gap-2 px-1">
        <span className="flex-1 text-[10px] font-semibold text-neutral-text-dim">
          {label}
        </span>
        <span className="font-mono text-[9px] text-neutral-text-muted">
          {changes.length}
        </span>
        <button
          type="button"
          onClick={onAction}
          disabled={actionDisabled}
          className="ui-icon-button h-7 w-7 disabled:opacity-25"
          title={actionLabel}
          aria-label={actionLabel}
        >
          {actionIcon}
        </button>
      </div>
      {changes.length > 0 && <div>{changes.map(renderChange)}</div>}
    </section>
  );
}
