import { useEffect } from "react";
import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { version as APP_VERSION } from "../../../package.json";

const IS_DEV = import.meta.env.DEV;

export function TitleBar() {
  useEffect(() => {
    if (IS_DEV) {
      document.title = "Traflix Space [DEV]";
    }
  }, []);

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
      className="relative flex items-center h-12 bg-[#1a1b19] border-b select-none"
      style={{ borderColor: "var(--color-neutral-border)" }}
    >
      <div
        data-tauri-drag-region
        className="flex items-center gap-3.5 flex-1 min-w-0 h-full px-5"
      >
        <img src="/icon.png" alt="Traflix" className="w-5.5 h-5.5 rounded-md shrink-0 transition-transform duration-200 hover:scale-105" />
        <span className="font-display font-extrabold text-xs text-primary tracking-[0.12em] uppercase whitespace-nowrap">
          Traflix Space
        </span>
        <span className="text-[11px] font-sans font-semibold text-[#74716c]/80 tracking-wide select-none">
          v{APP_VERSION}
        </span>
      </div>

      {IS_DEV && (
        <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 pointer-events-none">
          <span className="font-display font-extrabold text-[0.75rem] tracking-[0.25em] text-red-500/80">
            DEV
          </span>
        </div>
      )}

      <div className="flex h-full shrink-0">
        <button
          onClick={() => getAppWindow()?.minimize()}
          className="flex items-center justify-center w-11 h-full hover:bg-white/[0.065] active:bg-white/[0.03] transition-all duration-150"
          title="Riduci a icona"
          aria-label="Riduci a icona"
        >
          <Minus size={14} className="text-neutral-text-muted hover:text-neutral-text transition-colors" />
        </button>
        <button
          onClick={() => getAppWindow()?.toggleMaximize()}
          className="flex items-center justify-center w-11 h-full hover:bg-white/[0.065] active:bg-white/[0.03] transition-all duration-150"
          title="Ingrandisci"
          aria-label="Ingrandisci finestra"
        >
          <Square size={11} className="text-neutral-text-muted hover:text-neutral-text transition-colors" />
        </button>
        <button
          onClick={() => getAppWindow()?.close()}
          className="flex items-center justify-center w-11 h-full hover:bg-red-500/15 active:bg-red-500/10 transition-all duration-150 group"
          title="Chiudi"
          aria-label="Chiudi applicazione"
        >
          <X size={14} className="text-neutral-text-muted group-hover:text-red-400 transition-colors" />
        </button>
      </div>
    </div>
  );
}
