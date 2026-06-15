import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function TitleBar() {
  const appWindow = getCurrentWindow();

  return (
    <div
      data-tauri-drag-region
      className="flex items-center justify-between h-10 px-4 bg-neutral-darkest border-b select-none"
      style={{ borderColor: "var(--neutral-border)" }}
    >
      <div className="flex items-center gap-2">
        <div className="w-3 h-3 rounded-full bg-primary" />
        <span className="font-display font-extrabold text-sm text-primary tracking-wider uppercase">
          Traflix Space
        </span>
      </div>

      <div className="flex gap-1">
        <button
          onClick={() => appWindow.minimize()}
          className="flex items-center justify-center w-8 h-8 rounded hover:bg-white/5 transition-colors"
        >
          <Minus size={14} className="text-neutral-text-muted" />
        </button>
        <button
          onClick={() => appWindow.toggleMaximize()}
          className="flex items-center justify-center w-8 h-8 rounded hover:bg-white/5 transition-colors"
        >
          <Square size={12} className="text-neutral-text-muted" />
        </button>
        <button
          onClick={() => appWindow.close()}
          className="flex items-center justify-center w-8 h-8 rounded hover:bg-red-500/20 transition-colors"
        >
          <X size={14} className="text-neutral-text-muted hover:text-red-400" />
        </button>
      </div>
    </div>
  );
}
