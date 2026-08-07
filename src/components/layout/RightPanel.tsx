import { useEffect, useRef } from "react";
import { FolderTree, GitBranch, Globe2, PanelRightClose, PanelRightOpen, Sparkles } from "lucide-react";
import { useUIStore } from "../../stores/uiStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useProjectStore } from "../../stores/projectStore";
import { ProjectGitChanges } from "../project/ProjectGitChanges";
import { ProjectExplorer } from "../project/ProjectExplorer";
import { SkillsModule } from "../skills/SkillsModule";
import { BrowserPanel } from "../browser/BrowserPanel";

const PANEL_SLOTS = [
  { id: "browser", label: "Browser", icon: Globe2 },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "skills", label: "Skills", icon: Sparkles },
] as const;

export function RightPanel() {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspace = useWorkspaceStore((state) => state.workspaces.find((item) => item.id === state.activeWorkspaceId));
  const isOpen = useUIStore((state) => state.rightPanelOpen);
  const width = useUIStore((state) => state.rightPanelWidth);
  const activeView = useUIStore((state) => state.rightPanelActiveView);
  const togglePanel = useUIStore((state) => state.toggleRightPanel);
  const setPanelWidth = useUIStore((state) => state.setRightPanelWidth);
  const setActiveView = useUIStore((state) => state.setRightPanelActiveView);
  const clearSelection = useProjectStore((state) => state.clearSelection);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (activeWorkspaceId) clearSelection(activeWorkspaceId);
  }, [activeWorkspaceId, clearSelection]);

  useEffect(() => {
    if (isOpen && !activeView) setActiveView("files");
  }, [activeView, isOpen, setActiveView]);

  const changePanelView = (view: string) => {
    if (view === activeView) return;
    if (activeWorkspaceId) clearSelection(activeWorkspaceId);
    setActiveView(view);
  };

  const openPanel = () => {
    if (activeWorkspaceId) clearSelection(activeWorkspaceId);
    setActiveView("files");
    if (!isOpen) togglePanel();
  };

  const handleResizeMouseDown = (event: React.MouseEvent) => {
    event.preventDefault();
    const element = panelRef.current;
    if (!element) return;
    const startX = event.clientX;
    const startWidth = element.getBoundingClientRect().width;
    const handleMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.max(330, Math.min(520, startWidth + startX - moveEvent.clientX));
      element.style.width = `${nextWidth}px`;
    };
    const handleUp = () => {
      const finalWidth = Number.parseFloat(element.style.width);
      if (Number.isFinite(finalWidth)) setPanelWidth(Math.round(finalWidth));
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  };

  if (!isOpen) {
    return (
      <aside className="flex h-full w-10 shrink-0 flex-col items-center border-l border-neutral-border bg-neutral-surface py-2" aria-label="Workspace tools">
        <button type="button" onClick={openPanel} className="ui-icon-button h-8 w-8 text-primary" title="Apri workspace tools" aria-label="Apri workspace tools">
          <PanelRightOpen size={15} />
        </button>
      </aside>
    );
  }

  const panelWidth = Math.max(330, Math.min(520, width));
  const activeSlot = PANEL_SLOTS.find((slot) => slot.id === activeView) ?? PANEL_SLOTS[1];
  const ActiveIcon = activeSlot.icon;

  return (
    <aside
      ref={panelRef}
      className="relative flex h-full shrink-0 flex-col border-l border-neutral-border bg-neutral-surface"
      style={{ width: panelWidth, minWidth: 330 }}
      aria-label="Workspace tools"
    >
      <div onMouseDown={handleResizeMouseDown} className="group absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize" aria-hidden="true">
        <span className="absolute inset-y-0 right-1 w-px bg-transparent transition-colors group-hover:bg-primary/60" />
      </div>

      <div className="flex h-[49px] shrink-0 items-center justify-between border-b border-neutral-border px-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <ActiveIcon size={15} className="text-primary" />
          <span className="truncate text-xs font-semibold text-neutral-text">{activeSlot.label}</span>
        </div>
        <button type="button" onClick={togglePanel} className="ui-icon-button h-8 w-8" title="Chiudi pannello" aria-label="Chiudi pannello">
          <PanelRightClose size={15} />
        </button>
      </div>

      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-neutral-border px-2">
        {PANEL_SLOTS.map(({ id, label, icon: Icon }) => {
          const active = activeView === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => changePanelView(id)}
              className={`flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-[10px] font-semibold transition-colors ${
                active ? "bg-white/[0.07] text-neutral-text" : "text-neutral-text-muted hover:bg-white/[0.04] hover:text-neutral-text-dim"
              }`}
              title={label}
              aria-label={label}
            >
              <Icon size={12} />
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {activeView === "browser" ? (
        <div className="flex min-h-0 min-w-0 flex-1"><BrowserPanel /></div>
      ) : activeView === "skills" ? (
        <SkillsModule />
      ) : activeWorkspaceId && workspace ? (
        <>
          <div className={activeView === "files" || !activeView ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
            <ProjectExplorer workspaceId={activeWorkspaceId} workspaceName={workspace.name} rootPath={workspace.rootPath} />
          </div>
          <div className={activeView === "git" ? "flex min-h-0 min-w-0 flex-1" : "hidden"}>
            <ProjectGitChanges workspaceId={activeWorkspaceId} workspaceName={workspace.name} />
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <FolderTree size={22} className="mb-2 text-neutral-text-muted" strokeWidth={1.4} />
          <p className="text-xs font-semibold text-neutral-text">No workspace selected</p>
          <p className="mt-1 text-[10px] leading-relaxed text-neutral-text-muted">Select a workspace to inspect its files and changes.</p>
        </div>
      )}
    </aside>
  );
}
