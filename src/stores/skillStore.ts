import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/shallow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const encoder = new TextEncoder();

/* ─── Types ─── */

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
}

export interface PendingSkillDrop {
  /** Nomi accumulati delle skill droppate */
  names: string[];
  /** Timer per il debounce di invio */
  timer: ReturnType<typeof setTimeout> | null;
}

/* ─── Store ─── */

interface SkillStore {
  /** Lista skills dalla scansione disco (NON persistita) */
  skills: SkillInfo[];
  /** ID delle skill preferite (persistito) */
  favorites: string[];
  /** Ordine custom — se vuoto, usa ordine alfabetico (persistito) */
  order: string[];
  /** Flag loading iniziale */
  loading: boolean;
  /** Skills droppate in pending per terminale (keyed per terminalId, NON persistito) */
  pendingDrops: Record<string, PendingSkillDrop>;

  /* Actions */
  setSkills: (skills: SkillInfo[]) => void;
  loadSkills: () => Promise<void>;
  toggleFavorite: (id: string) => void;
  setOrder: (order: string[]) => void;
  reorder: (fromIndex: number, toIndex: number) => void;

  /* Pending drops */
  addPendingDrop: (terminalId: string, skillName: string) => void;
  flushPendingDrop: (terminalId: string) => string[];
  clearPendingDrop: (terminalId: string) => void;
}

export const useSkillStore = create<SkillStore>()(
  persist(
    (set, get) => ({
      skills: [],
      favorites: [],
      order: [],
      loading: false,
      pendingDrops: {},

      setSkills: (skills) => set({ skills, loading: false }),

      loadSkills: async () => {
        set({ loading: true });
        try {
          const skills = await invoke<SkillInfo[]>("list_skills");
          set({ skills, loading: false });
        } catch (err) {
          console.error("Errore caricamento skills:", err);
          set({ loading: false });
        }
      },

      toggleFavorite: (id) =>
        set((state) => {
          const exists = state.favorites.includes(id);
          return {
            favorites: exists
              ? state.favorites.filter((f) => f !== id)
              : [...state.favorites, id],
          };
        }),

      setOrder: (order) => set({ order }),

      reorder: (fromIndex, toIndex) =>
        set((state) => {
          const sorted = getSortedSkills(state);
          const ids = sorted.map((s) => s.id);
          const [moved] = ids.splice(fromIndex, 1);
          ids.splice(toIndex, 0, moved);
          return { order: ids };
        }),

      /* Pending drops: accumula nomi con debounce */
      addPendingDrop: (terminalId, skillName) =>
        set((state) => {
          const existing = state.pendingDrops[terminalId];
          if (existing) {
            // Se già esiste, aggiungi nome (senza mutare, evita duplicati)
            const names = existing.names.includes(skillName)
              ? existing.names
              : [...existing.names, skillName];
            // Azzera timer
            if (existing.timer) clearTimeout(existing.timer);
            const timer = setTimeout(() => {
              get().flushPendingDrop(terminalId);
            }, 500);
            return {
              pendingDrops: {
                ...state.pendingDrops,
                [terminalId]: { names, timer },
              },
            };
          }

          const timer = setTimeout(() => {
            get().flushPendingDrop(terminalId);
          }, 500);

          return {
            pendingDrops: {
              ...state.pendingDrops,
              [terminalId]: { names: [skillName], timer },
            },
          };
        }),

      flushPendingDrop: (terminalId) => {
        const state = get();
        const pending = state.pendingDrops[terminalId];
        if (!pending || pending.names.length === 0) return [];

        const names = [...pending.names];
        // Svuota subito
        set((s) => {
          const next = { ...s.pendingDrops };
          delete next[terminalId];
          return { pendingDrops: next };
        });

        // Costruisce la frase e scrive nel PTY
        const msg = buildSkillMessage(names);
        const data = Array.from(encoder.encode(msg));
        invoke("terminal_write", {
          terminalId,
          data,
        }).catch((err) => {
          console.error("Errore scrittura skill drop:", err);
        });

        return names;
      },

      clearPendingDrop: (terminalId) =>
        set((state) => {
          const existing = state.pendingDrops[terminalId];
          if (existing?.timer) clearTimeout(existing.timer);
          const next = { ...state.pendingDrops };
          delete next[terminalId];
          return { pendingDrops: next };
        }),
    }),
    {
      name: "traflix-skills",
      partialize: (state) => ({
        favorites: state.favorites,
        order: state.order,
      }),
    },
  ),
);

/* ─── Helpers ─── */

function getSortedSkills(state: SkillStore): SkillInfo[] {
  const { skills, favorites, order } = state;

  // SEMPRE dividi in preferite e non-preferite
  const favList = skills.filter((s) => favorites.includes(s.id));
  const restList = skills.filter((s) => !favorites.includes(s.id));

  if (order.length > 0) {
    // Ordine custom: rispetta l'ordine DENTRO ciascun gruppo
    const orderedFavs: SkillInfo[] = [];
    const remainingFavs: SkillInfo[] = [];
    for (const id of order) {
      const skill = favList.find((s) => s.id === id);
      if (skill) orderedFavs.push(skill);
    }
    for (const skill of favList) {
      if (!orderedFavs.find((s) => s.id === skill.id)) {
        remainingFavs.push(skill);
      }
    }

    const orderedRest: SkillInfo[] = [];
    const remainingRest: SkillInfo[] = [];
    for (const id of order) {
      const skill = restList.find((s) => s.id === id);
      if (skill) orderedRest.push(skill);
    }
    for (const skill of restList) {
      if (!orderedRest.find((s) => s.id === skill.id)) {
        remainingRest.push(skill);
      }
    }

    return [...orderedFavs, ...remainingFavs, ...orderedRest, ...remainingRest];
  }

  // Senza ordine custom: preferite in cima, poi alfabetico
  favList.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  restList.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return [...favList, ...restList];
}

/** Hook selector che restituisce le skills ordinate con shallow comparison */
export function useSortedSkills() {
  return useStoreWithEqualityFn(
    useSkillStore,
    (s) => {
      const sorted = getSortedSkills(s);
      return sorted.map((skill) => ({
        ...skill,
        isFavorite: s.favorites.includes(skill.id),
      }));
    },
    shallow,
  );
}

/* ─── Helpers ─── */

function buildSkillMessage(names: string[]): string {
  // Formato: "usa la skill, nome1, nome2, ..."
  return `usa la skill, ${names.join(", ")}
`;
}

/* ─── Setup listener skills-changed ─── */
let listenerSetup = false;

export function setupSkillsListener() {
  if (listenerSetup) return;
  listenerSetup = true;

  // Carica skills all'avvio
  useSkillStore.getState().loadSkills();

  // Ascolta eventi di cambiamento
  listen("skills-changed", () => {
    useSkillStore.getState().loadSkills();
  }).catch((err) => {
    console.error("Errore setup skills listener:", err);
  });
}
