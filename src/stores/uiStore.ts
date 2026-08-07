import { create } from "zustand";
import { persist } from "zustand/middleware";

export type RightPanelView = "browser" | "files" | "git" | "skills" | null;

const MIN_SIDEBAR_WIDTH = 260;
const MAX_SIDEBAR_WIDTH = 380;
const MIN_RIGHT_PANEL_WIDTH = 330;
const MAX_RIGHT_PANEL_WIDTH = 520;

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
      rightPanelWidth: 390,
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
            390,
          ),
        }),
      setRightPanelActiveView: (view) => ({
        rightPanelActiveView: normalizeRightPanelView(view),
      }),
    }),
    {
      name: "traflix-ui",
      partialize: (state) => ({
        sidebarWidth: state.sidebarWidth,
        isCollapsed: state.isCollapsed,
        rightPanelWidth: state.rightPanelWidth,
        rightPanelOpen: state.rightPanelOpen,
        rightPanelActiveView: state.rightPanelActiveView,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<UIStore>;
        return {
          ...current,
          ...saved,
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
            saved.rightPanelWidth,
            MIN_RIGHT_PANEL_WIDTH,
            MAX_RIGHT_PANEL_WIDTH,
            current.rightPanelWidth,
          ),
          rightPanelActiveView: normalizeRightPanelView(saved.rightPanelActiveView),
        };
      },
    },
  ),
);
