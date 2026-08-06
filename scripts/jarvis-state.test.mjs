import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyRegistrySnapshot } from "../src/lib/jarvis/registryState.ts";
import { buildAgentSessionView } from "../src/lib/jarvis/sessionView.ts";
import { advancedViewVisible, isWorkspaceChatLoading, mergeConversationMessages, pendingActionsForWorkspace, requestsForWorkspace } from "../src/lib/jarvis/chatState.ts";

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

test("pending actions are scoped to the active conversation workspace", () => {
  const action = (workspaceId) => ({ id: workspaceId, status: "pending", invocation: { targetWorkspaceId: workspaceId, requestId: workspaceId } });
  assert.deepEqual(pendingActionsForWorkspace([action("workspace-a"), action("workspace-b")], "workspace-a").map((item) => item.id), ["workspace-a"]);
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
