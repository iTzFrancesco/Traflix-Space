import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyRegistrySnapshot } from "../src/lib/jarvis/registryState.ts";
import { buildAgentSessionView } from "../src/lib/jarvis/sessionView.ts";
import { advancedViewVisible, isWorkspaceChatLoading, MAX_COMPLETED_REQUEST_HISTORY, mergeConversationMessages, pendingActionsForWorkspace, pruneRequestHistory, requestsForWorkspace } from "../src/lib/jarvis/chatState.ts";
import { canConfirmPendingAction, savePendingActionEdit } from "../src/lib/jarvis/pendingActionState.ts";

const chatPanelSource = readFileSync(new URL("../src/components/jarvis/JarvisChatPanel.tsx", import.meta.url), "utf8");
const widgetSource = readFileSync(new URL("../src/components/jarvis/JarvisWidget.tsx", import.meta.url), "utf8");

function session({ id, terminalId, generation, state = "waiting", updatedAt, provider = "codex", result = null }) {
  return {
    ref: {
      agentSessionId: id,
      provider,
      resolvedProvider: provider,
      configuredAgentId: provider,
      observedProvider: provider,
      detectionSource: "completion-event",
      detectionConfidence: 1,
      identityWarnings: [],
      identityNeedsConfirmation: false,
      workspaceId: "workspace-a",
      terminalId,
      generation,
      createdAt: updatedAt,
      updatedAt,
    },
    state,
    lastResult: result,
    warnings: [],
    provenance: { source: "test", observedAt: updatedAt, confidence: 1, untrusted: false },
  };
}

test("refresh preserves selection and last result while replacing only registry data", () => {
  const initial = session({ id: "codex-1", terminalId: "t-codex", generation: 1, updatedAt: "2026-08-06T10:00:00Z", result: { content: "stable", truncated: false, untrusted: true, provenance: { source: "test", observedAt: "now", confidence: 1, untrusted: false } } });
  const next = session({ id: "codex-1", terminalId: "t-codex", generation: 1, updatedAt: "2026-08-06T10:01:00Z", result: initial.lastResult });
  const state = applyRegistrySnapshot({ sessions: [initial], selectedSessionId: "codex-1", currentResult: initial.lastResult, currentResultSessionId: "codex-1", currentResultLoading: true, currentError: null }, [next]);
  assert.equal(state.selectedSessionId, "codex-1");
  assert.equal(state.currentResult.content, "stable");
  assert.equal(state.currentResultLoading, true);
});

test("a missing session is removed only after a successful registry snapshot", () => {
  const initial = session({ id: "pi-1", terminalId: "t-pi", generation: 2, updatedAt: "2026-08-06T10:00:00Z" });
  const state = applyRegistrySnapshot({ sessions: [initial], selectedSessionId: "pi-1", currentResult: null, currentResultSessionId: "pi-1", currentResultLoading: false, currentError: null }, []);
  assert.equal(state.selectedSessionId, null);
  assert.equal(state.currentResultSessionId, null);
});

test("old exited generations are grouped under History and providers remain distinct", () => {
  const sessions = [
    session({ id: "codex-old", terminalId: "shared-terminal", generation: 1, state: "exited", updatedAt: "2026-08-01T10:00:00Z", provider: "codex" }),
    session({ id: "codex-live", terminalId: "shared-terminal", generation: 2, state: "working", updatedAt: "2026-08-06T10:00:00Z", provider: "codex" }),
    session({ id: "pi-live", terminalId: "pi-terminal", generation: 1, state: "waiting", updatedAt: "2026-08-06T10:00:00Z", provider: "pi" }),
  ];
  const view = buildAgentSessionView(sessions, Date.parse("2026-08-06T10:01:00Z"));
  assert.deepEqual(view.visible.map((item) => item.ref.resolvedProvider), ["codex", "pi"]);
  assert.equal(view.history[0].sessions[0].ref.agentSessionId, "codex-old");
});

