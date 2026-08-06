import assert from "node:assert/strict";
import test from "node:test";
import { applyRegistrySnapshot } from "../src/lib/jarvis/registryState.ts";
import { buildAgentSessionView } from "../src/lib/jarvis/sessionView.ts";

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
