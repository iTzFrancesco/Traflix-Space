import { useEffect } from "react";
import { Sidebar } from "./components/layout/Sidebar";
import { TitleBar } from "./components/layout/TitleBar";
import { WorkspaceView } from "./components/workspace/WorkspaceView";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { ToastContainer } from "./components/ui/Toast";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { useMcpStore } from "./stores/mcpStore";

const MCP_POLL_INTERVAL = 5000;

function App() {
  useKeyboardShortcuts(undefined, () => {
    const fn = (window as any).__traflix_close_terminal;
    if (typeof fn === "function") fn();
  });
  const syncWithBackend = useWorkspaceStore((s) => s.syncWithBackend);
  const checkMcpStatus = useMcpStore((s) => s.checkStatus);

  useEffect(() => {
    syncWithBackend();
  }, [syncWithBackend]);

  useEffect(() => {
    checkMcpStatus();
    const interval = setInterval(checkMcpStatus, MCP_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [checkMcpStatus]);

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-screen bg-neutral-bg">
        <TitleBar />
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <Sidebar />
          <main className="flex-1 min-h-0 overflow-hidden">
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
