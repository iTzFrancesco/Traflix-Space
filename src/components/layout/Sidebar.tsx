import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  Check,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useTerminalStore } from "../../stores/terminalStore";
import { useUIStore } from "../../stores/uiStore";
import { invokeWithTimeout } from "../../lib/timeout";
import { NewSpaceWizard } from "../workspace/NewSpaceWizard";
import { getWorkspaceColor } from "../../lib/workspaceColors";
import { useJarvisStore } from "../../stores/jarvisStore";

const IS_DEV = import.meta.env.DEV;
const MIN_SIDEBAR = 260;
const MAX_SIDEBAR = 380;

export function Sidebar() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActiveWorkspace);
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const removeWorkspace = useWorkspaceStore((state) => state.removeWorkspace);
  const terminals = useTerminalStore((state) => state.terminals);
  const isCollapsed = useUIStore((state) => state.isCollapsed);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const activeModal = useUIStore((state) => state.activeModal);
  const closeModal = useUIStore((state) => state.closeModal);
  const wizardOpen = useUIStore((state) => state.wizardOpen);
  const setWizardOpen = useUIStore((state) => state.setWizardOpen);
  const sidebarWidth = useUIStore((state) => state.sidebarWidth);
  const setSidebarWidth = useUIStore((state) => state.setSidebarWidth);
  const jarvisEnabled = useJarvisStore((state) => state.settings.jarvis.enabled);
  const showJarvis = useJarvisStore((state) => state.showJarvis);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; workspaceId: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const pendingByWorkspace = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const terminal of Object.values(terminals)) {
      if (terminal.agentAttentionRequired) counts[terminal.workspaceId] = (counts[terminal.workspaceId] ?? 0) + 1;
    }
    return counts;
  }, [terminals]);

  useEffect(() => {
    if (activeModal !== "new-workspace") return;
    setWizardOpen(true);
    closeModal();
  }, [activeModal, closeModal, setWizardOpen]);

  useEffect(() => {
    if (!renamingId || !inputRef.current) return;
    inputRef.current.focus();
    inputRef.current.select();
  }, [renamingId]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const timer = window.setTimeout(() => {
      document.addEventListener("click", close);
      document.addEventListener("contextmenu", close);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [contextMenu]);

  const openJarvis = () => {
    if (!jarvisEnabled) void showJarvis();
  };

  const startRename = (id: string, currentName: string) => {
    setRenamingId(id);
    setRenameValue(currentName);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue("");
  };

  const confirmRename = (id: string) => {
    const next = renameValue.trim();
    if (next) updateWorkspace(id, { name: next });
    cancelRename();
  };

  const handleDelete = async (id: string) => {
    try {
      await invokeWithTimeout(() => invoke("delete_workspace", { id }), 10000);
    } catch (error) {
      console.error("Errore eliminazione workspace backend:", error);
    }
    useTerminalStore.getState().killWorkspaceTerminals(id);
    removeWorkspace(id);
    setConfirmDeleteId(null);
  };

  const handleResizeMouseDown = (event: React.MouseEvent) => {
    event.preventDefault();
    const element = sidebarRef.current;
    if (!element) return;
    const startX = event.clientX;
    const startWidth = element.getBoundingClientRect().width;

    const handleMove = (moveEvent: MouseEvent) => {
      const width = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, startWidth + moveEvent.clientX - startX));
      element.style.width = `${width}px`;
    };
    const handleUp = () => {
      const width = Number.parseFloat(element.style.width);
      if (Number.isFinite(width)) setSidebarWidth(Math.round(width));
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

  if (isCollapsed) {
    return (
      <>
        <aside className="flex h-full w-[58px] shrink-0 flex-col items-center border-r border-neutral-border bg-neutral-surface py-2" aria-label="Barra laterale degli spazi di lavoro">
          <button type="button" onClick={toggleSidebar} className="ui-icon-button" title="Espandi barra laterale" aria-label="Espandi barra laterale">
            <PanelLeftOpen size={16} />
          </button>
          <button type="button" onClick={() => setWizardOpen(true)} className="ui-icon-button mt-1 text-primary" title="Nuovo spazio" aria-label="Nuovo spazio">
            <Plus size={17} />
          </button>
          <button type="button" onClick={openJarvis} className="ui-icon-button mt-1 text-primary" title="Jarvis" aria-label="Jarvis">
            <Sparkles size={16} />
          </button>

          <div className="my-2 h-px w-6 bg-neutral-border" />
          <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-1 py-1">
            {workspaces.map((workspace, index) => {
              const active = workspace.id === activeWorkspaceId;
              const color = getWorkspaceColor(index);
              const pending = pendingByWorkspace[workspace.id] ?? 0;
              return (
                <button
                  key={workspace.id}
                  type="button"
                  onClick={() => setActiveWorkspace(workspace.id)}
                  className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-colors ${active ? "bg-white/[0.07]" : "hover:bg-white/[0.045]"}`}
                  title={workspace.name}
                  aria-label={workspace.name}
                >
                  <span className="h-3.5 w-3.5 rounded-[3px]" style={{ backgroundColor: color, opacity: active ? 1 : 0.72 }} />
                  {pending > 0 && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary" aria-label={`${pending} in attesa`} />}
                </button>
              );
            })}
          </div>
          {IS_DEV && <span className="mb-1 h-1.5 w-1.5 rounded-full bg-danger" title="Build di sviluppo" />}
        </aside>
        <NewSpaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      </>
    );
  }

  const width = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, sidebarWidth));

  return (
    <>
      <aside
        ref={sidebarRef}
        className="relative flex h-full shrink-0 flex-col border-r border-neutral-border bg-neutral-surface"
        style={{ width }}
        aria-label="Barra laterale degli spazi di lavoro"
      >
        <div onMouseDown={handleResizeMouseDown} className="group absolute -right-1 top-0 z-20 h-full w-2 cursor-col-resize" aria-hidden="true">
          <span className="absolute inset-y-0 left-1 w-px bg-transparent transition-colors group-hover:bg-primary/60" />
        </div>

        <div className="relative flex h-[45px] shrink-0 items-center justify-center gap-2 border-b border-neutral-border px-2">
          <button type="button" onClick={toggleSidebar} className="ui-icon-button absolute left-2 h-7 w-7" title="Comprimi barra laterale" aria-label="Comprimi barra laterale">
            <PanelLeftClose size={15} />
          </button>
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-white/[0.10] bg-white/[0.025] px-2.5 text-[11px] font-semibold text-neutral-text-dim transition-colors hover:border-primary/35 hover:bg-white/[0.05] hover:text-neutral-text"
          >
            <Plus size={13} className="text-primary" />
            Nuovo spazio
          </button>
        </div>

        <div className="flex h-10 items-center justify-end px-2.5 pt-1">
          <div className="group/sidebar-jarvis relative">
            <button
              type="button"
              onClick={openJarvis}
              className="relative flex h-8 w-8 items-center justify-center rounded-md text-primary transition-colors hover:bg-white/[0.07] hover:text-primary-light"
              title={jarvisEnabled ? "Jarvis è visibile" : "Mostra Jarvis"}
              aria-label={jarvisEnabled ? "Jarvis è visibile" : "Mostra Jarvis"}
            >
              <Sparkles size={16} />
              <span className={`absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full border border-neutral-surface ${jarvisEnabled ? "bg-signal" : "bg-neutral-text-muted"}`} />
            </button>
            <span className="pointer-events-none absolute right-0 top-full z-50 mt-1 whitespace-nowrap rounded border border-neutral-border bg-neutral-elevated px-2 py-1 text-[10px] font-medium text-neutral-text-dim opacity-0 shadow-lg transition-opacity group-hover/sidebar-jarvis:opacity-100">
              Jarvis
            </span>
          </div>
        </div>

        <div className="flex items-center justify-between px-3 pb-2 pt-2">
          <span className="text-[11px] font-semibold text-neutral-text-dim">Spazi di lavoro</span>
          <span className="font-mono text-[10px] text-neutral-text-muted">{workspaces.length}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <div className="space-y-1">
            {workspaces.map((workspace, index) => {
              const active = workspace.id === activeWorkspaceId;
              const color = getWorkspaceColor(index);
              const terminalCount = workspace.terminalCount;
              const pending = pendingByWorkspace[workspace.id] ?? 0;
              const renaming = renamingId === workspace.id;
              const deleting = confirmDeleteId === workspace.id;

              if (renaming) {
                return (
                  <div key={workspace.id} className="flex h-11 items-center gap-2 rounded-md border border-primary/30 bg-neutral-elevated px-2">
                    <span className="h-3 w-3 shrink-0 rounded-[3px]" style={{ backgroundColor: color }} />
                    <input
                      ref={inputRef}
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") confirmRename(workspace.id);
                        if (event.key === "Escape") cancelRename();
                      }}
                      onBlur={() => confirmRename(workspace.id)}
                      className="min-w-0 flex-1 border-b border-neutral-border bg-transparent py-1 text-xs text-neutral-text outline-none focus:border-primary"
                    />
                    <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => confirmRename(workspace.id)} className="ui-icon-button h-7 w-7 text-signal" aria-label="Conferma nome"><Check size={14} /></button>
                    <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={cancelRename} className="ui-icon-button h-7 w-7" aria-label="Annulla"><X size={14} /></button>
                  </div>
                );
              }

              if (deleting) {
                return (
                  <div key={workspace.id} className="flex min-h-11 items-center gap-2 rounded-md border border-danger/30 bg-danger/[0.06] px-2 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs text-neutral-text">Eliminare {workspace.name}?</span>
                    <button type="button" onClick={() => void handleDelete(workspace.id)} className="secondary-button h-7 min-h-7 border-danger/30 px-2 text-danger">Elimina</button>
                    <button type="button" onClick={() => setConfirmDeleteId(null)} className="ui-icon-button h-7 w-7" aria-label="Annulla"><X size={13} /></button>
                  </div>
                );
              }

              return (
                <div
                  key={workspace.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveWorkspace(workspace.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({ x: event.clientX, y: event.clientY, workspaceId: workspace.id });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") setActiveWorkspace(workspace.id);
                  }}
                  className={`group relative flex h-11 items-center gap-2 rounded-md border px-2 transition-colors ${
                    active
                      ? "border-white/[0.12] bg-white/[0.06]"
                      : "border-transparent hover:border-white/[0.07] hover:bg-white/[0.035]"
                  }`}
                >
                  <span className="h-3.5 w-3.5 shrink-0 rounded-[3px]" style={{ backgroundColor: color, opacity: active ? 1 : 0.75 }} />
                  <span className={`min-w-0 flex-1 truncate text-xs ${active ? "font-semibold text-neutral-text" : "font-medium text-neutral-text-dim"}`}>
                    {workspace.name}
                  </span>
                  {terminalCount > 0 && <span className="font-mono text-[10px] text-neutral-text-muted">{terminalCount}</span>}
                  {pending > 0 && (
                    <span className="agent-attention-badge inline-flex min-w-5 items-center justify-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold text-primary" title={`${pending} terminali in attesa`}>
                      <Bell size={10} /> {pending}
                    </span>
                  )}
                  <div className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md bg-neutral-elevated p-0.5 group-hover:flex group-focus-within:flex">
                    <button
                      type="button"
                      onClick={(event) => { event.stopPropagation(); startRename(workspace.id, workspace.name); }}
                      className="ui-icon-button h-7 w-7"
                      title="Rinomina spazio"
                      aria-label="Rinomina spazio"
                    ><Pencil size={13} /></button>
                    <button
                      type="button"
                      onClick={(event) => { event.stopPropagation(); setConfirmDeleteId(workspace.id); }}
                      className="ui-icon-button h-7 w-7 hover:text-danger"
                      title="Elimina spazio"
                      aria-label="Elimina spazio"
                    ><Trash2 size={13} /></button>
                  </div>
                </div>
              );
            })}
          </div>

          {workspaces.length === 0 && (
            <div className="px-4 py-10 text-center">
              <p className="text-xs font-medium text-neutral-text-dim">Nessuno spazio ancora</p>
              <p className="mt-1 text-[10px] text-neutral-text-muted">Creane uno per avviare una sessione terminale.</p>
            </div>
          )}
        </div>

        {IS_DEV && <div className="border-t border-neutral-border px-3 py-2 text-[9px] font-semibold text-danger">BUILD SVILUPPO</div>}
      </aside>

      <NewSpaceWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />

      {contextMenu && (
        <div
          className="fixed z-50 w-44 rounded-md border border-neutral-border bg-neutral-elevated p-1 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            onClick={() => {
              const workspace = workspaces.find((item) => item.id === contextMenu.workspaceId);
              if (workspace) startRename(workspace.id, workspace.name);
              setContextMenu(null);
            }}
            className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs text-neutral-text-dim hover:bg-white/[0.06] hover:text-neutral-text"
          ><Pencil size={13} /> Rinomina</button>
          <button
            type="button"
            onClick={() => { setConfirmDeleteId(contextMenu.workspaceId); setContextMenu(null); }}
            className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs text-danger hover:bg-danger/[0.08]"
          ><Trash2 size={13} /> Elimina</button>
        </div>
      )}
    </>
  );
}