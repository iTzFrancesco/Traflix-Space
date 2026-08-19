export type ProjectEntryKind = "file" | "directory";

export type DiffSide = "worktree" | "staged";

export type GitRepositoryState = "repository" | "notrepository" | "unavailable" | "error";

export type GitChangeState =
  | "clean"
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "conflict";

export interface ProjectEntry {
  name: string;
  path: string;
  kind: ProjectEntryKind;
  virtual?: boolean;
}

export interface ProjectDirectoryResponse {
  workspaceId: string;
  relativePath: string;
  entries: ProjectEntry[];
}

export interface ProjectFilePreview {
  workspaceId: string;
  path: string;
  kind?: "text" | "image" | "binary";
  mimeType?: string | null;
  content: string;
  contentBase64?: string | null;
  binary: boolean;
  truncated: boolean;
  size: number;
}

export interface ProjectDirectoryState {
  entries: ProjectEntry[];
  loaded: boolean;
  loading: boolean;
  expanded: boolean;
  error: string | null;
}

export interface ProjectGitChange {
  path: string;
  renameFrom: string | null;
  index: GitChangeState;
  worktree: GitChangeState;
  untracked: boolean;
  binary: boolean;
}

export interface ProjectGitStatus {
  workspaceId: string;
  repositoryState: GitRepositoryState;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: ProjectGitChange[];
  error: string | null;
}

export interface ProjectFilesChanged {
  workspaceId: string;
  paths: string[];
  gitMetadataChanged: boolean;
  revision: number;
}

export interface ProjectGitDiff {
  workspaceId: string;
  path: string;
  side: DiffSide;
  patch: string;
  additions: number;
  deletions: number;
  binary: boolean;
  truncated: boolean;
  error: string | null;
}

export interface WorkspaceProjectState {
  directories: Record<string, ProjectDirectoryState>;
  selectedPath: string | null;
  searchQuery: string;
  preview: ProjectFilePreview | null;
  previewLoading: boolean;
  previewError: string | null;
  gitStatus: ProjectGitStatus | null;
  gitLoading: boolean;
  gitError: string | null;
  revision: number;
  diff: ProjectGitDiff | null;
  diffLoading: boolean;
  diffError: string | null;
  gitActionLoading: boolean;
  gitActionError: string | null;
  gitActionMessage: string | null;
}
