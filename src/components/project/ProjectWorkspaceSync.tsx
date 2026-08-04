import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { invokeWithTimeout } from "../../lib/timeout";
import { useProjectStore } from "../../stores/projectStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { ProjectFilesChanged } from "../../project/types";

export function ProjectWorkspaceSync() {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const ensureWorkspace = useProjectStore((state) => state.ensureWorkspace);
  const listDirectory = useProjectStore((state) => state.listDirectory);
  const refreshGitStatus = useProjectStore((state) => state.refreshGitStatus);
  const handleFilesChanged = useProjectStore((state) => state.handleFilesChanged);

  useEffect(() => {
    if (!activeWorkspaceId) return;

    ensureWorkspace(activeWorkspaceId);
    void listDirectory(activeWorkspaceId, "");
    void refreshGitStatus(activeWorkspaceId);

    let disposed = false;
    const listener = listen<ProjectFilesChanged>("project-files-changed", (event) => {
      if (event.payload.workspaceId === activeWorkspaceId) {
        handleFilesChanged(activeWorkspaceId, event.payload);
      }
    });

    void invokeWithTimeout(
      () => invoke("project_watch_workspace", { workspaceId: activeWorkspaceId }),
      10000,
    ).catch(() => undefined);

    void listener
      .then((unlisten) => {
        if (disposed) unlisten();
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      void listener.then((unlisten) => unlisten()).catch(() => undefined);
      void invokeWithTimeout(
        () => invoke("project_unwatch_workspace", { workspaceId: activeWorkspaceId }),
        10000,
      ).catch(() => undefined);
    };
  }, [activeWorkspaceId, ensureWorkspace, handleFilesChanged, listDirectory, refreshGitStatus]);

  return null;
}
