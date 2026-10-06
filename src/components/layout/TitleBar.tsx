import { useEffect, useState } from "react";
import { Check, Download, Minus, RefreshCw, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { version as APP_VERSION } from "../../../package.json";
import { useUpdaterStore } from "../../stores/updaterStore";
import { useToastStore } from "../../stores/toastStore";

const IS_DEV = import.meta.env.DEV;

export function TitleBar() {
  const status = useUpdaterStore((s) => s.status);
  const latestVersion = useUpdaterStore((s) => s.latestVersion);
  const lastCheckedAt = useUpdaterStore((s) => s.lastCheckedAt);
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);
  const reopen = useUpdaterStore((s) => s.reopen);
  const addToast = useToastStore((s) => s.addToast);
  const [justCheckedOk, setJustCheckedOk] = useState(false);

  useEffect(() => {
    if (IS_DEV) document.title = "Traflix Space [DEV]";
  }, []);

  useEffect(() => {
    if (status !== "up-to-date") return;
    setJustCheckedOk(true);
    const timer = window.setTimeout(() => setJustCheckedOk(false), 4000);
    return () => window.clearTimeout(timer);
  }, [status, lastCheckedAt]);

  const checking = status === "checking" || status === "installing";
  const available = status === "available" || status === "installing";

  const handleCheck = async () => {
    if (checking) return;
    // Se un aggiornamento è già noto ma il banner è stato chiuso,
    // il pulsante lo riapre senza rifare il giro di rete.
    if (status === "available") {
      reopen();
      return;
    }
    const result = await checkForUpdates(true);
    if (result === "available") {
      addToast({
        type: "info",
        message: "Nuova versione disponibile: installala dal banner in alto.",
        duration: 5000,
      });
    } else if (result === "up-to-date") {
      addToast({
        type: "success",
        message: `Traflix Space è aggiornato (v${APP_VERSION}).`,
        duration: 4000,
      });
    } else if (result === "unavailable") {
      addToast({
        type: "info",
        message: "Il controllo aggiornamenti è disponibile solo nell'app desktop.",
        duration: 4000,
      });
    } else if (result === "error") {
      addToast({
        type: "error",
        message: "Controllo aggiornamenti non riuscito. Riprova più tardi.",
        duration: 4000,
      });
    }
  };

  const lastCheckLabel = lastCheckedAt
    ? `Ultimo controllo: ${new Date(lastCheckedAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}`
    : "Controlla aggiornamenti";

  const checkTitle = available && latestVersion
    ? `Nuova versione ${latestVersion} disponibile — apri il banner`
    : checking
      ? "Controllo aggiornamenti in corso…"
      : lastCheckLabel;

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

      <div className="flex h-full shrink-0 items-center gap-1 px-1.5">
        {available && latestVersion ? (
          <button
            type="button"
            onClick={() => void handleCheck()}
            title={checkTitle}
            aria-label={checkTitle}
            className="flex h-7 items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/15"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            <Download size={13} aria-hidden="true" />
            <span className="font-mono">v{latestVersion}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleCheck()}
            disabled={checking}
            title={checkTitle}
            aria-label={checkTitle}
            aria-busy={checking}
            className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
              justCheckedOk
                ? "text-signal"
                : "text-neutral-text-muted hover:bg-white/[0.06] hover:text-neutral-text"
            } disabled:cursor-default disabled:opacity-70`}
          >
            {justCheckedOk && !checking ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <RefreshCw
                size={13}
                aria-hidden="true"
                className={checking ? "animate-spin" : ""}
              />
            )}
          </button>
        )}
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
