import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UIStore {
  isCollapsed: boolean;
  activeModal: string | null;
  searchQuery: string;
  wizardOpen: boolean;
  sidebarWidth: number;

  toggleSidebar: () => void;
  openModal: (modal: string) => void;
  closeModal: () => void;
  setSearchQuery: (query: string) => void;
  setWizardOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
}

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      isCollapsed: false,
      activeModal: null,
      searchQuery: "",
      wizardOpen: false,
      sidebarWidth: 360,

      toggleSidebar: () =>
        set((state) => ({ isCollapsed: !state.isCollapsed })),

      openModal: (modal) => set({ activeModal: modal }),

      closeModal: () => set({ activeModal: null }),

      setSearchQuery: (query) => set({ searchQuery: query }),

      setWizardOpen: (open) => set({ wizardOpen: open }),

      setSidebarWidth: (width) => set({ sidebarWidth: width }),
    }),
    {
      name: "traflix-ui",
      partialize: (state) => ({
        sidebarWidth: state.sidebarWidth,
        isCollapsed: state.isCollapsed,
      }),
    },
  ),
);
