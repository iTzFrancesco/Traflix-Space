import { useEffect } from "react";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { ToastContainer } from "./components/ui/Toast";
import { Sidebar } from "./components/layout/Sidebar";
import { TitleBar } from "./components/layout/TitleBar";
import { WorkspaceView } from "./components/workspace/WorkspaceView";
import { RightPanel } from "./components/layout/RightPanel";
import { AgentCompletionListener } from "./components/agent/AgentCompletionListener";
import { AgentNotificationOverlay } from "./components/agent/AgentNotificationOverlay";
import { JarvisGlobalOverlay } from "./components/jarvis/JarvisGlobalOverlay";
import { ProjectWorkspaceSync } from "./components/project/ProjectWorkspaceSync";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useWorkspaceStore } from "./stores/workspaceStore";
import { setupSkillsListener } from "./stores/skillStore";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

function isAgentNotificationWindow(): boolean {
  try {
    return getCurrentWebviewWindow().label === "agent-notification";
  } catch {
    // Vite browser preview has no Tauri window metadata; it is always the
    // normal application surface.
    return false;
  }
}

function App() {
  if (isAgentNotificationWindow()) {
    return <AgentNotificationOverlay />;
  }

  useKeyboardShortcuts(undefined, () => {
    const fn = (window as any).__traflix_request_close_terminal;
    if (typeof fn === "function") fn();
  });
  const syncWithBackend = useWorkspaceStore((s) => s.syncWithBackend);

  useEffect(() => {
    syncWithBackend();
  }, [syncWithBackend]);

  useEffect(() => {
    setupSkillsListener();
  }, []);

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-screen bg-neutral-bg app-canvas overflow-hidden">
        {/* TitleBar spanning the full top width */}
        <TitleBar />
        
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Sidebar on the left below TitleBar */}
          <Sidebar />
          
          {/* Main workspace content on the right */}
          <main className="flex-1 min-h-0 overflow-hidden relative">
            <ErrorBoundary>
              <WorkspaceView />
            </ErrorBoundary>
          </main>

          <RightPanel />
        </div>
      </div>
      <ProjectWorkspaceSync />
      <AgentCompletionListener />
      <JarvisGlobalOverlay />
      <ToastContainer />
    </ErrorBoundary>
  );
}

export default App;
