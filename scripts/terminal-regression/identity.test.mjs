import assert from "node:assert/strict";
import test from "node:test";
import {
  jarvisControl,
  source,
  terminalManager,
  terminalPane,
  terminalSession,
} from "./shared.mjs";
test("terminal lifecycle rejects stale open, exit, completion, and cross-workspace identity", async () => {
  const backendEvents = source("../../src-tauri/src/agent_events.rs");
  const backendManager = terminalManager;
  assert.match(backendEvents, /observe_agent_provider_for_runtime/);
  assert.match(backendEvents, /get_recent_normalized_terminal_text_for_runtime/);
  assert.ok(
    backendEvents.lastIndexOf("validate_runtime_identity") <
      backendEvents.indexOf('app.emit("agent-turn-completed"'),
    "completion identity must be checked again immediately before frontend emission",
  );
  assert.match(backendManager, /stale-terminal-generation: provider target changed/);

  const { useTerminalStore } = await import("../../src/stores/terminalStore.ts");
  useTerminalStore.setState({
    terminals: {},
    terminalOrderByWorkspace: {},
    activeTerminalByWorkspace: {},
    focusedTerminalByWorkspace: {},
    activeTerminalId: null,
    focusedTerminalId: null,
    terminalTitles: {},
    draggedTerminalId: null,
    dragHoveredTerminalId: null,
  });

  const store = useTerminalStore.getState();
  for (const [id, workspaceId] of [
    ["left", "workspace-a"],
    ["right", "workspace-a"],
    ["other", "workspace-b"],
  ]) {
    store.addTerminal({
      id,
      workspaceId,
      shell: "powershell.exe",
      cwd: "C:\\repo",
      title: id,
      agent: id === "other" ? null : "codex",
    });
  }
  store.syncWorkspaceTerminalOrder("workspace-a", ["right", "left"]);
  store.markBackendAgentLaunch("left", "workspace-a", 10, 110, "starting");
  store.markBackendAgentLaunch("right", "workspace-a", 11, 111, "starting");
  store.markBackendAgentLaunch("left", "workspace-a", 10, 110, "ready");

  // Reordered/delayed lifecycle events cannot regress a ready launch or move
  // a terminal to another workspace/process.
  store.markBackendAgentLaunch("left", "workspace-a", 10, 110, "starting");
  store.markBackendAgentLaunch("left", "workspace-a", 10, 999, "failed");
  store.markBackendAgentLaunch("left", "workspace-b", 12, 112, "ready");
  assert.equal(useTerminalStore.getState().terminals.left.backendLaunchState, "ready");
  assert.equal(useTerminalStore.getState().terminals.left.generation, 10);
  assert.equal(useTerminalStore.getState().terminals.left.workspaceId, "workspace-a");

  // Same id, new generation: every old exit/close/completion is inert.
  store.markSpawned("left", "workspace-a", 12, 112);
  store.saveScrollPosition("left", 12, {
    followsOutput: false,
    offsetFromBottom: 4,
  });
  store.markSpawned("left", "workspace-a", 10, 110);
  store.saveScrollPosition("left", 10, {
    followsOutput: false,
    offsetFromBottom: 99,
  });
  store.markExited("left", "workspace-a", 10, 110, 0);
  store.removeTerminal("left", 10);
  store.markAgentTurnCompleted("left", {
    protocol: 1,
    provider: "codex",
    kind: "turn_completed",
    terminalId: "left",
    workspaceId: "workspace-a",
    generation: 10,
    processId: 110,
    eventId: "old-completion",
  }, true);
  assert.equal(useTerminalStore.getState().terminals.left.spawned, true);
  assert.equal(useTerminalStore.getState().terminals.left.generation, 12);
  assert.equal(
    useTerminalStore.getState().terminals.left.scrollPosition.offsetFromBottom,
    4,
  );
  assert.equal(useTerminalStore.getState().terminals.left.lastAgentCompletion, null);

  store.markBackendAgentLaunch("left", "workspace-a", 12, 112, "ready");
  store.markAgentTurnCompleted("left", {
    protocol: 1,
    provider: "codex",
    kind: "turn_completed",
    terminalId: "left",
    workspaceId: "workspace-a",
    generation: 12,
    processId: 112,
    eventId: "current-completion",
  }, true);
  assert.equal(
    useTerminalStore.getState().terminals.left.lastAgentCompletion?.eventId,
    "current-completion",
  );

  // Persisted order remains primary while two rapid opens and two closes land.
  assert.deepEqual(
    useTerminalStore.getState().getByWorkspace("workspace-a").map((terminal) => terminal.id),
    ["right", "left"],
  );
  store.setActiveTerminal("right");
  store.setFocusedTerminal("right");
  store.removeTerminal("right", 11);
  store.removeTerminal("left", 12);
  assert.equal(useTerminalStore.getState().focusedTerminalId, null);
  assert.equal(useTerminalStore.getState().activeTerminalId, null);
  assert.deepEqual(
    useTerminalStore.getState().getByWorkspace("workspace-b").map((terminal) => terminal.id),
    ["other"],
  );
});

