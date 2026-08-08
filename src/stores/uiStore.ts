import { create } from "zustand";
import { persist } from "zustand/middleware";

export type RightPanelView = "browser" | "files" | "git" | "skills" | null;

const MIN_SIDEBAR_WIDTH = 260;
const MAX_SIDEBAR_WIDTH = 380;
const MIN_RIGHT_PANEL_WIDTH = 360;
const MAX_RIGHT_PANEL_WIDTH = 560;
const RIGHT_PANEL_LAYOUT_VERSION = 2;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function normalizeRightPanelView(value: unknown): RightPanelView {
  return value === "browser" || value === "files" || value === "git" || value === "skills"
    ? value
    : null;
}

interface UIStore {
  isCollapsed: boolean;
  activeModal: string | null;
  searchQuery: string;
  wizardOpen: boolean;
  sidebarWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  rightPanelLayoutVersion: number;
  rightPanelActiveView: RightPanelView;
  toggleSidebar: () => void;
  openModal: (modal: string) => void;
  closeModal: () => void;
  setSearchQuery: (query: string) => void;
  setWizardOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  toggleRightPanel: () => void;
  setRightPanelWidth: (width: number) => void;
  setRightPanelActiveView: (view: RightPanelView) => void;
}

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      isCollapsed: false,
      activeModal: null,
      searchQuery: "",
      wizardOpen: false,
      sidebarWidth: 300,
      rightPanelOpen: false,
      rightPanelWidth: 420,
      rightPanelLayoutVersion: RIGHT_PANEL_LAYOUT_VERSION,
      rightPanelActiveView: null,
      toggleSidebar: () => set((state) => ({ isCollapsed: !state.isCollapsed })),
      openModal: (modal) => set({ activeModal: modal }),
      closeModal: () => set({ activeModal: null }),
      setSearchQuery: (query) => set({ searchQuery: query }),
      setWizardOpen: (open) => set({ wizardOpen: open }),
      setSidebarWidth: (width) =>
        set({ sidebarWidth: clamp(width, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, 300) }),
      toggleRightPanel: () =>
        set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
      setRightPanelWidth: (width) =>
        set({
          rightPanelWidth: clamp(
            width,
            MIN_RIGHT_PANEL_WIDTH,
            MAX_RIGHT_PANEL_WIDTH,
            420,
          ),
        }),
      setRightPanelActiveView: (view) =>
        set({ rightPanelActiveView: normalizeRightPanelView(view) }),
    }),
    {
      name: "traflix-ui",
      partialize: (state) => ({
        sidebarWidth: state.sidebarWidth,
        isCollapsed: state.isCollapsed,
        rightPanelWidth: state.rightPanelWidth,
        rightPanelLayoutVersion: state.rightPanelLayoutVersion,
        rightPanelOpen: state.rightPanelOpen,
        rightPanelActiveView: state.rightPanelActiveView,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<UIStore>;
        return {
          ...current,
          isCollapsed:
            typeof saved.isCollapsed === "boolean"
              ? saved.isCollapsed
              : current.isCollapsed,
          rightPanelOpen:
            typeof saved.rightPanelOpen === "boolean"
              ? saved.rightPanelOpen
              : current.rightPanelOpen,
          sidebarWidth: clamp(
            saved.sidebarWidth,
            MIN_SIDEBAR_WIDTH,
            MAX_SIDEBAR_WIDTH,
            current.sidebarWidth,
          ),
          rightPanelWidth: clamp(
            saved.rightPanelLayoutVersion === RIGHT_PANEL_LAYOUT_VERSION
              ? saved.rightPanelWidth
              : saved.rightPanelWidth === 390
                ? 420
                : saved.rightPanelWidth,
            MIN_RIGHT_PANEL_WIDTH,
            MAX_RIGHT_PANEL_WIDTH,
            current.rightPanelWidth,
          ),
          rightPanelLayoutVersion: RIGHT_PANEL_LAYOUT_VERSION,
          rightPanelActiveView: normalizeRightPanelView(saved.rightPanelActiveView),
        };
      },
    },
  ),
);
