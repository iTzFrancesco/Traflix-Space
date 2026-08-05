import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { invokeWithTimeout } from "../lib/timeout";
import type {
  DiffSide,
  ProjectDirectoryResponse,
  ProjectDirectoryState,
  ProjectFilePreview,
  ProjectFilesChanged,
  ProjectGitStatus,
  ProjectGitDiff,
  WorkspaceProjectState,
} from "../project/types";

interface ProjectStore {
  workspaces: Record<string, WorkspaceProjectState>;
  ensureWorkspace: (workspaceId: string) => void;
  listDirectory: (workspaceId: string, relativePath?: string) => Promise<void>;
  loadSearchDirectories: (workspaceId: string, skipDirectoryNames: string[]) => Promise<void>;
  refreshGitStatus: (workspaceId: string) => Promise<void>;
  loadDiff: (workspaceId: string, path: string, side: DiffSide) => Promise<void>;
  clearDiff: (workspaceId: string) => void;
  loadFilePreview: (workspaceId: string, path: string) => Promise<void>;
  clearPreview: (workspaceId: string) => void;
  clearSelection: (workspaceId: string) => void;
  stagePath: (workspaceId: string, path: string) => Promise<void>;
  unstagePath: (workspaceId: string, path: string) => Promise<void>;
  discardPath: (workspaceId: string, path: string) => Promise<void>;
  stagePaths: (workspaceId: string, paths: string[]) => Promise<void>;
  unstagePaths: (workspaceId: string, paths: string[]) => Promise<void>;
  discardPaths: (workspaceId: string, paths: string[]) => Promise<void>;
  commitStaged: (workspaceId: string, message: string, paths: string[]) => Promise<void>;
  syncGit: (workspaceId: string, action: "pull" | "push") => Promise<void>;
  handleFilesChanged: (workspaceId: string, event: ProjectFilesChanged) => void;
  toggleDirectory: (workspaceId: string, relativePath: string) => void;
  refreshDirectory: (workspaceId: string, relativePath?: string) => Promise<void>;
  selectPath: (workspaceId: string, path: string | null) => void;
  setSearchQuery: (workspaceId: string, query: string) => void;
}

const ROOT_PATH = "";
const inflight = new Map<string, Promise<void>>();
const searchInflight = new Map<string, Promise<void>>();
const gitInflight = new Map<string, Promise<void>>();
const gitRefreshQueued = new Set<string>();
const diffRequests = new Map<string, number>();
const previewRequests = new Map<string, number>();

const emptyDirectory = (expanded = false): ProjectDirectoryState => ({
  entries: [],
  loaded: false,
  loading: false,
  expanded,
  error: null,
});

const createWorkspaceState = (): WorkspaceProjectState => ({
  directories: { [ROOT_PATH]: emptyDirectory(true) },
  selectedPath: null,
  searchQuery: "",
  preview: null,
  previewLoading: false,
  previewError: null,
  gitStatus: null,
  gitLoading: false,
  gitError: null,
  revision: 0,
  diff: null,
  diffLoading: false,
  diffError: null,
  gitActionLoading: false,
  gitActionError: null,
  gitActionMessage: null,
});