test("terminal title stays aligned with the durable Jarvis-facing configuration", () => {
  const renameStart = terminalPane.indexOf("const handleRenameSubmit");
  const renameEnd = terminalPane.indexOf("const handleRenameKeyDown", renameStart);
  const renameFlow = terminalPane.slice(renameStart, renameEnd);
  assert.ok(renameStart >= 0 && renameEnd > renameStart);
  assert.ok(
    renameFlow.indexOf('invoke("update_terminal_title"') <
      renameFlow.indexOf("renameTerminal(terminalId, trimmed)"),
  );
  assert.match(renameFlow, /terminal-title-error/);
  assert.doesNotMatch(renameFlow, /catch\(\(\) => undefined\)/);
});

test("workspace load ordering and launch dedupe use the full runtime identity", async () => {
  const {
    acceptsWorkspaceRevision,
    terminalIdentityCollision,
  } = await import("../../src/lib/workspaceTerminalProtocol.ts");
  const { agentLaunchKey } = await import("../../src/lib/agentLaunchIdentity.ts");

  const refreshed = "2026-08-09T10:00:00.123456789Z";
  const delayedLoad = "2026-08-09T10:00:00.123456788Z";
  assert.equal(acceptsWorkspaceRevision(undefined, refreshed), true);
  assert.equal(acceptsWorkspaceRevision(refreshed, delayedLoad), false);
  assert.equal(acceptsWorkspaceRevision(delayedLoad, refreshed), true);

  assert.equal(
    terminalIdentityCollision(
      "workspace-a",
      ["left", "right"],
      { left: { workspaceId: "workspace-a" } },
    ),
    null,
  );
  assert.equal(
    terminalIdentityCollision(
      "workspace-a",
      ["left", "left"],
      {},
    ),
    "left",
  );
  assert.equal(
    terminalIdentityCollision(
      "workspace-a",
      ["left"],
      { left: { workspaceId: "workspace-b" } },
    ),
    "left",
  );

  const current = agentLaunchKey({
    terminalId: "left",
    workspaceId: "workspace-a",
    generation: 12,
    processId: 112,
  });
  assert.notEqual(current, agentLaunchKey({
    terminalId: "left",
    workspaceId: "workspace-a",
    generation: 13,
    processId: 113,
  }));
  assert.notEqual(current, agentLaunchKey({
    terminalId: "left",
    workspaceId: "workspace-b",
    generation: 12,
    processId: 112,
  }));
  assert.match(source("../../src/lib/agentLauncher.ts"), /queuedTerminals\.has\(key\)/);
  assert.match(source("../../src/lib/agentLauncher.ts"), /agentLaunchOwner === "frontend"/);
  assert.match(source("../../src/lib/agentLauncher.ts"), /reportFrontendDiagnostic\("agent-launch-error"/);
  assert.match(source("../../src/lib/agentLauncher.ts"), /Impossibile avviare/);
  assert.match(
    source("../../src/lib/agentLauncher.ts"),
    /operationId: `agent-launch:\$\{key\}`/,
    "a retry must reuse one generation-scoped idempotency key",
  );
  assert.match(terminalManager, /previous_input_operation\(operation_id, data\)/);
  assert.match(terminalManager, /record_input_operation\(operation_id\.to_string\(\), data, Ok\(\(\)\)\)/);
  assert.match(terminalSession, /MAX_INPUT_OPERATIONS: usize = 128/);
  const frame = source("../../src-tauri/src/terminal_engine/frame.rs");
  const control = jarvisControl;
  assert.match(frame, /agent_launch_owner: Option<String>/);
  assert.match(frame, /agent_launch_state: Option<String>/);
  assert.ok(
    control.indexOf('set_backend_agent_launch_state(&terminal_id, &runtime, "starting")') <
      control.indexOf(".append_terminal_and_save(&workspace.id"),
    "backend launch ownership must be durable before the workspace can mount the pane",
  );
  assert.match(
    terminalPane,
    /runtime\.agentLaunchOwner === "backend"[\s\S]*markBackendAgentLaunch/,
  );
});

test("release crash diagnostics are rotating, persistent, and content-free", () => {
  const main = source("../../src-tauri/src/main.rs");
  const diagnostics = source("../../src-tauri/src/diagnostics.rs");
  const frontendDiagnostics = source("../../src/lib/crashDiagnostics.ts");
  assert.match(main, /RollingFileAppender::builder\(\)/);
  assert.match(main, /Rotation::DAILY/);
  assert.match(main, /max_log_files\(7\)/);
  assert.match(main, /install_safe_panic_hook\(\)/);
  assert.match(main, /payload intentionally omitted/);
  assert.match(diagnostics, /There is no[\s\S]*message\/stack field/);
  assert.doesNotMatch(diagnostics, /pub struct FrontendDiagnostic \{[\s\S]*\bmessage:/);
  assert.match(frontendDiagnostics, /window\.addEventListener\("unhandledrejection"/);
  assert.match(terminalPane, /reportFrontendDiagnostic\("terminal-output-resync"/);
});
