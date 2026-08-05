import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Webview } from "@tauri-apps/api/webview";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { ArrowLeft, ArrowRight, Globe2, LoaderCircle, RotateCw, Undo2 } from "lucide-react";
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
    const viewport = viewportRef.current;
    const webview = webviewRef.current;
    if (!viewport || !webview) return;

    const rect = viewport.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;

    try {
      if (!currentUrlRef.current) {
        if (nativeVisibleRef.current) {
          await webview.hide();
          nativeVisibleRef.current = false;
        }
        return;
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
      if (!previous || previous.width !== bounds.width || previous.height !== bounds.height) {
        await webview.setSize(new LogicalSize(bounds.width, bounds.height));
      }
      lastBoundsRef.current = bounds;
      if (!nativeVisibleRef.current) {
        await webview.show();
        nativeVisibleRef.current = true;
      }
    } catch (reason) {
      if (aliveRef.current && currentUrlRef.current) {
        setError(reason instanceof Error ? reason.message : "Pagina non disponibile");
      }
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
        unlisten = await listen<BrowserUrlChanged>("browser-url-changed", (event) => {
          if (!aliveRef.current) return;
          const nextUrl = event.payload.url === "about:blank" ? "" : event.payload.url;
          updateCurrentUrl(nextUrl);
          setLoading(event.payload.loading);
          requestBoundsSync();
        });

        await invokeWithTimeout(() => invoke("browser_create"), 10000);
        if (!aliveRef.current) {
          await invokeWithTimeout(() => invoke("browser_close"), 3000).catch(() => undefined);
          return;
        }

        const webview = await Webview.getByLabel("browser");
        if (!webview) throw new Error("WebView2 Browser non disponibile");
        webviewRef.current = webview;
        setReady(true);
        requestBoundsSync();
      } catch (reason) {
        if (aliveRef.current) {
          setLoading(false);
          setError(reason instanceof Error ? reason.message : "Impossibile inizializzare il Browser");
        }
      }
    };

    resizeObserver = new ResizeObserver(() => {
      requestBoundsSync();
    });
    if (viewportRef.current) resizeObserver.observe(viewportRef.current);
    window.addEventListener("resize", requestBoundsSync);
    void initialize();

    return () => {
      aliveRef.current = false;
      resizeObserver?.disconnect();
      window.removeEventListener("resize", requestBoundsSync);
      if (layoutFrameRef.current !== null) window.cancelAnimationFrame(layoutFrameRef.current);
      layoutFrameRef.current = null;
      unlisten?.();
      webviewRef.current = null;
      nativeVisibleRef.current = false;
      lastBoundsRef.current = null;
      setReady(false);
      void invokeWithTimeout(() => invoke("browser_close"), 3000).catch(() => undefined);
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
      setError(reason instanceof Error ? reason.message : "Operazione Browser non riuscita");
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
      setError(reason instanceof Error ? reason.message : "Reset Browser non riuscito");
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
      await invokeWithTimeout(() => invoke("browser_navigate", { url: normalized }), 10000);
      setAddress(normalized);
    } catch (reason) {
      setLoading(false);
      setError(reason instanceof Error ? reason.message : "Navigazione non riuscita");
    }
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#0b0d0b]" aria-label="Browser integrato" aria-busy={loading}>
      <div className="shrink-0 border-b border-white/[0.08] bg-[#181b18] px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button type="button" disabled={!ready} onClick={() => void runCommand("browser_back")} className="ui-icon-button h-7 w-7 shrink-0 disabled:pointer-events-none disabled:opacity-35" title="Indietro" aria-label="Indietro">
            <ArrowLeft size={14} />
          </button>
          <button type="button" disabled={!ready} onClick={() => void runCommand("browser_forward")} className="ui-icon-button h-7 w-7 shrink-0 disabled:pointer-events-none disabled:opacity-35" title="Avanti" aria-label="Avanti">
            <ArrowRight size={14} />
          </button>
          <form className="min-w-0 flex-1" onSubmit={submitAddress}>
            <div className="flex h-8 items-center rounded-lg border border-white/[0.13] bg-[#0e100e] px-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] transition-colors focus-within:border-primary/60 focus-within:bg-[#111410] focus-within:ring-1 focus-within:ring-primary/20">
              <input
                ref={addressInputRef}
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="localhost:3000 o dominio.com"
                aria-label="URL del browser"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[0.72rem] text-neutral-text outline-none placeholder:text-neutral-text-muted"
              />
              <button type="submit" disabled={!ready} className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-text-muted transition-colors hover:bg-white/[0.07] hover:text-primary disabled:pointer-events-none disabled:opacity-35" title="Vai all'URL" aria-label="Vai all'URL">
                {loading ? <LoaderCircle size={12} className="animate-spin" /> : <Globe2 size={12} />}
              </button>
            </div>
          </form>
          <button type="button" disabled={!ready} onClick={() => void runCommand("browser_reload")} className="ui-icon-button h-7 w-7 shrink-0 disabled:pointer-events-none disabled:opacity-35" title="Aggiorna pagina" aria-label="Aggiorna pagina">
            <RotateCw size={13} className={loading ? "animate-spin" : ""} />
          </button>
          <button type="button" disabled={!ready} onClick={() => void resetBrowser()} className="ui-icon-button h-7 w-7 shrink-0 disabled:pointer-events-none disabled:opacity-35" title="Reset Browser" aria-label="Reset Browser">
            <Undo2 size={13} />
          </button>
        </div>
        {error && (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-danger/20 bg-danger/[0.06] px-2 py-1.5 text-[0.62rem] text-danger" role="alert" title={error}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
            <span className="min-w-0 flex-1 truncate">{error}</span>
          </div>
        )}
      </div>

      <div ref={viewportRef} className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-[#090b09]" aria-label="Viewport Browser">
        {!currentUrl && (
          <div className="absolute inset-0 overflow-hidden bg-[radial-gradient(circle_at_50%_32%,rgba(232,93,4,0.1),transparent_40%),linear-gradient(135deg,#090b09_0%,#0b0e0b_100%)] px-4 py-6">
            <div className="pointer-events-none absolute -right-20 top-[-80px] h-48 w-48 rounded-full border border-primary/[0.09]" />
            <div className="pointer-events-none absolute -right-10 top-[-45px] h-28 w-28 rounded-full border border-primary/[0.08]" />
            <div className="relative flex h-full items-center justify-center">
              <div className="w-full max-w-[330px] rounded-2xl border border-white/[0.11] bg-[#111511]/90 p-5 shadow-[0_24px_70px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.035)] backdrop-blur-sm">
                <div className="flex flex-col items-center text-center">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-black text-neutral-bg shadow-[0_8px_20px_rgba(232,93,4,0.22)]">T</div>
                  <p className="mt-3 text-[0.68rem] font-extrabold tracking-[0.14em] text-neutral-text">TRAFLIX</p>
                  <h2 className="mt-5 font-display text-[1.55rem] font-extrabold leading-[1.02] tracking-[-0.045em] text-neutral-text">
                    Apri una pagina.
                  </h2>
                  <p className="mt-2 text-[0.7rem] text-neutral-text-muted">Inserisci un URL.</p>
                  <button
                    type="button"
                    onClick={() => {
                      addressInputRef.current?.focus();
                      addressInputRef.current?.select();
                    }}
                    className="mt-5 rounded-lg bg-primary px-3.5 py-2 text-[0.65rem] font-bold text-neutral-bg shadow-[0_8px_20px_rgba(232,93,4,0.18)] transition-all hover:-translate-y-0.5 hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  >
                    Apri URL
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
