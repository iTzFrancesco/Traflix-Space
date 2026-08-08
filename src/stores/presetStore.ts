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
  updatePreset: (id: string, updates: Partial<Preset>) => void;
  removePreset: (id: string) => void;
}

function boundedTerminalCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(8, Math.floor(value)))
    : 2;
}

function boundedAgentCounts(value: unknown, terminalCount: number): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  let remaining = terminalCount;
  const result: Record<string, number> = {};

  for (const [agentId, rawCount] of Object.entries(value as Record<string, unknown>)) {
    if (remaining <= 0) break;
    if (!agentId.trim() || typeof rawCount !== "number" || !Number.isFinite(rawCount)) continue;
    const count = Math.max(0, Math.floor(rawCount));
    const accepted = Math.min(count, remaining);
    if (accepted > 0) result[agentId] = accepted;
    remaining -= accepted;
  }

  return result;
}

function normalizePreset(value: unknown): Preset | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<Preset>;
  if (
    typeof candidate.id !== "string" ||
    !candidate.id.trim() ||
    typeof candidate.name !== "string" ||
    typeof candidate.folderPath !== "string" ||
    !candidate.folderPath.trim() ||
    typeof candidate.createdAt !== "string"
  ) {
    return null;
  }

  const terminalCount = boundedTerminalCount(candidate.terminalCount);
  return {
    id: candidate.id,
    name: candidate.name.trim() || "Workspace",
    folderPath: candidate.folderPath,
    terminalCount,
    agentCounts: boundedAgentCounts(candidate.agentCounts, terminalCount),
    createdAt: candidate.createdAt,
  };
}

export const usePresetStore = create<PresetStore>()(
  persist(
    (set) => ({
      presets: [],

      addPreset: (preset) =>
        set((state) => {
          const normalized = normalizePreset(preset);
          return normalized
            ? { presets: [...state.presets, normalized] }
            : state;
        }),

      updatePreset: (id, updates) =>
        set((state) => ({
          presets: state.presets.map((preset) => {
            if (preset.id !== id) return preset;
            return normalizePreset({ ...preset, ...updates }) ?? preset;
          }),
        })),

      removePreset: (id) =>
        set((state) => ({
          presets: state.presets.filter((preset) => preset.id !== id),
        })),
    }),
    {
      name: "traflix-presets",
      partialize: (state) => ({
        presets: state.presets,
      }),
      merge: (persisted, current) => {
        const saved = persisted as { presets?: unknown } | undefined;
        const presets = Array.isArray(saved?.presets)
          ? saved.presets
              .map(normalizePreset)
              .filter((preset): preset is Preset => preset !== null)
          : current.presets;
        return { ...current, presets };
      },
    },
  ),
);
