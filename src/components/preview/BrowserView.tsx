import { useState, useRef, useCallback, useEffect } from "react";
import { Globe, RotateCw, ExternalLink } from "lucide-react";
import { registerRightPanelView } from "../layout/RightPanel";

export function registerPreviewTabs() {
  registerRightPanelView("browser", {
    label: "Browser",
    icon: Globe,
    component: BrowserView,
  });
}

const SUGGESTIONS = [
  { label: "localhost:1420", url: "http://localhost:1420" },
  { label: "localhost:3000", url: "http://localhost:3000" },
  { label: "localhost:5173", url: "http://localhost:5173" },
  { label: "st.traflix.dev", url: "https://st.traflix.dev" },
];

function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "::1" ||
      u.hostname.endsWith(".local") ||
      u.hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/* ─── Apre URL nel browser di sistema via Tauri shell ─── */
async function openSystem(url: string) {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch {
    // Fallback window.open
    window.open(url, "_blank");
  }
}

/* ─── Crea una WebView2 child embedded via Tauri API ─── */
async function createWebview(
  targetUrl: string,
  container: HTMLElement,
): Promise<{ close: () => Promise<void>; setPosition: (x: number, y: number, w: number, h: number) => Promise<void> } | null> {
  try {
    const { Webview } = await import("@tauri-apps/api/webview");
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/dpi");

    const win = getCurrentWindow();
    const rect = container.getBoundingClientRect();

    const wv = new Webview(win, "bw-" + Date.now(), {
      url: targetUrl,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width) || 600,
      height: Math.round(rect.height) || 400,
      incognito: true,
    });

    // Aspetta che sia pronta
    await new Promise<void>((resolve, reject) => {
      let done = false;
      wv.once("tauri://created", () => { if (!done) { done = true; resolve(); } });
      wv.once("tauri://error", (e: any) => { if (!done) { done = true; reject(e); } });
      setTimeout(() => { if (!done) { done = true; reject(new Error("timeout")); } }, 8000);
    });

    // Forza visibilità
    await wv.show().catch(() => {});
    await wv.setFocus().catch(() => {});

    return {
      close: () => wv.close().catch(() => {}),
      setPosition: async (x, y, w, h) => {
        await Promise.all([
          wv.setPosition(new LogicalPosition(x, y)).catch(() => {}),
          wv.setSize(new LogicalSize(w, h)).catch(() => {}),
        ]);
      },
    };
  } catch (err) {
    console.error("[Browser] createWebview fallito:", err);
    return null;
  }
}

