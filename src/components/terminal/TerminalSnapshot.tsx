import { memo, useRef, useEffect } from "react";
import type { FrameSnapshot } from "./types";

interface TerminalSnapshotProps {
  snapshot: FrameSnapshot | null;
  title: string;
}

const SNAPSHOT_CELL_W = 9;
const SNAPSHOT_CELL_H = 18;
const PADDING = 8;

export const TerminalSnapshot = memo(function TerminalSnapshot({
  snapshot, title,
}: TerminalSnapshotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !snapshot) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = Math.max(snapshot.cols * SNAPSHOT_CELL_W + PADDING * 2, 200);
    const h = Math.max(snapshot.rows * SNAPSHOT_CELL_H + PADDING * 2, 100);
    canvas.width = w;
    canvas.height = h;

    // Background
    ctx.fillStyle = "#0c0c0c";
    ctx.fillRect(0, 0, w, h);

    // Title bar
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, w, 24);
    ctx.fillStyle = "#888";
    ctx.font = "11px 'Segoe UI', sans-serif";
    ctx.fillText(title || "Terminal", 8, 16);

    // Cells
    const startRow = Math.max(0, snapshot.rows - Math.floor((h - 32) / SNAPSHOT_CELL_H));
    ctx.font = "13px 'Cascadia Mono', 'Consolas', monospace";
    for (let r = startRow; r < snapshot.rows; r++) {
      for (let c = 0; c < snapshot.cols; c++) {
        const cell = snapshot.cells?.[r]?.[c];
        if (!cell) continue;
        const x = PADDING + c * SNAPSHOT_CELL_W;
        const y = 32 + (r - startRow) * SNAPSHOT_CELL_H;

        ctx.fillStyle = `rgb(${cell.bg.r},${cell.bg.g},${cell.bg.b})`;
        ctx.fillRect(x, y - 2, SNAPSHOT_CELL_W, SNAPSHOT_CELL_H);

        if (cell.ch !== " ") {
          ctx.fillStyle = `rgb(${cell.fg.r},${cell.fg.g},${cell.fg.b})`;
          ctx.fillText(cell.ch, x, y + 11);
        }
      }
    }
  }, [snapshot]);

  if (!snapshot) {
    return (
      <div style={{
        width: "100%", height: "100%",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "#555", fontSize: 13, fontFamily: "'Segoe UI', sans-serif",
        background: "#0c0c0c",
      }}>
        <span>{title || "Terminal"}</span>
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "contain",
        imageRendering: "pixelated",
      }}
    />
  );
});
