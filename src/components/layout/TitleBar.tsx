import { useEffect } from "react";
import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { version as APP_VERSION } from "../../../package.json";

const IS_DEV = import.meta.env.DEV;

export function TitleBar() {
  useEffect(() => {
    if (IS_DEV) document.title = "Traflix Space [DEV]";
  }, []);

  const appWindow = () => {
    if (typeof window === "undefined") return null;
    try { return getCurrentWindow(); }
    catch { return null; }
  };

  return (
    <header className="relative flex h-10 shrink-0 select-none items-center border-b border-neutral-border bg-neutral-surface">
      <div data-tauri-drag-region className="flex h-full min-w-0 flex-1 items-center gap-2.5 px-3.5">
        <img src="/icon.png" alt="" className="h-[18px] w-[18px] shrink-0 rounded-[4px]" aria-hidden="true" />
        <span className="whitespace-nowrap font-display text-[11px] font-bold tracking-[0.055em] text-neutral-text">
          TRAFLIX SPACE
        </span>
        <span className="font-mono text-[9px] text-neutral-text-muted">v{APP_VERSION}</span>
        {IS_DEV && <span className="ml-1 rounded px-1.5 py-0.5 font-mono text-[8px] font-bold text-danger">DEV</span>}
      </div>

      <div className="flex h-full shrink-0">
        <WindowButton label="Riduci a icona" onClick={() => void appWindow()?.minimize()}><Minus size={13} /></WindowButton>
        <WindowButton label="Ingrandisci finestra" onClick={() => void appWindow()?.toggleMaximize()}><Square size={10} /></WindowButton>
        <WindowButton label="Chiudi applicazione" danger onClick={() => void appWindow()?.close()}><X size={13} /></WindowButton>
      </div>
    </header>
  );
}

function WindowButton({ label, danger = false, onClick, children }: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-full w-10 items-center justify-center transition-colors ${
        danger ? "text-neutral-text-muted hover:bg-danger/15 hover:text-danger" : "text-neutral-text-muted hover:bg-white/[0.06] hover:text-neutral-text"
      }`}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}
