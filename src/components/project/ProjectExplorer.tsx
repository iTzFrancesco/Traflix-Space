import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronRight,
  Folder,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  Search,
} from "lucide-react";
import { useProjectStore } from "../../stores/projectStore";
import { useUIStore } from "../../stores/uiStore";
import type {
  ProjectDirectoryState,
  ProjectEntry,
  ProjectEntryKind,
  ProjectGitChange,
} from "../../project/types";
import {
  changeDetail,
  changeStatusCode,
  changeTone,
} from "./changePresentation";
import { ProjectFilePreview } from "./ProjectFilePreview";
import { getFileIcon } from "./fileIcons";

interface ProjectExplorerProps {
  workspaceId: string;
  workspaceName: string;
  rootPath: string;
}

interface VisibleEntry {
  entry: ProjectEntry;
  depth: number;
}

const SEARCH_SKIP_DIRECTORIES = new Set([
  ".git",
  ".cache",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

function compactPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.length <= 44) return normalized;
  return `…/${normalized.split("/").slice(-3).join("/")}`;
}

function hasSearchMatch(entry: ProjectEntry, query: string): boolean {
  if (!query) return true;
  return (
    entry.name.toLowerCase().includes(query) ||
    entry.path.toLowerCase().includes(query)
  );
}

function changeMap(changes: ProjectGitChange[]): Map<string, ProjectGitChange> {
  return new Map(changes.map((change) => [change.path, change]));
}

function changeCountBelow(path: string, changes: ProjectGitChange[]): number {
  const prefix = path ? `${path}/` : "";
  return changes.filter(
    (change) => change.path.startsWith(prefix) && change.path !== path,
  ).length;
}

