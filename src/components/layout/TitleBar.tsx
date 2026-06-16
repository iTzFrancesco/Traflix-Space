import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function TitleBar() {
  function getAppWindow() {
    if (typeof window === "undefined") return null;
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  }

  return (
    <div
      data-tauri-drag-region
      className="flex items-center justify-between h-10 px-4 bg-neutral-darkest border-b select-none"
      style={{ borderColor: "var(--neutral-border)" }}
    >
      <div className="flex items-center gap-2">
        <img src="/icon.png" alt="Traflix" className="w-5 h-5 rounded" />
        <span className="font-display font-extrabold text-sm text-primary tracking-wider uppercase">
          Traflix Space
        </span>
      </div>

      <div className="flex gap-1">
        <button
          onClick={() => getAppWindow()?.minimize()}
          className="flex items-center justify-center w-8 h-8 rounded hover:bg-white/5 transition-colors"
        >
          <Minus size={14} className="text-neutral-text-muted" />
        </button>
        <button
          onClick={() => getAppWindow()?.toggleMaximize()}
          className="flex items-center justify-center w-8 h-8 rounded hover:bg-white/5 transition-colors"
        >
          <Square size={12} className="text-neutral-text-muted" />
        </button>
        <button
          onClick={() => getAppWindow()?.close()}
          className="flex items-center justify-center w-8 h-8 rounded hover:bg-red-500/20 transition-colors"
        >
          <X size={14} className="text-neutral-text-muted hover:text-red-400" />
        </button>
      </div>
    </div>
  );
}
