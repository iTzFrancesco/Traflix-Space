import { useEffect, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useUIStore } from "../stores/uiStore";

type ShortcutHandler = () => void;

interface ShortcutDef {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: ShortcutHandler;
  description: string;
}

export function useKeyboardShortcuts(extraShortcuts?: ShortcutDef[], onCloseTerminal?: () => void) {
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const openModal = useUIStore((s) => s.openModal);
  const setWizardOpen = useUIStore((s) => s.setWizardOpen);

  const workspacesRef = useRef(useWorkspaceStore.getState().workspaces);
  const activeWorkspaceIdRef = useRef(useWorkspaceStore.getState().activeWorkspaceId);
  const extraShortcutsRef = useRef(extraShortcuts);
  extraShortcutsRef.current = extraShortcuts;
  const onCloseTerminalRef = useRef(onCloseTerminal);
  onCloseTerminalRef.current = onCloseTerminal;

  useEffect(() => {
    const unsub = useWorkspaceStore.subscribe((s) => {
      workspacesRef.current = s.workspaces;
      activeWorkspaceIdRef.current = s.activeWorkspaceId;
    });
    return unsub;
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const workspaces = workspacesRef.current;
      const activeWorkspaceId = activeWorkspaceIdRef.current;

      const defaults: ShortcutDef[] = [
        {
          key: "n",
          ctrl: true,
          handler: () => openModal("new-workspace"),
          description: "Nuovo workspace",
        },
        {
          key: "Tab",
          ctrl: true,
          handler: () => {
            if (workspaces.length === 0) return;
            const currentIndex = workspaces.findIndex((w) => w.id === activeWorkspaceId);
            const nextIndex = (currentIndex + 1) % workspaces.length;
            setActiveWorkspace(workspaces[nextIndex].id);
          },
          description: "Prossimo workspace",
        },
        {
          key: "d",
          ctrl: true,
          shift: true,
          handler: () => setWizardOpen(true),
          description: "Nuovo workspace (wizard)",
        },
        {
          key: "d",
          shift: true,
          alt: true,
          handler: () => {
            const fn = (window as any).__traflix_add_terminal;
            if (typeof fn === "function") fn();
          },
          description: "Nuovo terminale",
        },
        {
          key: "x",
          shift: true,
          alt: true,
          handler: () => {
            const store = useTerminalStore.getState();
            const activeId = activeWorkspaceId
              ? store.activeTerminalByWorkspace[activeWorkspaceId] ?? null
              : null;
            if (activeId && onCloseTerminalRef.current) {
              onCloseTerminalRef.current();
            }
          },
          description: "Richiedi chiusura terminale attivo",
        },
      ];

      const allShortcuts = [...defaults, ...(extraShortcutsRef.current || [])];

      for (const shortcut of allShortcuts) {
        const ctrlMatch = shortcut.ctrl ? (e.ctrlKey || e.metaKey) : !e.ctrlKey && !e.metaKey;
        const shiftMatch = shortcut.shift ? e.shiftKey : !e.shiftKey;
        const altMatch = shortcut.alt ? e.altKey : !e.altKey;

        if (
          e.key.toLowerCase() === shortcut.key.toLowerCase() &&
          ctrlMatch &&
          shiftMatch &&
          altMatch
        ) {
          e.preventDefault();
          e.stopPropagation();
          shortcut.handler();
          return;
        }
      }
    };

    // Usa capture phase per intercettare eventi PRIMA che xterm.js li catturi
    document.addEventListener("keydown", handler, { capture: true });
    return () => document.removeEventListener("keydown", handler, { capture: true });
  }, [setActiveWorkspace, openModal]);
}
