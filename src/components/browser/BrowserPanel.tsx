import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Webview } from "@tauri-apps/api/webview";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import {
  ArrowLeft,
  ArrowRight,
  Globe2,
  LoaderCircle,
  RotateCw,
  Undo2,
} from "lucide-react";
import { invokeWithTimeout } from "../../lib/timeout";

interface BrowserUrlChanged {
  url: string;
  loading: boolean;
}

interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function normalizeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const isLocalAddress = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed);
  const hasHttpScheme = /^https?:\/\//i.test(trimmed);
  const hasNetworkScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  const candidate = isLocalAddress
    ? `http://${trimmed}`
    : hasHttpScheme || hasNetworkScheme
      ? trimmed
      : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function BrowserPanel() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const webviewRef = useRef<Webview | null>(null);
  const aliveRef = useRef(true);
  const currentUrlRef = useRef("");
  const nativeVisibleRef = useRef(false);
  const lastBoundsRef = useRef<BrowserBounds | null>(null);
  const boundsSyncBusyRef = useRef(false);
  const boundsSyncPendingRef = useRef(false);
  const layoutFrameRef = useRef<number | null>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateCurrentUrl = useCallback((nextUrl: string) => {
    currentUrlRef.current = nextUrl;
    setCurrentUrl(nextUrl);
    setAddress(nextUrl);
  }, []);

  const syncBounds = useCallback(async () => {
    if (boundsSyncBusyRef.current) {
      // Native WebView calls are asynchronous. Keep only the newest layout
      // request so a slow resize cannot reorder stale bounds updates.
      boundsSyncPendingRef.current = true;
      return;
    }
    boundsSyncBusyRef.current = true;
    try {
      do {
        boundsSyncPendingRef.current = false;
        const viewport = viewportRef.current;
        const webview = webviewRef.current;
        if (!viewport || !webview || !aliveRef.current) return;

        const rect = viewport.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;

        try {
          if (!currentUrlRef.current) {
            if (nativeVisibleRef.current) {
              await webview.hide();
              nativeVisibleRef.current = false;
            }
            // A hidden browser must not retain a stale comparison target after
            // the panel changes size while it has no document.
            lastBoundsRef.current = null;
            continue;
          }
          const bounds: BrowserBounds = {
            x: Math.max(0, Math.round(rect.left)),
            y: Math.max(0, Math.round(rect.top)),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
          };
          const previous = lastBoundsRef.current;
          if (!previous || previous.x !== bounds.x || previous.y !== bounds.y) {
            await webview.setPosition(new LogicalPosition(bounds.x, bounds.y));
          }
          if (
            !previous ||
            previous.width !== bounds.width ||
            previous.height !== bounds.height
          ) {
            await webview.setSize(new LogicalSize(bounds.width, bounds.height));
          }
          lastBoundsRef.current = bounds;
          if (!nativeVisibleRef.current && currentUrlRef.current) {
            await webview.show();
            nativeVisibleRef.current = true;
          }
        } catch (reason) {
          if (aliveRef.current && currentUrlRef.current) {
            setError(reason instanceof Error ? reason.message : "Pagina non disponibile");
          }
        }
      } while (boundsSyncPendingRef.current && aliveRef.current);
    } finally {
      boundsSyncBusyRef.current = false;
    }
  }, []);

  const requestBoundsSync = useCallback(() => {
    if (layoutFrameRef.current !== null) return;
    layoutFrameRef.current = window.requestAnimationFrame(() => {
      layoutFrameRef.current = null;
      void syncBounds();
    });
  }, [syncBounds]);

  useEffect(() => {
    aliveRef.current = true;
    let unlisten: (() => void) | undefined;
    let resizeObserver: ResizeObserver | undefined;

    const initialize = async () => {
      try {
        unlisten = await listen<BrowserUrlChanged>(
          "browser-url-changed",
          (event) => {
            if (!aliveRef.current) return;
            const nextUrl =
              event.payload.url === "about:blank" ? "" : event.payload.url;
            updateCurrentUrl(nextUrl);
            setLoading(event.payload.loading);
            requestBoundsSync();
          },
        );

        await invokeWithTimeout(() => invoke("browser_create"), 10000);
        if (!aliveRef.current) {
          await invokeWithTimeout(() => invoke("browser_close"), 3000).catch(
            () => undefined,
          );
          return;
        }

        const webview = await Webview.getByLabel("browser");
        if (!webview) throw new Error("Browser WebView2 non disponibile");
        webviewRef.current = webview;
        setReady(true);
        requestBoundsSync();
      } catch (reason) {
        if (aliveRef.current) {
          setLoading(false);
          setError(
            reason instanceof Error
              ? reason.message
              : "Impossibile inizializzare il browser",
          );
        }
      }
    };

    resizeObserver = new ResizeObserver(requestBoundsSync);
    if (viewportRef.current) resizeObserver.observe(viewportRef.current);
    window.addEventListener("resize", requestBoundsSync);
    void initialize();

    return () => {
      aliveRef.current = false;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", requestBoundsSync);
      if (layoutFrameRef.current !== null) {
        window.cancelAnimationFrame(layoutFrameRef.current);
      }
      layoutFrameRef.current = null;
      boundsSyncPendingRef.current = false;
      unlisten?.();
      webviewRef.current = null;
      nativeVisibleRef.current = false;
      lastBoundsRef.current = null;
      setReady(false);
      void invokeWithTimeout(() => invoke("browser_close"), 3000).catch(
        () => undefined,
      );
    };
  }, [requestBoundsSync, updateCurrentUrl]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
        event.preventDefault();
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const runCommand = async (command: string) => {
    if (!ready) return;
    setError(null);
    if (command === "browser_reload") setLoading(true);
    try {
      await invokeWithTimeout(() => invoke(command), 10000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Azione browser non riuscita");
    }
  };

  const resetBrowser = async () => {
    if (!ready) return;
    setError(null);
    setLoading(true);
    try {
      await invokeWithTimeout(() => invoke("browser_reset"), 10000);
    } catch (reason) {
      setLoading(false);
      setError(reason instanceof Error ? reason.message : "Ripristino browser non riuscito");
    }
  };

  const submitAddress = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = normalizeUrl(address);
    if (!normalized) {
      setError("Inserisci un URL http:// o https:// valido");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await invokeWithTimeout(
        () => invoke("browser_navigate", { url: normalized }),
        10000,
      );
      setAddress(normalized);
    } catch (reason) {
      setLoading(false);
      setError(reason instanceof Error ? reason.message : "Navigazione non riuscita");
    }
  };

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-darkest"
      aria-label="Browser integrato"
      aria-busy={loading}
    >
      <div className="shrink-0 border-b border-neutral-border bg-neutral-surface px-2.5 py-2">
        <div className="flex items-center gap-1">
          <BrowserButton
            label="Indietro"
            disabled={!ready}
            onClick={() => void runCommand("browser_back")}
          >
            <ArrowLeft size={14} />
          </BrowserButton>
          <BrowserButton
            label="Avanti"
            disabled={!ready}
            onClick={() => void runCommand("browser_forward")}
          >
            <ArrowRight size={14} />
          </BrowserButton>

          <form className="min-w-0 flex-1" onSubmit={submitAddress}>
            <div className="flex h-8 items-center border border-neutral-border bg-neutral-darkest px-2.5 focus-within:border-primary/60">
              <input
                ref={addressInputRef}
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="localhost:3000 oppure dominio.com"
                aria-label="URL browser"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-neutral-text outline-none placeholder:text-neutral-text-muted"
              />
              <button
                type="submit"
                disabled={!ready}
                className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center text-neutral-text-muted hover:text-primary disabled:pointer-events-none disabled:opacity-35"
                title="Apri URL"
                aria-label="Apri URL"
              >
                {loading ? (
                  <LoaderCircle size={12} className="status-icon--spin" />
                ) : (
                  <Globe2 size={12} />
                )}
              </button>
            </div>
          </form>

          <BrowserButton
            label="Ricarica"
            disabled={!ready}
            onClick={() => void runCommand("browser_reload")}
          >
            <RotateCw size={13} className={loading ? "status-icon--spin" : ""} />
          </BrowserButton>
          <BrowserButton
            label="Ripristina browser"
            disabled={!ready}
            onClick={() => void resetBrowser()}
          >
            <Undo2 size={13} />
          </BrowserButton>
        </div>

        {error && (
          <div
            className="mt-2 flex items-center gap-2 border-l-2 border-danger px-2 py-1 text-[10px] text-danger"
            role="alert"
            title={error}
          >
            <span className="min-w-0 flex-1 truncate">{error}</span>
          </div>
        )}
      </div>

      <div
        ref={viewportRef}
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-neutral-darkest"
        aria-label="Area browser"
      >
        {!currentUrl && (
          <div className="absolute inset-0 flex items-center justify-center px-6">
            <div className="max-w-[280px] text-center">
              <Globe2
                size={24}
                strokeWidth={1.4}
                className="mx-auto text-neutral-text-muted"
              />
              <h2 className="mt-4 text-sm font-semibold text-neutral-text">
                Apri una pagina
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-neutral-text-muted">
                Inserisci un URL locale o remoto nella barra degli indirizzi.
              </p>
              <button
                type="button"
                onClick={() => {
                  addressInputRef.current?.focus();
                  addressInputRef.current?.select();
                }}
                className="secondary-button mt-4"
              >
                Vai alla barra indirizzi
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function BrowserButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="ui-icon-button h-7 w-7 shrink-0 disabled:pointer-events-none disabled:opacity-35"
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}