function normalizeRelativePath(path: string | undefined): string {
  if (!path || path === ".") return ROOT_PATH;
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

function errorMessage(error: unknown): string {
  if (typeof error === "string" && error) return error;
  if (error instanceof Error && error.message) return error.message;
  return "Impossibile leggere questa cartella";
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  workspaces: {},

  ensureWorkspace: (workspaceId) =>
    set((state) => {
      if (state.workspaces[workspaceId]) return state;
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: createWorkspaceState(),
        },
      };
    }),

  listDirectory: async (workspaceId, relativePath) => {
    const path = normalizeRelativePath(relativePath);
    const requestKey = `${workspaceId}:${path}`;
    get().ensureWorkspace(workspaceId);
    const requestRevision = get().workspaces[workspaceId]?.revision ?? 0;

    const pending = inflight.get(requestKey);
    if (pending) return pending;

    set((state) => {
      const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
      const directory = workspace.directories[path] ?? emptyDirectory(path === ROOT_PATH);
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...workspace,
            directories: {
              ...workspace.directories,
              [path]: { ...directory, loading: true, error: null },
            },
          },
        },
      };
    });

    const promise = invokeWithTimeout(
      () =>
        invoke<ProjectDirectoryResponse>("project_list_directory", {
          workspaceId,
          relativePath: path,
        }),
      10000,
    )
      .then((result) => {
        const responsePath = normalizeRelativePath(result.relativePath);
        set((state) => {
          const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
          const directory =
            workspace.directories[responsePath] ?? emptyDirectory(responsePath === ROOT_PATH);
          if (workspace.revision > requestRevision) {
            return {
              workspaces: {
                ...state.workspaces,
                [workspaceId]: {
                  ...workspace,
                  directories: {
                    ...workspace.directories,
                    [responsePath]: { ...directory, loading: false },
                  },
                },
              },
            };
          }
          return {
            workspaces: {
              ...state.workspaces,
              [workspaceId]: {
                ...workspace,
                directories: {
                  ...workspace.directories,
                  [responsePath]: {
                    ...directory,
                    entries: result.entries,
                    loaded: true,
                    loading: false,
                    error: null,
                  },
                },
              },
            },
          };
        });
      })
      .catch((error) => {
        set((state) => {
          const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
          const directory = workspace.directories[path] ?? emptyDirectory(path === ROOT_PATH);
          return {
            workspaces: {
              ...state.workspaces,
              [workspaceId]: {
                ...workspace,
                directories: {
                  ...workspace.directories,
                  [path]: {
                    ...directory,
                    loading: false,
                    error: errorMessage(error),
                  },
                },
              },
            },
          };
        });
      })
      .finally(() => {
        inflight.delete(requestKey);
        const workspace = get().workspaces[workspaceId];
        if (workspace && workspace.revision > requestRevision) {
          void get().listDirectory(workspaceId, path);
        }
      });

    inflight.set(requestKey, promise);
    return promise;
  },

  loadSearchDirectories: async (workspaceId, skipDirectoryNames) => {
    get().ensureWorkspace(workspaceId);
    const pending = searchInflight.get(workspaceId);
    if (pending) return pending;

    const promise = (async () => {
      const skip = new Set(skipDirectoryNames.map((name) => name.toLowerCase()));
      const scanned = new Map<string, ProjectDirectoryResponse>();
      const queue: string[] = [];
      const visited = new Set<string>();

      const readDirectory = async (path: string): Promise<ProjectDirectoryResponse | null> => {
        try {
          return await invokeWithTimeout(
            () =>
              invoke<ProjectDirectoryResponse>("project_list_directory", {
                workspaceId,
                relativePath: path,
              }),
            10000,
          );
        } catch {
          return null;
        }
      };

      const rootResult = await readDirectory(ROOT_PATH);
      if (!rootResult) return;
      const rootPath = normalizeRelativePath(rootResult.relativePath);
      scanned.set(rootPath, rootResult);
      visited.add(rootPath);
      for (const entry of rootResult.entries) {
        if (entry.kind === "directory" && !entry.virtual && !skip.has(entry.name.toLowerCase())) {
          queue.push(entry.path);
        }
      }

      let cursor = 0;
      const worker = async () => {
        while (true) {
          const path = queue[cursor++];
          if (path === undefined || visited.has(path)) return;
          visited.add(path);

          const result = await readDirectory(path);
          if (!result) continue;
          const responsePath = normalizeRelativePath(result.relativePath);
          scanned.set(responsePath, result);
          for (const entry of result.entries) {
            if (entry.kind === "directory" && !entry.virtual && !skip.has(entry.name.toLowerCase())) {
              queue.push(entry.path);
            }
          }
        }
      };

      const workerCount = Math.min(6, Math.max(1, queue.length));
      await Promise.all(Array.from({ length: workerCount }, () => worker()));

      set((state) => {
        const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
        const directories = { ...workspace.directories };
        for (const [path, result] of scanned) {
          const existing = directories[path] ?? emptyDirectory(path === ROOT_PATH);
          directories[path] = {
            ...existing,
            entries: result.entries,
            loaded: true,
            loading: false,
            error: null,
          };
        }
        return {
          workspaces: {
            ...state.workspaces,
            [workspaceId]: { ...workspace, directories },
          },
        };
      });
    })().finally(() => {
      searchInflight.delete(workspaceId);
    });

    searchInflight.set(workspaceId, promise);
    return promise;
  },

  handleFilesChanged: (workspaceId, event) => {
    get().ensureWorkspace(workspaceId);
    const workspace = get().workspaces[workspaceId] ?? createWorkspaceState();
    if (event.revision <= workspace.revision) return;

    const affected = new Set<string>([ROOT_PATH]);
    for (const changedPath of event.paths) {
      const path = normalizeRelativePath(changedPath);
      if (!path) continue;
      const separator = path.lastIndexOf("/");
      const parent = separator === -1 ? ROOT_PATH : path.slice(0, separator);
      affected.add(parent);
      if (workspace.directories[path]) affected.add(path);
    }

    set((state) => {
      const currentWorkspace = state.workspaces[workspaceId] ?? createWorkspaceState();
      const directories = { ...currentWorkspace.directories };
      for (const path of affected) {
        const directory = directories[path];
        if (directory) {
          directories[path] = { ...directory, loaded: false, loading: false, error: null };
        }
      }
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...currentWorkspace,
            directories,
            revision: event.revision,
          },
        },
      };
    });

    for (const path of affected) void get().listDirectory(workspaceId, path);
    if (event.gitMetadataChanged || event.paths.length > 0) void get().refreshGitStatus(workspaceId);
  },

  refreshGitStatus: async (workspaceId) => {
    get().ensureWorkspace(workspaceId);
    const pending = gitInflight.get(workspaceId);
    if (pending) {
      gitRefreshQueued.add(workspaceId);
      return pending;
    }

    set((state) => {
      const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: { ...workspace, gitLoading: true, gitError: null },
        },
      };
    });

    const promise = invokeWithTimeout(
      () => invoke<ProjectGitStatus>("project_git_status", { workspaceId }),
      15000,
    )
      .then((gitStatus) => {
        set((state) => {
          const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
          return {
            workspaces: {
              ...state.workspaces,
              [workspaceId]: {
                ...workspace,
                gitStatus,
                gitLoading: false,
                gitError: gitStatus.error,
              },
            },
          };
        });
      })
      .catch((error) => {
        set((state) => {
          const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
          return {
            workspaces: {
              ...state.workspaces,
              [workspaceId]: {
                ...workspace,
                gitLoading: false,
                gitError: errorMessage(error),
              },
            },
          };
        });
      })
      .finally(() => {
        gitInflight.delete(workspaceId);
        if (gitRefreshQueued.delete(workspaceId)) {
          void get().refreshGitStatus(workspaceId);
        }
      });

    gitInflight.set(workspaceId, promise);
    return promise;
  },

  loadDiff: async (workspaceId, path, side) => {
    get().ensureWorkspace(workspaceId);
    const requestId = (diffRequests.get(workspaceId) ?? 0) + 1;
    diffRequests.set(workspaceId, requestId);
    previewRequests.set(workspaceId, (previewRequests.get(workspaceId) ?? 0) + 1);
    set((state) => {
      const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
      const previousDiff = workspace.diff?.path === path && workspace.diff.side === side ? workspace.diff : null;
      return {
          workspaces: {
            ...state.workspaces,
            [workspaceId]: {
              ...workspace,
              diff: previousDiff,
              diffLoading: true,
              diffError: null,
              preview: null,
              previewLoading: false,
              previewError: null,
            },
        },
      };
    });

    try {
      const diff = await invokeWithTimeout(
        () =>
          invoke<ProjectGitDiff>("project_git_diff", {
            workspaceId,
            relativePath: path,
            side,
          }),
        15000,
      );
      if (diffRequests.get(workspaceId) !== requestId) return;
      set((state) => {
        const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
        return {
          workspaces: {
            ...state.workspaces,
            [workspaceId]: { ...workspace, diff, diffLoading: false, diffError: diff.error },
          },
        };
      });
    } catch (error) {
      if (diffRequests.get(workspaceId) !== requestId) return;
      set((state) => {
        const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
        return {
          workspaces: {
            ...state.workspaces,
            [workspaceId]: { ...workspace, diffLoading: false, diffError: errorMessage(error) },
          },
        };
      });
    }
  },

  clearDiff: (workspaceId) => {
    diffRequests.set(workspaceId, (diffRequests.get(workspaceId) ?? 0) + 1);
    get().ensureWorkspace(workspaceId);
    set((state) => {
      const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: { ...workspace, diff: null, diffLoading: false, diffError: null },
        },
      };
    });
  },

  loadFilePreview: async (workspaceId, path) => {
    get().ensureWorkspace(workspaceId);
    const requestId = (previewRequests.get(workspaceId) ?? 0) + 1;
    previewRequests.set(workspaceId, requestId);
    diffRequests.set(workspaceId, (diffRequests.get(workspaceId) ?? 0) + 1);
    set((state) => {
      const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
      const previousPreview = workspace.preview?.path === path ? workspace.preview : null;
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...workspace,
            preview: previousPreview,
            previewLoading: true,
            previewError: null,
            diff: null,
            diffLoading: false,
            diffError: null,
          },
        },
      };
    });

    try {
      const preview = await invokeWithTimeout(
        () => invoke<ProjectFilePreview>("project_read_file", { workspaceId, relativePath: path }),
        10000,
      );
      if (previewRequests.get(workspaceId) !== requestId) return;
      set((state) => {
        const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
        return {
          workspaces: {
            ...state.workspaces,
            [workspaceId]: {
              ...workspace,
              preview,
              previewLoading: false,
              previewError: null,
            },
          },
        };
      });
    } catch (error) {
      if (previewRequests.get(workspaceId) !== requestId) return;
      set((state) => {
        const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
        return {
          workspaces: {
            ...state.workspaces,
            [workspaceId]: {
              ...workspace,
              preview: null,
              previewLoading: false,
              previewError: errorMessage(error),
            },
          },
        };
      });
    }
  },

  clearPreview: (workspaceId) => {
    previewRequests.set(workspaceId, (previewRequests.get(workspaceId) ?? 0) + 1);
    get().ensureWorkspace(workspaceId);
    set((state) => {
      const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: { ...workspace, preview: null, previewLoading: false, previewError: null },
        },
      };
    });
  },

  clearSelection: (workspaceId) => {
    previewRequests.set(workspaceId, (previewRequests.get(workspaceId) ?? 0) + 1);
    diffRequests.set(workspaceId, (diffRequests.get(workspaceId) ?? 0) + 1);
    get().ensureWorkspace(workspaceId);
    set((state) => {
      const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...workspace,
            selectedPath: null,
            preview: null,
            previewLoading: false,
            previewError: null,
            diff: null,
            diffLoading: false,
            diffError: null,
          },
        },
      };
    });
  },

  stagePaths: async (workspaceId, paths) => {
    setGitActionLoading(set, get, workspaceId);
    try {
      await invokeWithTimeout(
        () => invoke("project_git_stage", { workspaceId, paths }),
        15000,
      );
      setGitActionSuccess(set, get, workspaceId, "File aggiunti allo stage");
    } catch (error) {
      setGitActionFailure(set, workspaceId, errorMessage(error));
    }
  },

  unstagePaths: async (workspaceId, paths) => {
    setGitActionLoading(set, get, workspaceId);
    try {
      await invokeWithTimeout(
        () => invoke("project_git_unstage", { workspaceId, paths }),
        15000,
      );
      setGitActionSuccess(set, get, workspaceId, "File rimossi dallo stage");
    } catch (error) {
      setGitActionFailure(set, workspaceId, errorMessage(error));
    }
  },

  discardPaths: async (workspaceId, paths) => {
    setGitActionLoading(set, get, workspaceId);
    try {
      await invokeWithTimeout(
        () => invoke("project_git_discard", { workspaceId, paths }),
        15000,
      );
      setGitActionSuccess(set, get, workspaceId, "Modifiche scartate", true);
    } catch (error) {
      setGitActionFailure(set, workspaceId, errorMessage(error));
    }
  },

  stagePath: (workspaceId, path) => get().stagePaths(workspaceId, [path]),

  unstagePath: (workspaceId, path) => get().unstagePaths(workspaceId, [path]),

  discardPath: (workspaceId, path) => get().discardPaths(workspaceId, [path]),

  commitStaged: async (workspaceId, message, paths) => {
    setGitActionLoading(set, get, workspaceId);
    try {
      await invokeWithTimeout(
        () => invoke("project_git_commit", { workspaceId, message, paths }),
        15000,
      );
      setGitActionSuccess(set, get, workspaceId, "Commit creato");
    } catch (error) {
      setGitActionFailure(set, workspaceId, errorMessage(error));
    }
  },

  syncGit: async (workspaceId, action) => {
    const gitStatus = get().workspaces[workspaceId]?.gitStatus;
    if (action === "push" && (!gitStatus?.upstream || gitStatus.ahead <= 0)) return;
    if (action === "pull" && (!gitStatus?.upstream || gitStatus.behind <= 0)) return;
    setGitActionLoading(set, get, workspaceId);
    try {
      await invokeWithTimeout(
        () => invoke("project_git_sync", { workspaceId, action }),
        15000,
      );
      setGitActionSuccess(
        set,
        get,
        workspaceId,
        action === "push" ? "Push completato" : "Pull completato",
        false,
        false,
      );
    } catch (error) {
      setGitActionFailure(set, workspaceId, errorMessage(error));
    }
  },

  toggleDirectory: (workspaceId, relativePath) => {
    const path = normalizeRelativePath(relativePath);
    get().ensureWorkspace(workspaceId);
    const workspace = get().workspaces[workspaceId] ?? createWorkspaceState();
    const directory = workspace.directories[path] ?? emptyDirectory();
    const nextExpanded = !directory.expanded;

    set((state) => {
      const currentWorkspace = state.workspaces[workspaceId] ?? createWorkspaceState();
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...currentWorkspace,
            directories: {
              ...currentWorkspace.directories,
              [path]: { ...directory, expanded: nextExpanded },
            },
          },
        },
      };
    });

    if (nextExpanded && !directory.loaded) {
      void get().listDirectory(workspaceId, path);
    }
  },

  refreshDirectory: (workspaceId, relativePath) =>
    get().listDirectory(workspaceId, relativePath),

  selectPath: (workspaceId, path) => {
    get().ensureWorkspace(workspaceId);
    set((state) => {
      const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: { ...workspace, selectedPath: path },
        },
      };
    });
  },

  setSearchQuery: (workspaceId, query) => {
    get().ensureWorkspace(workspaceId);
    set((state) => {
      const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: { ...workspace, searchQuery: query },
        },
      };
    });
  },

}));

