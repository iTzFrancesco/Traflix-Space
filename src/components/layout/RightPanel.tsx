import { useRef } from "react";
import {
  PanelLeftClose,
} from "lucide-react";
import { motion } from "framer-motion";
import { useUIStore } from "../../stores/uiStore";
import type { RightPanelView } from "../../stores/uiStore";

/* ─── View Registry ───
 * Sistema a plugin: moduli esterni registrano view tramite registerRightPanelView().
 * Ogni view ha: label, icon, component, disabled (placeholder futuro).
 *
 * Esempio:
 *   registerRightPanelView("chat", {
 *     label: "AI Chat",
 *     icon: MessageSquare,
 *     component: ChatView,
 *   });
 */

export interface PanelViewDefinition {
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  component: React.ComponentType;
  /** Se true, la tab è visibile ma disabilitata (placeholder per funzioni future) */
  disabled?: boolean;
}

const panelViewRegistry = new Map<string, PanelViewDefinition>();

export function registerRightPanelView(id: string, def: PanelViewDefinition) {
  panelViewRegistry.set(id, def);

  // Auto-attiva la prima view funzionale se nessuna è attiva
  const state = useUIStore.getState();
  if (!state.rightPanelActiveView && !def.disabled) {
    state.setRightPanelActiveView(id);
  }
}

/* ─── View Renderer ─── */

function RightPanelContent({ view }: { view: RightPanelView }) {
  if (!view || !panelViewRegistry.has(view)) {
    return null;
  }

  const def = panelViewRegistry.get(view)!;
  return <def.component />;
}

/* ─── RightPanel ─── */

export function RightPanel() {
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel);
  const rightPanelWidth = useUIStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useUIStore((s) => s.setRightPanelWidth);
  const rightPanelActiveView = useUIStore((s) => s.rightPanelActiveView);

  const panelRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const defaultSnap = useRef(rightPanelWidth);

  /* ─── Resize handler (speculare al Sidebar ma sull'altro lato) ─── */
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!panelRef.current) return;
    const handleEl = e.currentTarget as HTMLElement;

    dragStartX.current = e.clientX;
    dragStartWidth.current = panelRef.current.getBoundingClientRect().width;
    defaultSnap.current = rightPanelWidth;

    const lineEl = handleEl.querySelector<HTMLElement>("[data-resize-line]");
    const bgEl = handleEl.querySelector<HTMLElement>("[data-resize-bg]");
    if (lineEl) {
      lineEl.style.backgroundColor = "var(--color-primary)";
      lineEl.style.boxShadow = "0 0 6px rgba(232,93,4,0.4)";
      lineEl.style.width = "2px";
    }
    if (bgEl) {
      bgEl.style.background =
        "linear-gradient(270deg, transparent, rgba(232,93,4,0.12))";
      bgEl.style.opacity = "1";
    }

    const handleMouseMove = (e: MouseEvent) => {
      const delta = dragStartX.current - e.clientX;
      const newWidth = Math.max(
        280,
        Math.min(560, dragStartWidth.current + delta),
      );
      const finalWidth =
        Math.abs(newWidth - defaultSnap.current) <= 10
          ? defaultSnap.current
          : newWidth;
      if (panelRef.current) {
        panelRef.current.style.width = `${finalWidth}px`;
      }
    };

    const handleMouseUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";

      if (lineEl) {
        lineEl.style.backgroundColor = "";
        lineEl.style.boxShadow = "";
        lineEl.style.width = "";
      }
      if (bgEl) {
        bgEl.style.background = "";
        bgEl.style.opacity = "";
      }

      if (panelRef.current) {
        const finalWidth = parseFloat(panelRef.current.style.width);
        if (!isNaN(finalWidth)) {
          setRightPanelWidth(Math.round(finalWidth));
        }
      }

      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  /* ─── Pannello espanso (App.tsx gestisce il pulsante collapsed) ─── */
  const hasViews = panelViewRegistry.size > 0;

  return (
    <motion.aside
      ref={panelRef}
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 35, mass: 0.8 }}
      className="flex flex-col h-full select-none relative"
      style={{
        width: `${rightPanelWidth}px`,
        minWidth: "280px",
        backgroundColor: "var(--color-neutral-surface)",
        borderLeft: "1px solid var(--color-neutral-border)",
      }}
    >
      {/* Resize handle — sulla SINISTRA del pannello */}
      <div
        onMouseDown={handleResizeMouseDown}
        className="absolute left-0 top-0 bottom-0 w-2 z-20 cursor-col-resize group"
      >
        <div
          data-resize-line
          className="absolute inset-y-2 left-0 w-px transition-all duration-150 group-hover:w-0.5"
          style={{
            backgroundColor: "var(--color-neutral-border)",
          }}
        />
        <div
          data-resize-bg
          className="absolute inset-y-0 left-0 w-full opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          style={{
            background:
              "linear-gradient(270deg, transparent, rgba(255,255,255,0.04))",
          }}
        />
      </div>

      {/* ─── Tab Bar — centrata verticalmente, icone grandi, gap generoso ─── */}
      <div
        className="flex items-center gap-4 px-5 py-4"
        style={{
          borderBottom: hasViews
            ? "1px solid var(--color-neutral-border)"
            : "none",
        }}
      >
        {/* Collapse button — più grande */}
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={toggleRightPanel}
          className="p-3 rounded-xl transition-colors duration-200 shrink-0 flex items-center justify-center"
          style={{ color: "var(--color-neutral-text-muted)" }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.08)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.backgroundColor = "transparent")
          }
          title="Chiudi pannello"
        >
          <PanelLeftClose size={24} />
        </motion.button>

        {/* Tab pills — più grandi, più spaziate */}
        {hasViews && (
          <div className="flex items-center gap-4 flex-1 min-w-0">
            {Array.from(panelViewRegistry.entries())
              .filter(([, def]) => !def.disabled)
              .map(([id, def]) => {
                const isActive = rightPanelActiveView === id;
                const Icon = def.icon;

                return (
                  <button
                    key={id}
                    onClick={() =>
                      useUIStore
                        .getState()
                        .setRightPanelActiveView(isActive ? null : id)
                    }
                    className="flex items-center gap-3 px-5 py-3 rounded-xl text-[1rem] font-semibold transition-all duration-200 whitespace-nowrap shrink-0"
                    style={{
                      backgroundColor: isActive
                        ? "rgba(232,93,4,0.1)"
                        : "transparent",
                      color: isActive
                        ? "var(--color-primary)"
                        : "var(--color-neutral-text-muted)",
                      boxShadow: isActive
                        ? "inset 0 0 0 1px rgba(232,93,4,0.2)"
                        : "none",
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive)
                        e.currentTarget.style.backgroundColor =
                          "rgba(255,255,255,0.04)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive)
                        e.currentTarget.style.backgroundColor = "transparent";
                    }}
                  >
                    <Icon size={20} />
                    {def.label}
                  </button>
                );
              })}
          </div>
        )}
      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <RightPanelContent view={rightPanelActiveView} />
      </div>
    </motion.aside>
  );
}
