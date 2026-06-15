import { create } from "zustand";

interface UIStore {
  isCollapsed: boolean;
  activeModal: string | null;
  searchQuery: string;

  toggleSidebar: () => void;
  openModal: (modal: string) => void;
  closeModal: () => void;
  setSearchQuery: (query: string) => void;
}

export const useUIStore = create<UIStore>()((set) => ({
  isCollapsed: false,
  activeModal: null,
  searchQuery: "",

  toggleSidebar: () =>
    set((state) => ({ isCollapsed: !state.isCollapsed })),

  openModal: (modal) => set({ activeModal: modal }),

  closeModal: () => set({ activeModal: null }),

  setSearchQuery: (query) => set({ searchQuery: query }),
}));
