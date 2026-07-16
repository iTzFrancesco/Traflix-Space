import { useEffect } from "react";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { ToastContainer } from "./components/ui/Toast";
import { Sidebar } from "./components/layout/Sidebar";
import { TitleBar } from "./components/layout/TitleBar";
import { WorkspaceView } from "./components/workspace/WorkspaceView";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useWorkspaceStore } from "./stores/workspaceStore";

function App() {
  useKeyboardShortcuts(undefined, () => {
    const fn = (window as any).__traflix_request_close_terminal;
    if (typeof fn === "function") fn();
  });
  const syncWithBackend = useWorkspaceStore((s) => s.syncWithBackend);

  useEffect(() => {
    syncWithBackend();
  }, [syncWithBackend]);

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-screen bg-neutral-bg">
        <TitleBar />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <Sidebar />
          <main className="flex-1 min-h-0 overflow-hidden relative">
            <ErrorBoundary>
              <WorkspaceView />
            </ErrorBoundary>
          </main>
        </div>
      </div>
      <ToastContainer />
    </ErrorBoundary>
  );
}

export default App;
