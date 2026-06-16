import { useEffect, useRef } from "react";
import { useWorkspaceStore } from "../stores/workspaceStore";
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

export function useKeyboardShortcuts(extraShortcuts?: ShortcutDef[]) {
  // Selector stabili: solo le action, non lo stato
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const openModal = useUIStore((s) => s.openModal);

  // Ref per stato mutabile — leggiamo il valore fresco nel handler
  const workspacesRef = useRef(useWorkspaceStore.getState().workspaces);
  const activeWorkspaceIdRef = useRef(useWorkspaceStore.getState().activeWorkspaceId);
  const extraShortcutsRef = useRef(extraShortcuts);
  extraShortcutsRef.current = extraShortcuts;

  // Sottoscrivi i cambiamenti di stato nel ref
  useEffect(() => {
    const unsub = useWorkspaceStore.subscribe((s) => {
      workspacesRef.current = s.workspaces;
      activeWorkspaceIdRef.current = s.activeWorkspaceId;
    });
    return unsub;
  }, []);

  // Listener unico: legge stato fresco dai refs, mai re-registrato
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const workspaces = workspacesRef.current;
      const activeWorkspaceId = activeWorkspaceIdRef.current;

      // Shortcut default
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

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [setActiveWorkspace, openModal]);
}
