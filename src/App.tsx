import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { PanelLeftOpen } from "lucide-react";
import { Sidebar } from "./components/layout/Sidebar";
import { RightPanel } from "./components/layout/RightPanel";
import { TitleBar } from "./components/layout/TitleBar";
import { WorkspaceView } from "./components/workspace/WorkspaceView";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { ToastContainer } from "./components/ui/Toast";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useUIStore } from "./stores/uiStore";
import { registerPreviewTabs } from "./components/preview/BrowserView";
import { setupSkillsListener } from "./stores/skillStore";

// Registra le view del pannello destro all'avvio
registerPreviewTabs();

// Avvia listener skills (caricamento iniziale + watch filesystem)
setupSkillsListener();

function App() {
  useKeyboardShortcuts(undefined, () => {
    const fn = (window as any).__traflix_close_terminal;
    if (typeof fn === "function") fn();
  });
  const syncWithBackend = useWorkspaceStore((s) => s.syncWithBackend);

  useEffect(() => {
    syncWithBackend();
  }, [syncWithBackend]);

  const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useUIStore((s) => s.toggleRightPanel);

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-screen bg-neutral-bg">
        <TitleBar />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <Sidebar />
          <main className="flex-1 min-h-0 overflow-hidden relative">
            {!rightPanelOpen && (
              <motion.button
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3, duration: 0.3 }}
                onClick={toggleRightPanel}
                className="absolute right-0 top-3 z-20 flex items-center justify-center"
                style={{
                  color: "var(--color-neutral-text-muted)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = "var(--color-primary)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = "var(--color-neutral-text-muted)";
                }}
                title="Apri pannello"
              >
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center transition-colors duration-200"
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.08)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.backgroundColor = "transparent")
                  }
                >
                  <PanelLeftOpen size={22} />
                </div>
              </motion.button>
            )}
            <ErrorBoundary>
              <WorkspaceView />
            </ErrorBoundary>
          </main>
          <AnimatePresence>
            {rightPanelOpen && <RightPanel />}
          </AnimatePresence>
        </div>
      </div>
      <ToastContainer />
    </ErrorBoundary>
  );
}

export default App;