function BrowserView() {
  const [url, setUrl] = useState("");
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const webviewRef = useRef<{ close: () => Promise<void>; setPosition: (x: number, y: number, w: number, h: number) => Promise<void> } | null>(null);

  /* ─── Naviga ─── */
  const navigate = useCallback(async (raw: string) => {
    let target = raw.trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target)) target = "http://" + target;

    setUrl(target);
    setCurrentUrl(target);
    inputRef.current?.blur();

    // Chiudi webview precedente
    if (webviewRef.current) {
      await webviewRef.current.close();
      webviewRef.current = null;
    }

    // 1. TENTATIVO: WebView2 embedded (funziona con TUTTI gli URL)
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => setTimeout(r, 150));
    const el = containerRef.current;
    if (el) {
      const wv = await createWebview(target, el);
      if (wv) {
        webviewRef.current = wv;
        return;
      }
    }

    // 2. FALLBACK: iframe (SOLO localhost)
    if (isLocalUrl(target)) {
      if (iframeRef.current) {
        iframeRef.current.src = target;
      }
      return;
    }

    // 3. ULTIMA RISORSA: browser esterno
    await openSystem(target);
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(url);
  };

  /* ─── ResizeObserver per WebView2 ─── */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let rafId: number | null = null;

    const update = () => {
      const wv = webviewRef.current;
      if (!wv) return;
      const rect = el.getBoundingClientRect();
      wv.setPosition(
        Math.round(rect.x), Math.round(rect.y),
        Math.round(rect.width), Math.round(rect.height),
      );
    };

    const ro = new ResizeObserver(() => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(update);
    });
    ro.observe(el);
    ro.observe(document.body);

    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  /* ─── Pulisci al dismount ─── */
  useEffect(() => {
    return () => {
      if (webviewRef.current) {
        webviewRef.current.close();
        webviewRef.current = null;
      }
    };
  }, []);

  /* ─── Raggiorna ─── */
  const handleRefresh = useCallback(() => {
    if (currentUrl) navigate(currentUrl);
  }, [currentUrl, navigate]);

  /* ─── Render ─── */
  const showIframe = !!webviewRef.current === false && !!currentUrl && isLocalUrl(currentUrl);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      {currentUrl && (
        <div className="flex items-center gap-2 px-3 py-2 shrink-0"
          style={{ borderBottom: "1px solid var(--color-neutral-border)", backgroundColor: "var(--color-neutral-surface)" }}>
          <form onSubmit={handleSubmit} className="flex-1 flex items-center gap-2 px-3 py-1.5 rounded-lg"
            style={{ backgroundColor: "rgba(255,255,255,0.04)", border: "1px solid var(--color-neutral-border)" }}>
            <Globe size={13} style={{ color: "var(--color-neutral-text-muted)" }} />
            <input ref={inputRef} type="text" value={url} onChange={(e) => setUrl(e.target.value)}
              className="flex-1 bg-transparent text-[0.8rem] outline-none min-w-0"
              style={{ color: "var(--color-neutral-text-dim)", fontFamily: "var(--font-mono)" }}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(e); }}
              placeholder="URL…" />
          </form>
          <button onClick={handleRefresh} className="p-1.5 rounded-lg" title="Raggiorna"
            style={{ color: "var(--color-neutral-text-muted)" }}>
            <RotateCw size={14} />
          </button>
        </div>
      )}

      {/* Container — ospita la WebView2 HWND overlay o l'iframe */}
      <div ref={containerRef} className="flex-1 relative min-h-0" style={{ isolation: "isolate" }}>
        {showIframe && (
          <iframe ref={iframeRef} src={currentUrl}
            className="w-full h-full"
            style={{ border: "none", backgroundColor: "white" }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            title="Browser" />
        )}

        {currentUrl && !isLocalUrl(currentUrl) && !webviewRef.current && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 gap-3">
            <ExternalLink size={28} style={{ color: "var(--color-neutral-text-muted)" }} />
            <p className="text-[0.8rem] text-center max-w-[280px]"
              style={{ color: "var(--color-neutral-text-muted)", opacity: 0.7 }}>
              Apertura nel browser di sistema...
            </p>
          </div>
        )}

        {!currentUrl && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 gap-4">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center"
              style={{ background: "rgba(232,93,4,0.08)", border: "1px solid rgba(232,93,4,0.12)" }}>
              <Globe size={22} style={{ color: "var(--color-primary)" }} />
            </div>
            <h3 className="font-display font-bold text-[0.95rem]" style={{ color: "var(--color-neutral-text)" }}>Browser</h3>
            <form onSubmit={handleSubmit} className="w-full max-w-[320px]">
              <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl"
                style={{ backgroundColor: "rgba(255,255,255,0.04)", border: "1px solid var(--color-neutral-border)" }}>
                <input type="text" value={url} onChange={(e) => setUrl(e.target.value)}
                  placeholder="URL…"
                  className="flex-1 bg-transparent text-[0.8rem] outline-none min-w-0"
                  style={{ color: "var(--color-neutral-text-dim)", fontFamily: "var(--font-mono)" }}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(e); }} />
                <button type="submit"
                  className="px-3 py-1.5 rounded-lg text-[0.65rem] font-semibold text-white transition-all"
                  style={{ background: "linear-gradient(135deg, #e85d04, #ff7b00)" }}>
                  Apri
                </button>
              </div>
            </form>
            <div className="flex flex-wrap gap-1.5 justify-center">
              {SUGGESTIONS.map((s) => (
                <button key={s.url} onClick={() => navigate(s.url)}
                  className="px-2.5 py-1.5 rounded-lg text-[0.6rem] font-mono font-semibold"
                  style={{ backgroundColor: "rgba(232,93,4,0.08)", color: "var(--color-primary)", border: "1px solid rgba(232,93,4,0.12)" }}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      {currentUrl && (
        <div className="shrink-0 px-3 py-1 text-[0.55rem] flex items-center justify-between"
          style={{ color: "var(--color-neutral-text-muted)", opacity: 0.35 }}>
          <span>{webviewRef.current ? "🖥 WebView2" : "🔒 iframe"} privato</span>
          <button onClick={() => openSystem(currentUrl)}
            className="flex items-center gap-1 hover:opacity-100 transition-opacity"
            style={{ opacity: 0.7 }} title="Apri nel browser esterno">
            <ExternalLink size={10} />
            <span>esterno</span>
          </button>
        </div>
      )}
    </div>
  );
}