function setGitActionLoading(
  set: (updater: (state: { workspaces: Record<string, WorkspaceProjectState> }) => { workspaces: Record<string, WorkspaceProjectState> }) => void,
  get: () => ProjectStore,
  workspaceId: string,
) {
  get().ensureWorkspace(workspaceId);
  set((state) => {
    const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
    return {
      workspaces: {
        ...state.workspaces,
        [workspaceId]: {
          ...workspace,
          gitActionLoading: true,
          gitActionError: null,
          gitActionMessage: null,
        },
      },
    };
  });
}

function setGitActionSuccess(
  set: (updater: (state: { workspaces: Record<string, WorkspaceProjectState> }) => { workspaces: Record<string, WorkspaceProjectState> }) => void,
  get: () => ProjectStore,
  workspaceId: string,
  message: string,
  refreshFiles = false,
  clearDiff = true,
) {
  set((state) => {
    const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
    return {
      workspaces: {
        ...state.workspaces,
        [workspaceId]: {
          ...workspace,
          gitActionLoading: false,
          gitActionError: null,
          gitActionMessage: message,
          ...(clearDiff ? { diff: null, diffLoading: false } : {}),
        },
      },
    };
  });
  if (refreshFiles) void get().refreshDirectory(workspaceId, "");
  void get().refreshGitStatus(workspaceId);
}

function setGitActionFailure(
  set: (updater: (state: { workspaces: Record<string, WorkspaceProjectState> }) => { workspaces: Record<string, WorkspaceProjectState> }) => void,
  workspaceId: string,
  error: string,
) {
  set((state) => {
    const workspace = state.workspaces[workspaceId] ?? createWorkspaceState();
    return {
      workspaces: {
        ...state.workspaces,
        [workspaceId]: {
          ...workspace,
          gitActionLoading: false,
          gitActionError: error,
          gitActionMessage: null,
        },
      },
    };
  });
}