function childEntries(
  parentPath: string,
  actualEntries: ProjectEntry[],
  changes: ProjectGitChange[],
): ProjectEntry[] {
  const prefix = parentPath ? `${parentPath}/` : "";
  const entries = new Map(actualEntries.map((entry) => [entry.path, entry]));

  for (const change of changes) {
    if (!change.path.startsWith(prefix)) continue;
    const remainder = change.path.slice(prefix.length);
    if (!remainder) continue;
    const [name, ...nested] = remainder.split("/");
    const path = `${prefix}${name}`;
    if (!entries.has(path)) {
      entries.set(path, {
        name,
        path,
        kind: nested.length > 0 ? "directory" : "file",
        virtual: true,
      });
    }
  }

  return [...entries.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

function collectVisibleEntries(
  directories: Record<string, ProjectDirectoryState>,
  parentPath: string,
  depth: number,
  query: string,
  changes: ProjectGitChange[],
): VisibleEntry[] {
  const directory = directories[parentPath];
  const entries = childEntries(parentPath, directory?.entries ?? [], changes);
  const result: VisibleEntry[] = [];

  for (const entry of entries) {
    const childDirectory =
      entry.kind === "directory" ? directories[entry.path] : undefined;
    const nestedEntries =
      entry.kind === "directory"
        ? collectVisibleEntries(
            directories,
            entry.path,
            depth + 1,
            query,
            changes,
          )
        : [];
    const childMatches = nestedEntries.length > 0;
    if (!hasSearchMatch(entry, query) && !childMatches) continue;

    result.push({ entry, depth });
    if (
      entry.kind === "directory" &&
      childDirectory &&
      (childDirectory.expanded || Boolean(query))
    ) {
      result.push(...nestedEntries);
    }
  }
  return result;
}

function EntryIcon({
  kind,
  name,
  expanded,
}: {
  kind: ProjectEntryKind;
  name: string;
  expanded: boolean;
}) {
  if (kind === "directory") {
    return expanded ? (
      <FolderOpen size={14} strokeWidth={1.7} />
    ) : (
      <Folder size={14} strokeWidth={1.7} />
    );
  }
  const Icon = getFileIcon(name);
  return <Icon size={14} strokeWidth={1.7} />;
}

export function ProjectExplorer({
  workspaceId,
  workspaceName,
  rootPath,
}: ProjectExplorerProps) {
  const workspaceState = useProjectStore((state) => state.workspaces[workspaceId]);
  const loadSearchDirectories = useProjectStore(
    (state) => state.loadSearchDirectories,
  );
  const isFilesView = useUIStore(
    (state) =>
      !state.rightPanelActiveView || state.rightPanelActiveView === "files",
  );
  const toggleDirectory = useProjectStore((state) => state.toggleDirectory);
  const refreshDirectory = useProjectStore((state) => state.refreshDirectory);
  const clearDiff = useProjectStore((state) => state.clearDiff);
  const loadFilePreview = useProjectStore((state) => state.loadFilePreview);
  const clearPreview = useProjectStore((state) => state.clearPreview);
  const selectPath = useProjectStore((state) => state.selectPath);
  const setSearchQuery = useProjectStore((state) => state.setSearchQuery);
  const searchScanRef = useRef<{
    workspaceId: string;
    promise: Promise<void>;
  } | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  const directories = workspaceState?.directories ?? {};
  const root = directories[""];
  const searchQuery = workspaceState?.searchQuery ?? "";
  const gitStatus = workspaceState?.gitStatus;
  const gitLoading = workspaceState?.gitLoading ?? false;
  const gitError = workspaceState?.gitError;
  const preview = workspaceState?.preview ?? null;
  const previewLoading = workspaceState?.previewLoading ?? false;
  const previewError = workspaceState?.previewError ?? null;
  const revision = workspaceState?.revision ?? 0;
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const changes = gitStatus?.changes ?? [];
  const changesByPath = useMemo(() => changeMap(changes), [changes]);
  const visibleEntries = useMemo(
    () => collectVisibleEntries(directories, "", 0, normalizedQuery, changes),
    [changes, directories, normalizedQuery],
  );

  const selectedPath = workspaceState?.selectedPath;
  const selectEntry = (entry: ProjectEntry) => {
    if (entry.kind === "directory") {
      toggleDirectory(workspaceId, entry.path);
      selectPath(workspaceId, null);
      clearDiff(workspaceId);
      clearPreview(workspaceId);
      return;
    }
    if (selectedPath === entry.path) {
      void loadFilePreview(workspaceId, entry.path);
      return;
    }
    selectPath(workspaceId, entry.path);
  };

  useEffect(() => {
    if (!isFilesView || !selectedPath) return;
    void loadFilePreview(workspaceId, selectedPath);
  }, [isFilesView, loadFilePreview, revision, selectedPath, workspaceId]);

  useEffect(() => {
    if (!isFilesView || !normalizedQuery) {
      setSearchLoading(false);
      return;
    }

    let active = true;
    setSearchLoading(true);
    const timer = window.setTimeout(() => {
      const cachedScan = searchScanRef.current;
      const promise =
        cachedScan?.workspaceId === workspaceId
          ? cachedScan.promise
          : loadSearchDirectories(workspaceId, [...SEARCH_SKIP_DIRECTORIES]);
      if (!cachedScan || cachedScan.workspaceId !== workspaceId) {
        searchScanRef.current = { workspaceId, promise };
      }
      void promise.then(
        () => {
          if (active) setSearchLoading(false);
        },
        () => {
          if (active) setSearchLoading(false);
        },
      );
    }, 180);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [isFilesView, loadSearchDirectories, normalizedQuery, workspaceId]);

  const displayedEntries = normalizedQuery && searchLoading ? [] : visibleEntries;
  const repositoryLabel =
    gitStatus?.repositoryState === "repository"
      ? gitStatus.branch || "detached"
      : gitStatus?.repositoryState === "unavailable"
        ? "Git unavailable"
        : gitStatus?.repositoryState === "error"
          ? "Git error"
          : "No Git";

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-neutral-border px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-neutral-text">
            {workspaceName}
          </span>
          <GitBranch
            size={12}
            className={
              gitStatus?.repositoryState === "repository"
                ? "shrink-0 text-primary"
                : "shrink-0 text-neutral-text-muted"
            }
          />
          <span className="max-w-[110px] truncate font-mono text-[9px] text-neutral-text-muted">
            {repositoryLabel}
          </span>
          {gitStatus?.repositoryState === "repository" && changes.length > 0 && (
            <span className="font-mono text-[9px] text-primary">{changes.length}</span>
          )}
          {gitLoading && (
            <LoaderCircle size={11} className="status-icon--spin shrink-0 text-primary" />
          )}
        </div>
        <p
          className="mt-1 truncate font-mono text-[9px] text-neutral-text-muted"
          title={rootPath}
        >
          {compactPath(rootPath)}
        </p>

        <label className="relative mt-3 block">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-text-muted"
          />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(workspaceId, event.target.value)}
            placeholder="Search files"
            className="field-input h-8 min-h-8 w-full pl-8"
            aria-label="Search files"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {root?.error && (
          <div className="border-l-2 border-danger px-3 py-2 text-xs text-danger" role="alert">
            <div className="flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>{root.error}</span>
            </div>
            <button
              type="button"
              onClick={() => void refreshDirectory(workspaceId, "")}
              className="mt-2 text-[10px] font-semibold hover:underline"
            >
              Retry
            </button>
          </div>
        )}

        {gitError && gitStatus?.repositoryState === "error" && (
          <div className="mb-2 border-l-2 border-warning px-3 py-2 text-[10px] text-warning">
            {gitError}
          </div>
        )}

        {root?.loading && !root.loaded && (
          <div className="flex items-center gap-2 px-2 py-4 text-xs text-neutral-text-muted">
            <LoaderCircle size={13} className="status-icon--spin text-primary" />
            Scanning folder…
          </div>
        )}

        {searchLoading && (
          <div className="flex items-center gap-2 px-2 py-4 text-xs text-neutral-text-muted">
            <LoaderCircle size={13} className="status-icon--spin text-primary" />
            Searching…
          </div>
        )}

        {root?.loaded &&
          displayedEntries.length === 0 &&
          !root.error &&
          !searchLoading && (
            <div className="px-4 py-8 text-center">
              <Folder
                size={22}
                className="mx-auto text-neutral-text-muted"
                strokeWidth={1.4}
              />
              <p className="mt-3 text-xs font-semibold text-neutral-text">
                {normalizedQuery ? "No files found" : "Folder is empty"}
              </p>
            </div>
          )}

        <div>
          {displayedEntries.map(({ entry, depth }) => {
            const directory =
              entry.kind === "directory" ? directories[entry.path] : undefined;
            const isSelected = selectedPath === entry.path;
            const isDirectory = entry.kind === "directory";
            const isLoading = Boolean(directory?.loading && !directory.loaded);
            const directoryChangeCount = isDirectory
              ? changeCountBelow(entry.path, changes)
              : 0;
            const change = changesByPath.get(entry.path);

            return (
              <button
                type="button"
                key={entry.path}
                onClick={() => selectEntry(entry)}
                className={`group flex h-8 w-full items-center gap-1.5 pr-2 text-left text-[11px] transition-colors ${
                  isSelected
                    ? "bg-primary/[0.08] text-neutral-text"
                    : "text-neutral-text-dim hover:bg-white/[0.025] hover:text-neutral-text"
                }`}
                style={{ paddingLeft: `${6 + depth * 15}px` }}
                title={entry.path}
                aria-selected={isSelected}
                aria-expanded={isDirectory ? directory?.expanded : undefined}
              >
                {isDirectory ? (
                  <ChevronRight
                    size={12}
                    className={`shrink-0 text-neutral-text-muted transition-transform ${
                      directory?.expanded ? "rotate-90" : ""
                    }`}
                  />
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <span
                  className={`flex shrink-0 items-center ${
                    isDirectory ? "text-primary/80" : "text-neutral-text-muted"
                  }`}
                >
                  <EntryIcon
                    kind={entry.kind}
                    name={entry.name}
                    expanded={Boolean(directory?.expanded)}
                  />
                </span>
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {isLoading && (
                  <LoaderCircle size={11} className="status-icon--spin shrink-0 text-primary" />
                )}
                {isDirectory && directory?.error && (
                  <AlertCircle size={11} className="shrink-0 text-danger" />
                )}
                {directoryChangeCount > 0 ? (
                  <span
                    className="shrink-0 font-mono text-[9px] text-primary"
                    title={`${directoryChangeCount} changed file${directoryChangeCount === 1 ? "" : "s"}`}
                  >
                    {directoryChangeCount}
                  </span>
                ) : change ? (
                  <span
                    className={`shrink-0 font-mono text-[9px] font-bold ${changeTone(change)}`}
                    title={changeDetail(change)}
                  >
                    {changeStatusCode(change)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {(preview || previewLoading || previewError) && (
        <ProjectFilePreview
          preview={preview}
          loading={previewLoading}
          error={previewError}
          onClose={() => clearPreview(workspaceId)}
        />
      )}

      <div className="h-8 shrink-0 border-t border-neutral-border px-3 py-2">
        <p
          className="truncate font-mono text-[9px] text-neutral-text-muted"
          title={selectedPath ?? undefined}
        >
          {selectedPath ? `/${selectedPath}` : "No file selected"}
        </p>
      </div>
    </section>
  );
}
