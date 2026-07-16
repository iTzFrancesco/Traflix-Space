/**
 * Colori associati a ogni workspace, determinati dall'indice nella lista.
 * Usati per il pallino nella sidebar e per il pallino nella title bar dei terminali.
 */

export const WORKSPACE_COLORS = [
  "#e85d04",
  "#06b6d4",
  "#8b5cf6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#3b82f6",
] as const;

export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

/**
 * Restituisce il colore del workspace in base all'indice nella lista.
 * I colori ciclano: con 8 colori, l'indice 8 → colore 0, 9 → colore 1, ecc.
 */
export function getWorkspaceColor(index: number): string {
  return WORKSPACE_COLORS[index % WORKSPACE_COLORS.length];
}