test("conversation reconciliation keeps completed workspace A after switching to B", () => {
  const a = { id: "a", role: "user", content: "A", workspaceId: "workspace-a", createdAt: "2026-08-07T00:00:00Z" };
  const responseA = { id: "a-response", role: "assistant", content: "risposta A", workspaceId: "workspace-a", createdAt: "2026-08-07T00:00:01Z" };
  const b = { id: "b", role: "user", content: "B", workspaceId: "workspace-b", createdAt: "2026-08-07T00:00:02Z" };
  const merged = mergeConversationMessages([a, b], [responseA, a]);
  assert.deepEqual(merged.map((message) => message.id), ["a", "a-response", "b"]);
  assert.equal(merged.filter((message) => message.workspaceId === "workspace-a").length, 2);
});

test("requests can run concurrently in different workspaces but not twice in one", () => {
  const requests = {
    a: { requestId: "a", workspaceId: "workspace-a", createdAt: "now", status: "running" },
    b: { requestId: "b", workspaceId: "workspace-b", createdAt: "now", status: "running" },
  };
  assert.equal(requestsForWorkspace(requests, "workspace-a").length, 1);
  assert.equal(requestsForWorkspace(requests, "workspace-b").length, 1);
  assert.equal(isWorkspaceChatLoading(requests, "workspace-a"), true);
  assert.equal(isWorkspaceChatLoading(requests, "workspace-c"), false);
});

test("request pruning keeps every active request and only recent completed history", () => {
  const requests = {
    activeA: { requestId: "activeA", workspaceId: "workspace-a", createdAt: "2026-08-07T02:00:00Z", status: "running" },
    activeB: { requestId: "activeB", workspaceId: "workspace-b", createdAt: "2026-08-07T02:01:00Z", status: "cancellation_requested" },
  };
  for (let index = 0; index < MAX_COMPLETED_REQUEST_HISTORY + 12; index += 1) {
    requests[`done-${index}`] = { requestId: `done-${index}`, workspaceId: "workspace-a", createdAt: `2026-08-07T00:${String(index).padStart(2, "0")}:00Z`, status: "completed" };
  }
  const pruned = pruneRequestHistory(requests);
  assert.equal(Object.keys(pruned).length, MAX_COMPLETED_REQUEST_HISTORY + 2);
  assert.equal(pruned.activeA.status, "running");
  assert.equal(pruned.activeB.status, "cancellation_requested");
  assert.equal(pruned["done-0"], undefined);
  assert.ok(pruned[`done-${MAX_COMPLETED_REQUEST_HISTORY + 11}`]);
});

test("pending actions are scoped to the active conversation workspace", () => {
  const action = (workspaceId) => ({ id: workspaceId, status: "pending", invocation: { targetWorkspaceId: workspaceId, requestId: workspaceId } });
  assert.deepEqual(pendingActionsForWorkspace([action("workspace-a"), action("workspace-b")], "workspace-a").map((item) => item.id), ["workspace-a"]);
});

test("pending action edit must save before confirm and confirms the returned payload", async () => {
  const action = { id: "action-1", operation: "agent.send", status: "pending", preview: "old", editableText: "old" };
  const editing = { action, editing: true, saving: false };
  assert.equal(canConfirmPendingAction(editing), false);
  assert.equal(canConfirmPendingAction({ ...editing, saving: true }), false);
  const saved = await savePendingActionEdit(editing, "new prompt", async (current, text) => ({ ...current, preview: text, editableText: text }));
  assert.equal(saved.editing, false);
  assert.equal(saved.saving, false);
  assert.equal(canConfirmPendingAction(saved), true);
  let confirmedPayload = null;
  if (canConfirmPendingAction(saved)) confirmedPayload = saved.action.editableText;
  assert.equal(confirmedPayload, "new prompt");
  assert.notEqual(confirmedPayload, action.editableText);
});

test("advanced diagnostics are visible only from Settings when enabled", () => {
  assert.equal(advancedViewVisible(false, true), false);
  assert.equal(advancedViewVisible(true, false), false);
  assert.equal(advancedViewVisible(true, true), true);
});

test("normal chat surface does not expose the phase-three dashboard or expand arrow", () => {
  assert.doesNotMatch(chatPanelSource, /Agents|Diagnostics|Context Broker|Advanced View/);
  assert.doesNotMatch(widgetSource, /Chevron|Advanced View/);
});

test("timeline reconciliation is idempotent and does not duplicate the optimistic user message", () => {
  const message = { id: "stable", role: "user", content: "test", workspaceId: "workspace-a", createdAt: "2026-08-07T00:00:00Z" };
  assert.equal(mergeConversationMessages([message], [message]).length, 1);
});
