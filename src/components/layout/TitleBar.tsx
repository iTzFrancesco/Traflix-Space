import { useEffect, useRef, useState } from "react";
import { Minus, Square, X, Server } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useMcpStore } from "../../stores/mcpStore";

const POPOVER_DELAY = 400;

function McpPopover() {
  const status = useMcpStore((s) => s.status);
  const loading = useMcpStore((s) => s.loading);
  const startServer = useMcpStore((s) => s.startServer);
  const stopServer = useMcpStore((s) => s.stopServer);
  const checkStatus = useMcpStore((s) => s.checkStatus);
  const [logs, setLogs] = useState("");
  const [logError, setLogError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const loadLogs = async () => {
    try {
      const content = await invoke<string>("mcp_logs");
      setLogs(content);
      setLogError(null);
    } catch (e) {
      setLogError(String(e));
    }
  };

  useEffect(() => {
    loadLogs();
    const interval = setInterval(loadLogs, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const toggleServer = async () => {
    if (loading) return;
    if (status.running) {
      await stopServer();
    } else {
      await startServer();
    }
    await checkStatus();
  };

  const dotColor = status.healthy
    ? "bg-green-400"
    : status.running
      ? "bg-yellow-400"
      : "bg-red-400";

  return (
    <div className="absolute top-full right-0 mt-1.5 w-[28rem] bg-neutral-darkest border rounded-lg shadow-2xl z-50 overflow-hidden"
      style={{ borderColor: "var(--neutral-border)" }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b"
        style={{ borderColor: "var(--neutral-border)" }}
      >
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${dotColor} ${status.healthy ? "animate-pulse" : ""}`} />
          <span className="text-xs font-semibold text-white">MCP Server</span>
          {status.pid && (
            <span className="text-[10px] font-mono text-neutral-text-muted">
              PID {status.pid}
            </span>
          )}
        </div>
        <button
          onClick={toggleServer}
          disabled={loading}
          className="text-xs font-medium px-2.5 py-1 rounded bg-primary/15 text-primary 
            hover:bg-primary/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? "…" : status.running ? "Ferma" : "Avvia"}
        </button>
      </div>

      <div ref={logRef} className="p-3 max-h-56 overflow-y-auto">
        {logError ? (
          <p className="text-xs text-red-400">{logError}</p>
        ) : logs ? (
          <pre className="text-[11px] leading-relaxed text-neutral-text-muted whitespace-pre-wrap font-mono">
            {logs}
          </pre>
        ) : (
          <p className="text-xs text-neutral-text-muted italic">
            Nessun log disponibile
          </p>
        )}
      </div>
    </div>
  );
}

function McpIndicator() {
  const [open, setOpen] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const status = useMcpStore((s) => s.status);

  const cancelTimers = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  };

  const handleMouseEnter = () => {
    cancelTimers();
    showTimer.current = setTimeout(() => setOpen(true), POPOVER_DELAY);
  };

  const handleMouseLeave = () => {
    cancelTimers();
    hideTimer.current = setTimeout(() => setOpen(false), POPOVER_DELAY);
  };

  useEffect(() => {
    return () => cancelTimers();
  }, []);

  const dotColor = status.healthy
    ? "bg-green-400"
    : status.running
      ? "bg-yellow-400"
      : "bg-red-400";

  const dotAnim = status.healthy ? "animate-pulse" : "";

  const title = status.healthy
    ? `MCP Server attivo (PID: ${status.pid ?? "?"})`
    : status.running
      ? "MCP Server in avvio…"
      : "MCP Server fermo";

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        title={title}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono
          hover:bg-white/5 transition-colors cursor-default"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor} ${dotAnim}`} />
        <Server size={12} className="text-neutral-text-muted" />
        <span className="text-neutral-text-muted">MCP</span>
      </div>

      {open && (
        <div
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <McpPopover />
        </div>
      )}
    </div>
  );
}

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
    <div
      data-tauri-drag-region
      className="flex items-center justify-between h-10 px-4 bg-neutral-darkest border-b select-none"
      style={{ borderColor: "var(--neutral-border)" }}
    >
      <div className="flex items-center gap-3">
        <img src="/icon.png" alt="Traflix" className="w-5 h-5 rounded" />
        <span className="font-display font-extrabold text-sm text-primary tracking-wider uppercase">
          Traflix Space
        </span>
      </div>

      <div className="flex items-center gap-2">
        <McpIndicator />

        <div className="flex gap-1">
          <button
            onClick={() => getAppWindow()?.minimize()}
            className="flex items-center justify-center w-8 h-8 rounded hover:bg-white/5 transition-colors"
          >
            <Minus size={14} className="text-neutral-text-muted" />
          </button>
          <button
            onClick={() => getAppWindow()?.toggleMaximize()}
            className="flex items-center justify-center w-8 h-8 rounded hover:bg-white/5 transition-colors"
          >
            <Square size={12} className="text-neutral-text-muted" />
          </button>
          <button
            onClick={() => getAppWindow()?.close()}
            className="flex items-center justify-center w-8 h-8 rounded hover:bg-red-500/20 transition-colors"
          >
            <X size={14} className="text-neutral-text-muted hover:text-red-400" />
          </button>
        </div>
      </div>
    </div>
  );
}
