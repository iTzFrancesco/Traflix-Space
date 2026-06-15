import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface Preset {
  id: string;
  name: string;
  folderPath: string;
  terminalCount: number;
  agentCounts: Record<string, number>;
  createdAt: string;
}

interface PresetStore {
  presets: Preset[];
  addPreset: (preset: Preset) => void;
  removePreset: (id: string) => void;
}

export const usePresetStore = create<PresetStore>()(
  persist(
    (set) => ({
      presets: [],

      addPreset: (preset) =>
        set((state) => ({
          presets: [...state.presets, preset],
        })),

      removePreset: (id) =>
        set((state) => ({
          presets: state.presets.filter((p) => p.id !== id),
        })),
    }),
    {
      name: "traflix-presets",
    },
  ),
);
