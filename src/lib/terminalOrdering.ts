export interface IdentifiableItem {
  id: string;
}

/** Locale-independent Unicode scalar order matching Rust UTF-8 `String::cmp`. */
function compareTerminalIds(left: string, right: string): number {
  if (left === right) return 0;
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] < rightPoints[index] ? -1 : 1;
    }
  }
  return leftPoints.length < rightPoints.length ? -1 : 1;
}

/** Persisted ids lead; runtime-only ids follow in deterministic id order. */
export function canonicalTerminalIds(
  persistedIds: string[],
  runtimeIds: string[],
): string[] {
  const runtime = new Set(runtimeIds);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of persistedIds) {
    if (runtime.has(id) && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  const extras = runtimeIds
    .filter((id) => !seen.has(id))
    .sort(compareTerminalIds);
  for (const id of extras) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
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
