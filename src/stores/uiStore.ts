import { create } from "zustand";

interface UIStore {
  isCollapsed: boolean;
  activeModal: string | null;
  searchQuery: string;
  wizardOpen: boolean;

  toggleSidebar: () => void;
  openModal: (modal: string) => void;
  closeModal: () => void;
  setSearchQuery: (query: string) => void;
  setWizardOpen: (open: boolean) => void;
}

export const useUIStore = create<UIStore>()((set) => ({
  isCollapsed: false,
  activeModal: null,
  searchQuery: "",
  wizardOpen: false,

  toggleSidebar: () =>
    set((state) => ({ isCollapsed: !state.isCollapsed })),

  openModal: (modal) => set({ activeModal: modal }),

  closeModal: () => set({ activeModal: null }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  setWizardOpen: (open) => set({ wizardOpen: open }),
}));
