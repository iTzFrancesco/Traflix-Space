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
import { changeDetail, changeStatusCode, changeTone } from "./changePresentation";
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
  if (normalized.length <= 42) return normalized;
  return `…/${normalized.split("/").slice(-3).join("/")}`;
}

function hasSearchMatch(entry: ProjectEntry, query: string): boolean {
  if (!query) return true;
  return entry.name.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query);
}

function changeMap(changes: ProjectGitChange[]): Map<string, ProjectGitChange> {
  return new Map(changes.map((change) => [change.path, change]));
}

function changeCountBelow(path: string, changes: ProjectGitChange[]): number {
  const prefix = path ? `${path}/` : "";
  return changes.filter((change) => change.path.startsWith(prefix) && change.path !== path).length;
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

  return [...entries.values()]
    .sort((left, right) => {
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
    const childDirectory = entry.kind === "directory" ? directories[entry.path] : undefined;
    const nestedEntries =
      entry.kind === "directory"
        ? collectVisibleEntries(directories, entry.path, depth + 1, query, changes)
        : [];
    const childMatches = nestedEntries.length > 0;
    if (!hasSearchMatch(entry, query) && !childMatches) continue;

    result.push({ entry, depth });
    if (entry.kind === "directory" && childDirectory && (childDirectory.expanded || Boolean(query))) {
      result.push(...nestedEntries);
    }
  }
  return result;
}

function EntryIcon({ kind, name, expanded }: { kind: ProjectEntryKind; name: string; expanded: boolean }) {
  if (kind === "directory") {
    return expanded ? <FolderOpen size={15} strokeWidth={1.7} /> : <Folder size={15} strokeWidth={1.7} />;
  }
  const Icon = getFileIcon(name);
  return <Icon size={15} strokeWidth={1.7} />;
}

export function ProjectExplorer({ workspaceId, workspaceName, rootPath }: ProjectExplorerProps) {
  const workspaceState = useProjectStore((state) => state.workspaces[workspaceId]);
  const loadSearchDirectories = useProjectStore((state) => state.loadSearchDirectories);
  const isFilesView = useUIStore(
    (state) => !state.rightPanelActiveView || state.rightPanelActiveView === "files",
  );
  const toggleDirectory = useProjectStore((state) => state.toggleDirectory);
  const refreshDirectory = useProjectStore((state) => state.refreshDirectory);
  const clearDiff = useProjectStore((state) => state.clearDiff);
  const loadFilePreview = useProjectStore((state) => state.loadFilePreview);
  const clearPreview = useProjectStore((state) => state.clearPreview);
  const selectPath = useProjectStore((state) => state.selectPath);
  const setSearchQuery = useProjectStore((state) => state.setSearchQuery);
  const searchScanRef = useRef<{ workspaceId: string; promise: Promise<void> } | null>(null);
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
      clearDiff(workspaceId);
      void loadFilePreview(workspaceId, entry.path);
      return;
    }
    selectPath(workspaceId, entry.path);
  };

  useEffect(() => {
    if (!isFilesView || !selectedPath) return;
    clearDiff(workspaceId);
    void loadFilePreview(workspaceId, selectedPath);
  }, [clearDiff, isFilesView, loadFilePreview, revision, selectedPath, workspaceId]);

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
        ? "Git non disponibile"
        : gitStatus?.repositoryState === "error"
          ? "Git error"
          : "No Git";

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="relative border-b border-white/[0.06] px-4 pb-3 pt-4">
        <div className="min-w-0 pr-9 text-center">
          <h2 className="truncate text-[1rem] font-bold leading-tight text-neutral-text">{workspaceName}</h2>
          <p className="mt-1 truncate font-mono text-[0.6rem] text-neutral-text-muted" title={rootPath}>
            {compactPath(rootPath)}
          </p>
          <div className="mt-2 flex min-w-0 items-center justify-center gap-2 text-[0.6rem] text-neutral-text-muted">
            <GitBranch size={12} className={gitStatus?.repositoryState === "repository" ? "text-sky-300" : ""} />
            <span className="truncate">{repositoryLabel}</span>
            {gitStatus?.repositoryState === "repository" && changes.length > 0 && (
              <span className="shrink-0 rounded-full border border-primary/25 bg-primary/[0.10] px-1.5 py-0.5 text-[0.55rem] font-semibold text-primary">
                {changes.length}
              </span>
            )}
            {gitStatus?.repositoryState === "repository" && (gitStatus.ahead > 0 || gitStatus.behind > 0) && (
              <span
                className="shrink-0 font-mono text-[0.55rem] text-neutral-text-muted"
                title={gitStatus.upstream ? `Upstream: ${gitStatus.upstream}` : "Branch non allineato"}
              >
                {gitStatus.ahead > 0 ? `↑${gitStatus.ahead}` : ""}
                {gitStatus.ahead > 0 && gitStatus.behind > 0 ? " " : ""}
                {gitStatus.behind > 0 ? `↓${gitStatus.behind}` : ""}
              </span>
            )}
            {gitLoading && <LoaderCircle size={11} className="shrink-0 animate-spin text-primary" />}
          </div>
        </div>
        <label className="mt-4 flex h-10 items-center gap-2 rounded-lg border border-white/[0.09] bg-black/20 px-3 text-neutral-text-muted focus-within:border-primary/70">
          <Search size={14} />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(workspaceId, event.target.value)}
            placeholder="Cerca file"
            className="min-w-0 flex-1 bg-transparent text-[0.72rem] text-neutral-text outline-none placeholder:text-neutral-text-muted"
            aria-label="Cerca file"
          />
          <span className="rounded border border-white/[0.08] px-1.5 py-0.5 font-mono text-[0.55rem] text-neutral-text-muted">
            /
          </span>
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {root?.error && (
          <div className="mx-2 rounded-lg border border-red-400/20 bg-red-400/[0.06] p-3 text-xs text-red-200">
            <div className="flex items-start gap-2">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <span>{root.error}</span>
            </div>
            <button
              type="button"
              onClick={() => void refreshDirectory(workspaceId, "")}
              className="mt-3 text-[0.7rem] font-semibold text-red-300 underline underline-offset-2"
            >
              Riprova
            </button>
          </div>
        )}

        {gitError && gitStatus?.repositoryState === "error" && (
          <div className="mx-2 mb-2 rounded-lg border border-amber-300/20 bg-amber-300/[0.05] px-3 py-2 text-[0.68rem] text-amber-100">
            {gitError}
          </div>
        )}

        {root?.loading && !root.loaded && (
          <div className="flex items-center gap-2 px-3 py-4 text-xs text-neutral-text-muted">
            <LoaderCircle size={14} className="animate-spin text-primary" />
            Scansione della cartella…
          </div>
        )}

        {searchLoading && (
          <div className="flex items-center gap-2 px-3 py-5 text-[0.72rem] text-neutral-text-muted">
            <LoaderCircle size={14} className="animate-spin text-primary" />
            Ricerca file…
          </div>
        )}

        {root?.loaded && displayedEntries.length === 0 && !root.error && !searchLoading && (
          <div className="mx-2 rounded-lg border border-dashed border-white/[0.08] px-4 py-8 text-center">
            <Folder size={24} className="mx-auto mb-3 text-neutral-text-muted" strokeWidth={1.4} />
            <p className="text-xs font-semibold text-neutral-text">
              {normalizedQuery ? "Nessun file trovato" : "Cartella vuota"}
            </p>
            <p className="mt-1 text-[0.68rem] text-neutral-text-muted">
              {normalizedQuery ? "Prova un filtro diverso" : "I nuovi file appariranno qui"}
            </p>
          </div>
        )}

        <div className="space-y-0.5">
          {displayedEntries.map(({ entry, depth }) => {
            const directory = entry.kind === "directory" ? directories[entry.path] : undefined;
            const isSelected = selectedPath === entry.path;
            const isDirectory = entry.kind === "directory";
            const isLoading = Boolean(directory?.loading && !directory.loaded);
            const directoryChangeCount = isDirectory ? changeCountBelow(entry.path, changes) : 0;

            return (
              <button
                type="button"
                key={entry.path}
                onClick={() => selectEntry(entry)}
                className={`group flex h-8 w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs transition-colors ${
                  isSelected
                    ? "bg-primary/[0.13] text-neutral-text ring-1 ring-inset ring-primary/30"
                    : "text-neutral-text-dim hover:bg-white/[0.055] hover:text-neutral-text"
                }`}
                style={{ paddingLeft: `${8 + depth * 16}px` }}
                title={entry.path}
                aria-selected={isSelected}
                aria-expanded={isDirectory ? directory?.expanded : undefined}
              >
                {isDirectory ? (
                  <ChevronRight
                    size={13}
                    className={`shrink-0 text-neutral-text-muted transition-transform ${
                      directory?.expanded ? "rotate-90" : ""
                    }`}
                  />
                ) : (
                  <span className="w-[13px] shrink-0" />
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
                {isLoading && <LoaderCircle size={12} className="shrink-0 animate-spin text-primary" />}
                {isDirectory && directory?.error && <AlertCircle size={12} className="shrink-0 text-red-300" />}
                {(() => {
                  const change = changesByPath.get(entry.path);
                  if (directoryChangeCount > 0) {
                    const count = directoryChangeCount;
                    return (
                      <span
                        className="shrink-0 rounded border border-primary/25 bg-primary/[0.12] px-1 py-0.5 font-mono text-[0.55rem] font-bold leading-none text-primary"
                        title={`${count} ${count === 1 ? "modifica" : "modifiche"} nella cartella`}
                      >
                        {count} mod.
                      </span>
                    );
                  }
                  if (!change) {
                    return null;
                  }
                  return (
                    <span
                      className={`shrink-0 rounded border px-1 py-0.5 font-mono text-[0.55rem] font-bold leading-none ${changeTone(change)}`}
                      title={changeDetail(change)}
                    >
                      {changeStatusCode(change)}
                    </span>
                  );
                })()}
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

      <div className="border-t border-white/[0.06] px-4 py-2.5">
        <p className="truncate font-mono text-[0.61rem] text-neutral-text-muted" title={selectedPath ?? undefined}>
          {selectedPath ? `/${selectedPath}` : "Seleziona un file per vedere il percorso"}
        </p>
      </div>
    </section>
  );
}
