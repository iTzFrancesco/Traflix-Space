import { useEffect, useRef } from "react";
import {
  FolderTree,
  GitBranch,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { motion } from "framer-motion";
import { useUIStore } from "../../stores/uiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { ProjectGitChanges } from "../project/ProjectGitChanges";
import { ProjectExplorer } from "../project/ProjectExplorer";

const PANEL_SLOTS = [
  { id: "files", label: "Files", icon: FolderTree, available: true },
  { id: "git", label: "Git changes", icon: GitBranch, available: true },
] as const;

export function RightPanel() {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((item) => item.id === state.activeWorkspaceId),
  );
  const isOpen = useUIStore((state) => state.rightPanelOpen);
  const width = useUIStore((state) => state.rightPanelWidth);
  const activeView = useUIStore((state) => state.rightPanelActiveView);
  const togglePanel = useUIStore((state) => state.toggleRightPanel);
  const setPanelWidth = useUIStore((state) => state.setRightPanelWidth);
  const setActiveView = useUIStore((state) => state.setRightPanelActiveView);
  const panelRef = useRef<HTMLElement>(null);
  const showFiles = !activeView || activeView === "files";
  const showGitChanges = activeView === "git";

  useEffect(() => {
    if (isOpen && !activeView) setActiveView("files");
  }, [activeView, isOpen, setActiveView]);

  const openPanel = () => {
    setActiveView("files");
    if (!isOpen) togglePanel();
  };

  const handleResizeMouseDown = (event: React.MouseEvent) => {
    event.preventDefault();
    const element = panelRef.current;
    if (!element) return;

    const startX = event.clientX;
    const startWidth = element.getBoundingClientRect().width;
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.max(380, Math.min(560, startWidth + startX - moveEvent.clientX));
      element.style.width = `${nextWidth}px`;
    };
    const handleMouseUp = () => {
      const finalWidth = Number.parseFloat(element.style.width);
      if (Number.isFinite(finalWidth)) setPanelWidth(Math.round(finalWidth));
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  if (!isOpen) {
    return (
      <aside
        className="flex h-full w-12 shrink-0 flex-col items-center border-l border-neutral-border bg-neutral-surface py-3"
        aria-label="Pannello workspace"
      >
        <button
          type="button"
          onClick={openPanel}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-primary transition-colors hover:bg-primary/[0.12]"
          title="Apri file explorer"
          aria-label="Apri file explorer"
        >
          <PanelRightOpen size={17} />
        </button>
        <div className="my-3 h-px w-6 bg-white/[0.07]" />
        <button
          type="button"
          onClick={() => {
            setActiveView("git");
            if (!isOpen) togglePanel();
          }}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-text-muted transition-colors hover:bg-white/[0.06] hover:text-neutral-text"
          title="Apri Git changes"
          aria-label="Apri Git changes"
        >
          <GitBranch size={15} />
        </button>
      </aside>
    );
  }

  return (
    <motion.aside
      ref={panelRef}
      initial={{ width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 38 }}
      className="relative flex h-full min-w-[380px] shrink-0 flex-col border-l border-neutral-border bg-neutral-surface"
      style={{ width: `${Math.max(400, width)}px` }}
      aria-label="Pannello workspace"
    >
      <div
        onMouseDown={handleResizeMouseDown}
        className="group absolute -left-2 top-0 z-20 h-full w-2 cursor-col-resize"
        aria-hidden="true"
      >
        <span className="absolute inset-y-2 left-0 w-px bg-neutral-border transition-all group-hover:w-0.5 group-hover:bg-primary" />
      </div>

      <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.06] px-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/[0.12] text-primary">
            <FolderTree size={15} />
          </div>
          <span className="truncate text-xs font-bold tracking-wide text-neutral-text">Workspace</span>
        </div>
        <button
          type="button"
          onClick={togglePanel}
          className="ui-icon-button h-8 w-8"
          title="Chiudi pannello"
          aria-label="Chiudi pannello"
        >
          <PanelRightClose size={15} />
        </button>
      </div>

      <div className="flex shrink-0 gap-1 border-b border-white/[0.06] px-3 py-2">
        {PANEL_SLOTS.map(({ id, label, icon: Icon, available }) => {
          const active = activeView === id;
          return (
            <button
              key={id}
              type="button"
              disabled={!available}
              onClick={() => available && setActiveView(id)}
              className={`flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 text-[0.66rem] font-semibold transition-colors ${
                active
                  ? "border-primary/70 bg-primary/[0.13] text-neutral-text"
                  : available
                    ? "border-transparent text-neutral-text-muted hover:border-white/[0.08] hover:bg-white/[0.04] hover:text-neutral-text"
                    : "cursor-not-allowed border-transparent text-neutral-text-muted/30"
              }`}
              title={available ? label : `${label} — in arrivo`}
              aria-label={available ? label : `${label} — in arrivo`}
            >
              <Icon size={13} />
              <span className="hidden xl:inline">{label}</span>
            </button>
          );
        })}
      </div>

      {activeWorkspaceId && workspace ? (
        <>
          <div className={showFiles ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
            <ProjectExplorer
              workspaceId={activeWorkspaceId}
              workspaceName={workspace.name}
              rootPath={workspace.rootPath}
            />
          </div>
          <div className={showGitChanges ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
            <ProjectGitChanges workspaceId={activeWorkspaceId} workspaceName={workspace.name} />
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <FolderTree size={28} className="mb-3 text-neutral-text-muted" strokeWidth={1.3} />
          <p className="text-sm font-semibold text-neutral-text">Nessuna workspace</p>
          <p className="mt-1 text-xs leading-relaxed text-neutral-text-muted">
            Apri una workspace per esplorarne i file.
          </p>
        </div>
      )}
    </motion.aside>
  );
}
