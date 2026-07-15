import { create } from "zustand";
import { persist } from "zustand/middleware";

export type RightPanelView = string | null;

interface UIStore {
  isCollapsed: boolean;
  activeModal: string | null;
  searchQuery: string;
  wizardOpen: boolean;
  sidebarWidth: number;

  /* Right panel state */
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  rightPanelActiveView: RightPanelView;

  toggleSidebar: () => void;
  openModal: (modal: string) => void;
  closeModal: () => void;
  setSearchQuery: (query: string) => void;
  setWizardOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;

  /* Right panel actions */
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
      sidebarWidth: 360,

      /* Right panel */
      rightPanelOpen: false,
      rightPanelWidth: 360,
      rightPanelActiveView: null,

      toggleSidebar: () =>
        set((state) => ({ isCollapsed: !state.isCollapsed })),

      openModal: (modal) => set({ activeModal: modal }),

      closeModal: () => set({ activeModal: null }),

      setSearchQuery: (query) => set({ searchQuery: query }),

      setWizardOpen: (open) => set({ wizardOpen: open }),

      setSidebarWidth: (width) => set({ sidebarWidth: width }),

      /* Right panel actions */
      toggleRightPanel: () =>
        set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
      setRightPanelWidth: (width) => set({ rightPanelWidth: width }),
      setRightPanelActiveView: (view) => set({ rightPanelActiveView: view }),
    }),
    {
      name: "traflix-ui",
      partialize: (state) => ({
        sidebarWidth: state.sidebarWidth,
        isCollapsed: state.isCollapsed,
        rightPanelWidth: state.rightPanelWidth,
        rightPanelOpen: state.rightPanelOpen,
      }),
    },
  ),
);
