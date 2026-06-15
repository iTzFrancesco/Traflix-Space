import { Sidebar } from "./components/layout/Sidebar";
import { TitleBar } from "./components/layout/TitleBar";
import { WorkspaceView } from "./components/workspace/WorkspaceView";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { ToastContainer } from "./components/ui/Toast";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";

function App() {
  useKeyboardShortcuts();

  return (
    <ErrorBoundary>
      <div className="flex flex-col h-screen bg-neutral-bg">
        <TitleBar />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <main style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
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
