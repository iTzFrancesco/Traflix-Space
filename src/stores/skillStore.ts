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
  /** Exact PTY lifetime targeted when the drop gesture occurred. */
  workspaceId: string;
  generation: number;
  processId: number | null;
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
  /** Ordine manuale persistito; i preferiti restano comunque nel gruppo alto */
  order: string[];
  /** Flag loading iniziale */
  loading: boolean;
  /** Errore dell'ultima scansione (NON persistito) */
  error: string | null;
  /** Skills droppate in pending per terminale (keyed per terminalId, NON persistito) */
  pendingDrops: Record<string, PendingSkillDrop>;

  /* Actions */
  setSkills: (skills: SkillInfo[]) => void;
  loadSkills: () => Promise<void>;
  toggleFavorite: (id: string) => void;
  reorder: (draggedId: string, targetId: string) => void;

  /* Pending drops */
  addPendingDrop: (
    terminalId: string,
    runtime: Pick<PendingSkillDrop, "workspaceId" | "generation" | "processId">,
    skillName: string,
  ) => void;
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
      error: null,
      pendingDrops: {},

      setSkills: (skills) => set({ skills, loading: false }),

      loadSkills: async () => {
        set({ loading: true, error: null });
        try {
          const skills = await invoke<SkillInfo[]>("list_skills");
          set({ skills, loading: false, error: null });
        } catch (err) {
          console.error("Errore caricamento skills:", err);
          set({
            loading: false,
            error: "Impossibile leggere la cartella delle skill.",
          });
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

      reorder: (draggedId, targetId) =>
        set((state) => {
          if (draggedId === targetId) return state;
          const ids = getSortedSkills(state).map((skill) => skill.id);
          const fromIndex = ids.indexOf(draggedId);
          const targetIndex = ids.indexOf(targetId);
          if (fromIndex < 0 || targetIndex < 0) return state;

          const [moved] = ids.splice(fromIndex, 1);
          ids.splice(ids.indexOf(targetId), 0, moved);
          return { order: ids };
        }),

      /* Pending drops: accumula nomi con debounce */
      addPendingDrop: (terminalId, runtime, skillName) =>
        set((state) => {
          const existing = state.pendingDrops[terminalId];
          if (
            existing &&
            existing.workspaceId === runtime.workspaceId &&
            existing.generation === runtime.generation &&
            existing.processId === runtime.processId
          ) {
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
                [terminalId]: { ...runtime, names, timer },
              },
            };
          }

          if (existing?.timer) clearTimeout(existing.timer);
          const timer = setTimeout(() => {
            get().flushPendingDrop(terminalId);
          }, 500);

          return {
            pendingDrops: {
              ...state.pendingDrops,
            [terminalId]: { ...runtime, names: [skillName], timer },
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
          workspaceId: pending.workspaceId,
          generation: pending.generation,
          processId: pending.processId,
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

  favList.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  restList.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return [...applyStoredOrder(favList, order), ...applyStoredOrder(restList, order)];
}

function applyStoredOrder(skills: SkillInfo[], order: string[]): SkillInfo[] {
  if (order.length === 0) return skills;
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const ordered: SkillInfo[] = [];

  for (const id of order) {
    const skill = byId.get(id);
    if (skill) ordered.push(skill);
  }
  for (const skill of skills) {
    if (!ordered.some((item) => item.id === skill.id)) ordered.push(skill);
  }
  return ordered;
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
  // Formato stabile e leggibile anche quando vengono trascinate più skill:
  // "usa la skill: research e grill-with-docs"
  // Nessun Invio automatico: il testo resta nel prompt e l'agente parte
  // solo quando l'utente conferma esplicitamente con Enter.
  return `usa la skill: ${names.join(" e ")}`;
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
