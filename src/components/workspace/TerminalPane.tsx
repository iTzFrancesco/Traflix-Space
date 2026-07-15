import { memo, useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { useTerminalInput } from "../terminal/useTerminalInput";
import { useTerminalStore } from "../../stores/terminalStore";
import { useSkillStore } from "../../stores/skillStore";
import { agentLaunchQueue } from "../../lib/agentLauncher";
import {
  subscribeTerminalExit,
  subscribeTerminalOutput,
} from "../../lib/terminalEvents";
import "xterm/css/xterm.css";

const STOCK_THEME = {
  background: "#0c0c0c",
  foreground: "#cccccc",
  cursor: "#ffffff",
  cursorAccent: "#0c0c0c",
  selectionBackground: "rgba(255,255,255,0.3)",
  selectionInactiveBackground: "rgba(255,255,255,0.15)",
  black: "#0c0c0c",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

interface TerminalPaneProps {
  terminalId: string;
  shell: string;
  cwd: string;
  title: string;
  agentId?: string | null;
  isActive: boolean;
  onActivate: (id: string) => void;
  onClose?: (id: string) => void;
}

const ACTIVE_STYLE = {
  position: "relative" as const,
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "#0c0c0c",
  borderRadius: "var(--radius-pane)",
  border: "1px solid #e85d04",
  overflow: "hidden" as const,
  isolation: "isolate" as const,
};

const INACTIVE_STYLE = {
  position: "relative" as const,
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "#0c0c0c",
  borderRadius: "var(--radius-pane)",
  border: "1px solid rgba(255,255,255,0.10)",
  overflow: "hidden" as const,
  cursor: "pointer" as const,
  isolation: "isolate" as const,
};

const EXITED_STYLE = {
  position: "relative" as const,
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  background: "#0c0c0c",
  borderRadius: "var(--radius-pane)",
  border: "1px solid rgba(239,68,68,0.3)",
  overflow: "hidden" as const,
  isolation: "isolate" as const,
};

const CLOSE_BTN_STYLE: React.CSSProperties = {
  position: "absolute",
  top: "8px",
  right: "8px",
  width: "28px",
  height: "28px",
  borderRadius: "8px",
  border: "none",
  background: "rgba(239,68,68,0.2)",
  color: "#ef4444",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: "14px",
  lineHeight: 1,
  zIndex: 10,
  transition: "all 0.15s ease",
};

const CONTAINER_STYLE = {
  position: "absolute" as const,
  inset: 0,
  background: "#0c0c0c",
  overflow: "hidden" as const,
};

export const TerminalPane = memo(function TerminalPane({
  terminalId, shell, cwd, title: _title, agentId, isActive, onActivate, onClose,
}: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  const unsubOutputRef = useRef<(() => void) | null>(null);
  const unsubExitRef = useRef<(() => void) | null>(null);
  const terminalIdRef = useRef(terminalId);
  terminalIdRef.current = terminalId;
  const autoScrollRef = useRef(true);
  // Flag per distinguere scroll programmatici (scrollToBottom, resize) da scroll utente
  const programmaticScrollRef = useRef(false);
  const scrollDisposableRef = useRef<{ dispose: () => void } | null>(null);

  // Leggi lo stato exit dallo store
  const exitCode = useTerminalStore((s) => s.terminals[terminalId]?.exitCode ?? null);
  const hasExited = exitCode !== null;

  // Ref per onClose (aggiornato senza triggerare re-render)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Auto-chiusura quando il terminale esce (shell exit)
  useEffect(() => {
    if (!hasExited) return;
    const timer = setTimeout(() => {
      onCloseRef.current?.(terminalId);
    }, 1500);
    return () => clearTimeout(timer);
  }, [hasExited, terminalId]);

  // Stato conferma chiusura
  const [confirmClose, setConfirmClose] = useState(false);

  // Drag-over state per skills drop
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  // Auto-annulla conferma dopo 3s
  useEffect(() => {
    if (!confirmClose) return;
    const timer = setTimeout(() => setConfirmClose(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmClose]);

  // Leggi pending drops per questo terminale
  const pendingDrops = useSkillStore((s) => s.pendingDrops[terminalId]);
  const pendingNames = pendingDrops?.names ?? [];

  // Escape annulla conferma
  useEffect(() => {
    if (!confirmClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmClose(false);
    };
    document.addEventListener("keydown", handler, { capture: true });
    return () => document.removeEventListener("keydown", handler, { capture: true });
  }, [confirmClose]);

  // 1. Crea xterm al mount, aprilo nel container (sempre nel DOM), distruggi al unmount
  useEffect(() => {
    const term = new Terminal({
      theme: STOCK_THEME,
      fontFamily: '"Cascadia Mono", "Cascadia Code", "Consolas", "Lucida Console", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 1,
      scrollback: 500,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    if (containerRef.current) {
      term.open(containerRef.current);
    }

    term.onData((data) => {
      const tid = terminalIdRef.current;
      if (!tid) return;
      // Non scrivere se il terminale è uscito
      const store = useTerminalStore.getState();
      const termState = store.terminals[tid];
      if (termState && termState.exitCode !== null) return;
      invoke("terminal_write", {
        terminalId: tid,
        data: Array.from(new TextEncoder().encode(data)),
      }).catch(() => {});
    });

    // Auto-scroll: traccia se l'utente è incollato al fondo.
    // Ignora scroll programmatici (scrollToBottom, resize) per evitare che
    // lo stato interno di xterm.js corrompa autoScrollRef.
    scrollDisposableRef.current?.dispose();
    scrollDisposableRef.current = term.onScroll(() => {
      if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        return;
      }
      const buffer = term.buffer.active;
      autoScrollRef.current = buffer.viewportY >= buffer.baseY;
    });

    return () => {
      unsubOutputRef.current?.();
      unsubOutputRef.current = null;
      unsubExitRef.current?.();
      unsubExitRef.current = null;
      scrollDisposableRef.current?.dispose();
      scrollDisposableRef.current = null;
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // 2. Spawn PTY + launch agente al mount (senza click)
  useEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    if (spawnedRef.current) return;
    // Non respawnare se è uscito
    const storeState = useTerminalStore.getState();
    const t = storeState.terminals[terminalId];
    if (t && t.exitCode !== null) return;
    spawnedRef.current = true;

    invoke("terminal_spawn", {
      terminalId, shell, cwd, cols: Math.max(term.cols, 80), rows: Math.max(term.rows, 24),
    }).catch(() => {});

    if (agentId) {
      const store = useTerminalStore.getState();
      const terminal = store.terminals[terminalId];
      if (!terminal?.agentLaunched) {
        store.markAgentLaunched(terminalId);
        agentLaunchQueue.enqueue(terminalId, agentId);
      }
    }
  }, [terminalId, shell, cwd, agentId]);

  // 3. Focus + active state quando cliccato
  useEffect(() => {
    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    if (isActive) {
      requestAnimationFrame(() => {
        fitAddon.fit();
        term.focus();
        term.clearSelection();
        // Forza repaint completo per eliminare artefatti visivi
        term.refresh(0, term.rows - 1);
      });

      invoke("terminal_set_active", { terminalId }).catch(() => {});
    } else {
      // Quando diventa inattivo: forza repaint pulito per evitare ghost text
      requestAnimationFrame(() => {
        term.refresh(0, term.rows - 1);
      });
    }
  }, [isActive, terminalId]);

  // 4a. Output — shared bus (one Tauri listen for all panes)
  useEffect(() => {
    unsubOutputRef.current?.();
    unsubOutputRef.current = subscribeTerminalOutput(terminalId, ({ data }) => {
      const term = xtermRef.current;
      term?.write(new Uint8Array(data));
      if (autoScrollRef.current && term) {
        programmaticScrollRef.current = true;
        term.scrollToBottom();
      }
    });
    return () => {
      unsubOutputRef.current?.();
      unsubOutputRef.current = null;
    };
  }, [terminalId]);

  // 4b. Exit — shared bus
  useEffect(() => {
    unsubExitRef.current?.();
    unsubExitRef.current = subscribeTerminalExit(terminalId, ({ terminalId: tid, exitCode }) => {
      useTerminalStore.getState().markExited(tid, exitCode);
    });
    return () => {
      unsubExitRef.current?.();
      unsubExitRef.current = null;
    };
  }, [terminalId]);

  // 5. Resize handler — ResizeObserver con throttle per evitare resize rapidi
  // che troncherebbero lo scrollback di xterm.js e corromperebbero l'autoscroll.
  // Usa time throttle (min 100ms tra resize) + rAF.
  useEffect(() => {
    const handleResize = () => {
      const term = xtermRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon) return;

      // Salva lo stato autoscroll PRIMA del resize: fit() può generare onScroll
      // internamente che altererebbe autoScrollRef in modo spurio.
      const wasAtBottom = autoScrollRef.current;

      fitAddon.fit();

      // Dopo il resize, scrolla in fondo SOLO se l'utente era già lì.
      // Usa programmaticScrollRef per evitare che onScroll corregga autoScrollRef.
      if (wasAtBottom) {
        programmaticScrollRef.current = true;
        term.scrollToBottom();
      }

      invoke("terminal_resize", { terminalId, cols: term.cols, rows: term.rows })
        .catch(() => {});
    };

    const container = containerRef.current;
    if (!container) return;

    // Throttle: minimo 100ms tra resize per evitare distruzione dello scrollback
    // durante drag rapidi della sidebar o cambi layout della griglia.
    let lastResizeTime = 0;
    const RESIZE_THROTTLE_MS = 100;

    // Initial fit al mount con aggiornamento lastResizeTime
    const raf = requestAnimationFrame(() => {
      lastResizeTime = Date.now();
      handleResize();
    });

    // ResizeObserver con throttle temporale + rAF
    let observerRaf: number | null = null;
    const observer = new ResizeObserver(() => {
      if (observerRaf !== null) cancelAnimationFrame(observerRaf);
      observerRaf = requestAnimationFrame(() => {
        const now = Date.now();
        if (now - lastResizeTime >= RESIZE_THROTTLE_MS) {
          lastResizeTime = now;
          handleResize();
        }
      });
    });
    observer.observe(container);

    return () => {
      cancelAnimationFrame(raf);
      if (observerRaf !== null) cancelAnimationFrame(observerRaf);
      observer.disconnect();
    };
  }, [terminalId]);

  useTerminalInput(terminalId, containerRef, xtermRef);

  // Attiva il terminale al click — in capture phase per bypassare stopPropagation di xterm
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  useEffect(() => {
    const el = containerRef.current?.parentElement;
    if (!el) return;
    const handleMouseDown = () => {
      if (!isActiveRef.current) {
        onActivate(terminalId);
      }
    };
    el.addEventListener("mousedown", handleMouseDown, { capture: true });
    return () => el.removeEventListener("mousedown", handleMouseDown, { capture: true });
  }, [terminalId, onActivate]);

  const handleCloseClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmClose(true);
  }, []);

  const handleConfirmClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmClose(false);
    onClose?.(terminalId);
  }, [terminalId, onClose]);

  const handleCancelClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmClose(false);
  }, []);

  const handleRestart = useCallback(async () => {
    try {
      await invoke("terminal_reopen", {
        terminalId,
        shell,
        cwd,
      });
      useTerminalStore.getState().markSpawned(terminalId);
      spawnedRef.current = true;
    } catch (err) {
      console.error("Errore reopen terminale:", err);
    }
  }, [terminalId, shell, cwd]);

  /* ─── Drag & Drop handlers ─── */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      dragCounterRef.current = 0;

      try {
        // Tenta application/json (formato strutturato)
        const raw = e.dataTransfer.getData("application/json");
        if (raw) {
          const data = JSON.parse(raw);
          if (data.type === "skill" && data.name) {
            useSkillStore.getState().addPendingDrop(terminalId, data.name);
            return;
          }
        }

        // Fallback: text/plain (compatibilità con @dnd-kit o drag semplici)
        const text = e.dataTransfer.getData("text/plain");
        if (text && text.trim()) {
          // Verifica se sembra un nome di skill (confronto case-insensitive con skills note)
          const skills = useSkillStore.getState().skills;
          const matchedSkill = skills.find(
            (s) => s.name.toLowerCase() === text.trim().toLowerCase()
          );
          if (matchedSkill) {
            useSkillStore.getState().addPendingDrop(terminalId, matchedSkill.name);
          }
        }
      } catch {
        // Ignora drop malformati
      }
    },
    [terminalId],
  );

  const outerStyle = hasExited
    ? EXITED_STYLE
    : (isActive ? ACTIVE_STYLE : INACTIVE_STYLE);

  const dragOverlayStyle = isDragOver
    ? { borderColor: "var(--color-primary)", boxShadow: "inset 0 0 0 1px var(--color-primary), 0 0 16px rgba(232,93,4,0.15)" }
    : {};

  return (
    <div
      style={{ ...outerStyle, ...dragOverlayStyle }}
      tabIndex={-1}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Container xterm — sempre presente nel DOM */}
      <div ref={containerRef} style={CONTAINER_STYLE} />

      {/* Pulsante chiudi / conferma chiusura — in alto a destra */}
      {onClose && !hasExited && (
        confirmClose ? (
          <div
            style={{
              position: "absolute",
              top: "8px",
              right: "8px",
              zIndex: 10,
              display: "flex",
              gap: "6px",
              alignItems: "center",
              background: "rgba(12,12,12,0.96)",
              borderRadius: "10px",
              padding: "5px 6px",
              border: "1px solid rgba(239,68,68,0.35)",
              boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
            }}
          >
            <span
              style={{
                fontSize: "12px",
                color: "#ef4444",
                padding: "0 6px",
                fontWeight: 600,
                whiteSpace: "nowrap",
                fontFamily: "var(--font-mono)",
              }}
            >
              Chiudere?
            </span>
            <button
              onClick={handleConfirmClose}
              title="Conferma chiusura"
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "8px",
                border: "none",
                background: "rgba(239,68,68,0.25)",
                color: "#ef4444",
                cursor: "pointer",
                fontSize: "13px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
                transition: "all 0.12s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(239,68,68,0.45)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(239,68,68,0.25)";
              }}
            >
              ✓
            </button>
            <button
              onClick={handleCancelClose}
              title="Annulla"
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "8px",
                border: "none",
                background: "rgba(255,255,255,0.08)",
                color: "#a1a1aa",
                cursor: "pointer",
                fontSize: "13px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                lineHeight: 1,
                transition: "all 0.12s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.15)";
                e.currentTarget.style.color = "#f4f4f5";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "rgba(255,255,255,0.08)";
                e.currentTarget.style.color = "#a1a1aa";
              }}
            >
              ✕
            </button>
          </div>
        ) : (
          <button
            onClick={handleCloseClick}
            style={CLOSE_BTN_STYLE}
            title="Chiudi terminale — click per conferma"
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(239,68,68,0.35)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(239,68,68,0.2)";
            }}
          >
            ✕
          </button>
        )
      )}

      {/* Pending skill drops indicator */}
      {pendingNames.length > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: "8px",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 15,
            display: "flex",
            alignItems: "center",
            gap: "6px",
            padding: "6px 14px",
            borderRadius: "10px",
            fontSize: "12px",
            fontFamily: "var(--font-mono)",
            fontWeight: 500,
            color: "var(--color-primary)",
            backgroundColor: "rgba(232,93,4,0.12)",
            border: "1px solid rgba(232,93,4,0.25)",
            backdropFilter: "blur(8px)",
            whiteSpace: "nowrap",
            pointerEvents: "none" as const,
          }}
        >
          <span style={{ fontSize: "14px", lineHeight: 1 }}>🎯</span>
          <span>usa{" "}
            {pendingNames.length === 1
              ? `la skill ${pendingNames[0]}`
              : pendingNames.length === 2
                ? `le skill ${pendingNames.join(" e ")}`
                : `le skill ${pendingNames.slice(0, -1).join(", ")} e ${pendingNames[pendingNames.length - 1]}`
            }
          </span>
        </div>
      )}

      {/* Overlay terminale uscito */}
      {hasExited && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(12,12,12,0.92)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "20px",
            zIndex: 20,
            backdropFilter: "blur(4px)",
            padding: "24px",
          }}
        >
          {/* Icona terminale spento */}
          <svg
            width="36"
            height="36"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ef4444"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: 0.6 }}
          >
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>

          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "14px",
              color: "#ef4444",
              fontWeight: 500,
              opacity: 0.9,
              textAlign: "center",
              lineHeight: 1.4,
            }}
          >
            Terminale chiuso (exit code: {exitCode})
          </span>

          <button
            onClick={handleRestart}
            style={{
              padding: "12px 28px",
              borderRadius: "10px",
              border: "1px solid rgba(232,93,4,0.4)",
              background: "rgba(232,93,4,0.12)",
              color: "#e85d04",
              cursor: "pointer",
              fontFamily: "var(--font-display)",
              fontSize: "14px",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: "10px",
              letterSpacing: "0.02em",
              transition: "all 0.2s ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(232,93,4,0.25)";
              e.currentTarget.style.borderColor = "rgba(232,93,4,0.7)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(232,93,4,0.12)";
              e.currentTarget.style.borderColor = "rgba(232,93,4,0.4)";
            }}
          >
            {/* SVG restart custom */}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Riapri terminale
          </button>
        </div>
      )}
    </div>
  );
});
