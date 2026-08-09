import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, X } from "lucide-react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo } from "@tauri-apps/api/event";
import {
  AGENT_NOTIFICATION_OPEN_EVENT,
  AGENT_NOTIFICATION_SHOW_EVENT,
  type AgentNotificationPayload,
} from "../../lib/agentNotificationOverlay";

const DISPLAY_MS = 8000;

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
      // Bring the hidden main window back even if the event listener is still
      // starting up. The main webview will also focus itself after receiving
      // the navigation event.
      const mainWindow = await WebviewWindow.getByLabel("main");
      try {
        await mainWindow?.unminimize();
        await mainWindow?.show();
        await mainWindow?.setFocus();
      } catch (error) {
        // The event is still useful: the main webview performs the same
        // best-effort focus after it receives it.
        console.warn("Traflix main window focus failed before navigation:", error);
      }
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
        <div className="relative flex h-[126px] w-[480px] flex-col justify-center overflow-hidden rounded-[16px] border border-white/[0.12] bg-[#1a1b19]/[0.98] px-5 py-4 text-neutral-text shadow-[0_18px_60px_rgba(0,0,0,0.55)] ring-1 ring-primary/10">
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
                onClick={() => void openTerminal()}
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
            onClick={close}
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
