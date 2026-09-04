import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, X } from "lucide-react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { WebviewWindow as WebviewWindowType } from "@tauri-apps/api/webviewWindow";
import { emitTo } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  AGENT_NOTIFICATION_OPEN_EVENT,
  AGENT_NOTIFICATION_SHOW_EVENT,
  type AgentNotificationPayload,
} from "../../lib/agentNotificationOverlay";

const DISPLAY_MS = 8000;

/**
 * Porta la main in primo piano con best-effort indipendente per passo.
 * Ordine obbligato su Windows: show (tray/hidden) -> unminimize
 * (minimizzata) -> setFocus. Ogni passo e' isolato: se uno e' negato
 * (ACL) o fallisce, gli altri vengono comunque tentati. Il comando Rust
 * `show_main_window` e' il fallback che non dipende dalle capability.
 */
async function focusMainWindowFromOverlay(
  mainWindow: WebviewWindowType | null,
): Promise<boolean> {
  let succeeded = false;
  if (mainWindow) {
    try {
      await mainWindow.show();
      succeeded = true;
    } catch (error) {
      console.warn("Traflix main window show failed:", error);
    }
    try {
      await mainWindow.unminimize();
      succeeded = true;
    } catch (error) {
      console.warn("Traflix main window unminimize failed:", error);
    }
    try {
      await mainWindow.setFocus();
      succeeded = true;
    } catch (error) {
      console.warn("Traflix main window focus failed:", error);
    }
  }
  try {
    await invoke("show_main_window");
    succeeded = true;
  } catch (error) {
    console.warn("Traflix show_main_window command failed:", error);
  }
  return succeeded;
}

export function AgentNotificationOverlay() {
  const [notification, setNotification] = useState<AgentNotificationPayload | null>(null);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    document.body.style.backgroundColor = "transparent";
    const overlay = WebviewWindow.getCurrent();
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void overlay.listen<AgentNotificationPayload>(AGENT_NOTIFICATION_SHOW_EVENT, (event) => {
      setNotification(event.payload);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => {
        setNotification(null);
        void overlay.hide().catch((error) => {
          console.warn("Traflix agent overlay could not hide:", error);
        });
      }, DISPLAY_MS);
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
      } else {
        unlisten = cleanup;
      }
    }).catch((error) => {
      console.error("Traflix agent overlay listener failed:", error);
    });

    return () => {
      disposed = true;
      document.body.style.backgroundColor = "";
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      unlisten?.();
    };
  }, []);

  const close = () => {
    setNotification(null);
    void WebviewWindow.getCurrent().hide().catch((error) => {
      console.warn("Traflix agent overlay could not close:", error);
    });
  };

  const openTerminal = async () => {
    const currentNotification = notification;
    if (!currentNotification?.canOpenTerminal) return;

    try {
      // 1) Riporta subito la main in primo piano (anche se e' nascosta in
      // tray o minimizzata) prima di navigare: l'evento sotto fa la stessa
      // cosa dal lato main come seconda garanzia.
      const mainWindow = await WebviewWindow.getByLabel("main").catch((error) => {
        console.warn("Traflix main window lookup failed:", error);
        return null;
      });
      await focusMainWindowFromOverlay(mainWindow);
      // 2) Naviga workspace/terminale. Emesso comunque: la main esegue lo
      // stesso focus best-effort dopo averlo ricevuto.
      await emitTo("main", AGENT_NOTIFICATION_OPEN_EVENT, {
        workspaceId: currentNotification.workspaceId,
        terminalId: currentNotification.terminalId,
        generation: currentNotification.event.generation,
        processId: currentNotification.event.processId,
      });
      console.info("[agent-notification] open event dispatched", {
        terminalId: currentNotification.terminalId,
        workspaceId: currentNotification.workspaceId ?? null,
      });
      close();
    } catch (error) {
      // Keep the notification visible so a transient IPC/window failure is
      // visible and the user can retry instead of losing the only action.
      console.warn("Traflix terminal notification could not open main window:", error);
    }
  };

  return (
    <div className="flex h-screen w-screen items-end justify-end bg-transparent p-0">
      {notification && (
        <div
          role={notification.canOpenTerminal ? "button" : undefined}
          tabIndex={notification.canOpenTerminal ? 0 : undefined}
          title={notification.canOpenTerminal ? "Clicca per aprire Space" : undefined}
          onClick={() => {
            if (notification.canOpenTerminal) void openTerminal();
          }}
          onKeyDown={(event) => {
            if (
              notification.canOpenTerminal &&
              (event.key === "Enter" || event.key === " ")
            ) {
              event.preventDefault();
              void openTerminal();
            }
          }}
          className={`relative flex h-[126px] w-[480px] flex-col justify-center overflow-hidden rounded-[16px] border border-white/[0.12] bg-[#1a1b19]/[0.98] px-5 py-4 text-neutral-text shadow-[0_18px_60px_rgba(0,0,0,0.55)] ring-1 ring-primary/10 ${notification.canOpenTerminal ? "cursor-pointer" : ""}`}
        >
          <div className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-primary" />
          <div className="flex min-w-0 items-center gap-3 pr-8">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-signal/10 text-signal ring-1 ring-signal/20">
              <CheckCircle2 size={22} />
            </div>
            <div className="min-w-0 flex-1">
              <div
                className="mb-1 truncate text-[10px] font-bold uppercase tracking-[0.16em] text-primary"
                title={notification.terminalTitle}
              >
                {notification.terminalTitle}
              </div>
              <p className="truncate text-[14px] font-semibold text-neutral-text">
                {notification.message}
              </p>
              <p className="mt-1 truncate text-[12px] text-neutral-text-muted" title={notification.projectName}>
                {notification.provider} · Progetto: <span className="font-semibold text-neutral-text">{notification.projectName}</span>
              </p>
            </div>
            {notification.canOpenTerminal && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  void openTerminal();
                }}
                title="Apri o continua nel terminale"
                className="flex min-w-[116px] shrink-0 items-center justify-center gap-2 rounded-lg border border-primary/35 px-5 py-3.5 text-base font-bold text-primary transition-colors hover:bg-primary/10"
              >
                <ExternalLink size={17} />
                Continua
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              close();
            }}
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-lg text-neutral-text-muted transition-colors hover:bg-white/[0.06] hover:text-neutral-text"
            aria-label="Chiudi notifica"
          >
            <X size={16} />
          </button>
          <div className="absolute bottom-0 left-0 h-[2px] w-full origin-left animate-[overlay-progress_8s_linear] bg-primary/70" />
        </div>
      )}
    </div>
  );
}
