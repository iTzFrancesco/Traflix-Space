import { readFileSync } from "node:fs";

export const source = (path) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
// The terminal implementation now crosses a small set of cohesive modules.
// Keep the legacy static-test seam as a deterministic concatenation so the
// assertions continue to cover the real implementation after refactoring.
export const terminalPane = [
  source("../../src/components/workspace/TerminalPaneRuntime.ts"),
  source("../../src/components/workspace/useTerminalPaneLayout.ts"),
  source("../../src/components/workspace/useTerminalPaneLifecycle.ts"),
  source("../../src/components/workspace/TerminalPaneView.tsx"),
  source("../../src/components/workspace/TerminalPane.tsx"),
].join("\n");
export const terminalPaneSupport = source(
  "../../src/components/workspace/TerminalPaneSupport.ts",
);
export const terminalPaneRuntime = source(
  "../../src/components/workspace/TerminalPaneRuntime.ts",
);
export const terminalPaneLayout = source(
  "../../src/components/workspace/useTerminalPaneLayout.ts",
);
export const terminalPaneLifecycle = source(
  "../../src/components/workspace/useTerminalPaneLifecycle.ts",
);
export const terminalManager = [
  source("../../src-tauri/src/terminal_engine/manager_detection.rs"),
  source("../../src-tauri/src/terminal_engine/manager_identity.rs"),
  source("../../src-tauri/src/terminal_engine/manager_lifecycle.rs"),
  source("../../src-tauri/src/terminal_engine/manager_notifications.rs"),
  source("../../src-tauri/src/terminal_engine/manager_state.rs"),
  source("../../src-tauri/src/terminal_engine/manager_vt.rs"),
  source("../../src-tauri/src/terminal_engine/mod.rs"),
].join("\n");
export const terminalSession = [
  source("../../src-tauri/src/terminal_engine/session_cwd.rs"),
  source("../../src-tauri/src/terminal_engine/session_process.rs"),
  source("../../src-tauri/src/terminal_engine/session.rs"),
].join("\n");
export const terminalEvents = source("../../src/lib/terminalEvents.ts");
export const workspaceView = [
  source("../../src/components/workspace/useWorkspaceTerminalActions.ts"),
  source("../../src/components/workspace/workspaceTypes.ts"),
  source("../../src/components/workspace/WorkspaceView.tsx"),
].join("\n");
export const jarvisControl = [
  source("../../src-tauri/src/jarvis/control.rs"),
  source("../../src-tauri/src/jarvis/control/lifecycle.rs"),
  source("../../src-tauri/src/jarvis/control/reactivation.rs"),
].join("\n");

export const outputChunk = (
  sequence,
  text,
  generation = 7,
  processId = 42,
  workspaceId = "workspace-a",
) => ({
  workspaceId,
  generation,
  processId,
  sequence,
  data: new TextEncoder().encode(text),
});
