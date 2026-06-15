import { Sidebar } from "./components/layout/Sidebar";
import { TitleBar } from "./components/layout/TitleBar";
import { WorkspaceView } from "./components/workspace/WorkspaceView";

function App() {
  return (
    <div className="flex flex-col h-screen bg-neutral-bg">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-hidden">
          <WorkspaceView />
        </main>
      </div>
    </div>
  );
}

export default App;
