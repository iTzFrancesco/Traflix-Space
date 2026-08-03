export interface IdentifiableItem {
  id: string;
}

/** Swap exactly two ordered items while preserving every other index. */
export function swapItemsById<T extends IdentifiableItem>(
  items: T[],
  draggedId: string,
  targetId: string,
): T[] {
  if (draggedId === targetId) return items;

  const draggedIndex = items.findIndex((item) => item.id === draggedId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (draggedIndex === -1 || targetIndex === -1) return items;

  const next = [...items];
  [next[draggedIndex], next[targetIndex]] = [
    next[targetIndex],
    next[draggedIndex],
  ];
  return next;
}
