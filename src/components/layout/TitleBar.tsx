import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { version as APP_VERSION } from "../../../package.json";

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
    <div className="flex items-center h-10 bg-neutral-darkest border-b select-none"
      style={{ borderColor: "var(--neutral-border)" }}
    >
      <div
        data-tauri-drag-region
        className="flex items-center gap-3 flex-1 min-w-0 h-full px-4"
      >
        <img src="/icon.png" alt="Traflix" className="w-5 h-5 rounded shrink-0" />
        <span className="font-display font-extrabold text-sm text-primary tracking-wider uppercase whitespace-nowrap">
          Traflix Space
        </span>
        <span className="text-[10px] font-mono text-white/50 -ml-1">
          v{APP_VERSION}
        </span>
      </div>

      <div className="flex h-full">
        <button
          onClick={() => getAppWindow()?.minimize()}
          className="flex items-center justify-center w-[46px] h-full hover:bg-white/[0.08] active:bg-white/[0.04] transition-colors"
        >
          <Minus size={14} className="text-neutral-text-muted" />
        </button>
        <button
          onClick={() => getAppWindow()?.toggleMaximize()}
          className="flex items-center justify-center w-[46px] h-full hover:bg-white/[0.08] active:bg-white/[0.04] transition-colors"
        >
          <Square size={12} className="text-neutral-text-muted" />
        </button>
        <button
          onClick={() => getAppWindow()?.close()}
          className="flex items-center justify-center w-[46px] h-full hover:bg-red-500/20 active:bg-red-500/10 transition-colors"
        >
          <X size={14} className="text-neutral-text-muted hover:text-red-400" />
        </button>
      </div>
    </div>
  );
}
