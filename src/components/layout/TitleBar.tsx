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
      className="relative flex items-center h-12 bg-neutral-darkest border-b select-none"
      style={{ borderColor: "var(--color-neutral-border)" }}
    >
      <div
        data-tauri-drag-region
        className="flex items-center gap-3.5 flex-1 min-w-0 h-full px-4"
      >
        <img src="/icon.png" alt="Traflix" className="w-6 h-6 rounded-md shrink-0" />
        <span className="font-display font-extrabold text-sm text-primary tracking-wider uppercase whitespace-nowrap">
          Traflix Space
        </span>
        <span className="text-[11px] font-mono text-white/45">
          v{APP_VERSION}
        </span>
      </div>

      {IS_DEV && (
        <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2 pointer-events-none">
          <span className="font-display font-extrabold text-[1rem] tracking-[0.2em] text-red-500/90">
            DEV
          </span>
        </div>
      )}

      <div className="flex h-full shrink-0">
        <button
          onClick={() => getAppWindow()?.minimize()}
          className="flex items-center justify-center w-12 h-full hover:bg-white/[0.08] active:bg-white/[0.04] transition-colors"
          title="Riduci a icona"
          aria-label="Riduci a icona"
        >
          <Minus size={15} className="text-neutral-text-muted" />
        </button>
        <button
          onClick={() => getAppWindow()?.toggleMaximize()}
          className="flex items-center justify-center w-12 h-full hover:bg-white/[0.08] active:bg-white/[0.04] transition-colors"
          title="Ingrandisci"
          aria-label="Ingrandisci finestra"
        >
          <Square size={13} className="text-neutral-text-muted" />
        </button>
        <button
          onClick={() => getAppWindow()?.close()}
          className="flex items-center justify-center w-12 h-full hover:bg-red-500/20 active:bg-red-500/10 transition-colors"
          title="Chiudi"
          aria-label="Chiudi applicazione"
        >
          <X size={15} className="text-neutral-text-muted hover:text-red-400" />
        </button>
      </div>
    </div>
  );
}
