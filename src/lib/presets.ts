export function computeLayout(count: number): { rows: number; cols: number } {
  if (count === 1) return { rows: 1, cols: 1 };
  if (count <= 2) return { rows: 1, cols: 2 };
  if (count <= 4) return { rows: 2, cols: 2 };
  if (count <= 6) return { rows: 2, cols: 3 };
  if (count <= 9) return { rows: 3, cols: 3 };
  if (count <= 12) return { rows: 3, cols: 4 };
  return { rows: 4, cols: 4 };
}

export const QUICK_COUNTS = [4, 6, 8, 12, 16];
