import { useEffect } from "react";
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
  const { workspaces, activeWorkspaceId, setActiveWorkspace } = useWorkspaceStore();
  const { openModal } = useUIStore();

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

  const allShortcuts = [...defaults, ...(extraShortcuts || [])];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
  }, [allShortcuts]);
}
