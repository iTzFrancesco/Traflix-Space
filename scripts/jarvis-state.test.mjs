import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { applyRegistrySnapshot } from "../src/lib/jarvis/registryState.ts";
import { buildAgentSessionView } from "../src/lib/jarvis/sessionView.ts";
import { advancedViewVisible, isWorkspaceChatLoading, MAX_COMPLETED_REQUEST_HISTORY, mergeConversationMessages, pendingActionsForWorkspace, pruneRequestHistory, requestsForWorkspace } from "../src/lib/jarvis/chatState.ts";
import { canConfirmPendingAction, savePendingActionEdit } from "../src/lib/jarvis/pendingActionState.ts";
import { canSendTranscript, shouldAutoSpeak, shouldStopTtsBeforeRecording, voiceDraftsForWorkspaces, voiceRequestForWorkspace } from "../src/lib/jarvis/voiceState.ts";
import { inputDeviceOptions, italianVoices, sanitizedVoiceError } from "../src/lib/jarvis/voiceSettings.ts";
import { beginVoicePress, releaseVoicePress, shouldStopAfterAsyncStart } from "../src/lib/jarvis/voiceActivation.ts";
import { collapsedJarvisStatus, MAX_ACTIVITY_EVENTS, MAX_ACTIVITY_STRIP, mergeActivityEvents, stripActivities } from "../src/lib/jarvis/activityState.ts";

const chatPanelSource = readFileSync(new URL("../src/components/jarvis/JarvisChatPanel.tsx", import.meta.url), "utf8");
const widgetSource = readFileSync(new URL("../src/components/jarvis/JarvisWidget.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../src/components/layout/SettingsModal.tsx", import.meta.url), "utf8");
const stripSource = readFileSync(new URL("../src/components/jarvis/JarvisActivityStrip.tsx", import.meta.url), "utf8");
const overlaySource = readFileSync(new URL("../src/components/jarvis/JarvisGlobalOverlay.tsx", import.meta.url), "utf8");
const expandedSource = readFileSync(new URL("../src/components/jarvis/JarvisExpandedPanel.tsx", import.meta.url), "utf8");
const registrySource = readFileSync(new URL("../src-tauri/src/jarvis/agent_registry.rs", import.meta.url), "utf8");
const chatBackendSource = readFileSync(new URL("../src-tauri/src/jarvis/chat.rs", import.meta.url), "utf8");
const checkpointsSource = readFileSync(new URL("../src-tauri/src/jarvis/checkpoints.rs", import.meta.url), "utf8");

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

test("voice transcript remains bound to its original workspace", () => {
  const request = { requestId: "voice-a", workspaceId: "workspace-a", status: "transcript_ready", transcript: "ciao", createdAt: "now", normalizedLevel: 0 };
  assert.equal(voiceRequestForWorkspace(request, "workspace-b"), null);
  assert.equal(canSendTranscript(request, "workspace-b", "ciao"), false);
  assert.equal(canSendTranscript(request, "workspace-a", "ciao"), true);
});

test("voice drafts remain separate when switching between workspaces", () => {
  const drafts = {
    a: { requestId: "voice-a", workspaceId: "workspace-a", status: "transcript_ready", transcript: "A", createdAt: "now", normalizedLevel: 0 },
    b: { requestId: "voice-b", workspaceId: "workspace-b", status: "transcript_ready", transcript: "B", createdAt: "later", normalizedLevel: 0 },
  };
  assert.deepEqual(voiceDraftsForWorkspaces(drafts, "workspace-a").map((draft) => draft.transcript), ["A"]);
  assert.deepEqual(voiceDraftsForWorkspaces(drafts, "workspace-b").map((draft) => draft.transcript), ["B"]);
});

test("voice transcript stays manual by default and TTS requires separate consent", () => {
  assert.equal(shouldAutoSpeak({ enabled: true, autoSpeak: true, privacyConsent: false }), false);
  assert.equal(shouldAutoSpeak({ enabled: true, autoSpeak: true, privacyConsent: true, privacyConsentAt: "now" }), true);
  assert.equal(shouldStopTtsBeforeRecording("playing"), true);
  assert.equal(shouldStopTtsBeforeRecording("idle"), false);
});

test("voice settings helpers keep default device and Italian voices only", () => {
  assert.deepEqual(inputDeviceOptions([{ id: "mic", name: "Desk mic", isDefault: true, available: true }]), [{ id: "mic", label: "Desk mic (predefinito)" }]);
  assert.deepEqual(italianVoices([{ shortName: "it-IT-A", locale: "it-IT" }, { shortName: "en-US-A", locale: "en-US" }]).map((voice) => voice.shortName), ["it-IT-A"]);
});

test("voice errors are sanitized and the legacy mute toggle is not presented", () => {
  const message = sanitizedVoiceError({ message: "Bearer gsk_test_secret_value" });
  assert.equal(message.includes("gsk_test_secret_value"), false);
  assert.ok(message.length <= 240);
  assert.doesNotMatch(settingsSource, /Microfono muto/);
  assert.match(settingsSource, /Aggiorna microfoni/);
  assert.match(settingsSource, /Carica voci italiane/);
});

test("voice advanced settings expose activation modes, hotkey and VAD without phase-seven controls", () => {
  assert.match(settingsSource, /click_toggle|Click per avviare/);
  assert.match(settingsSource, /hold_to_talk|Tieni premuto/);
  assert.match(settingsSource, /VAD locale/);
  assert.match(settingsSource, /Hotkey globale/);
  assert.match(settingsSource, /autoSubmitTranscript/);
});

test("chat surface renders the distinct armed and speech states", () => {
  assert.match(chatPanelSource, /status === "armed"/);
  assert.match(chatPanelSource, /Ti ascolto/);
  assert.match(chatPanelSource, /Trascrivo/);
});

test("hold release remains pending until async start completes", () => {
  const press = beginVoicePress(null, 1);
  assert.ok(press);
  assert.equal(beginVoicePress(press, 2), null);
  const released = releaseVoicePress(press);
  assert.ok(released);
  assert.equal(shouldStopAfterAsyncStart(released), true);
  assert.notEqual(released.generation, 2);
});

test("voice lifecycle uses the global request identity and lost-release guards", () => {
  const storeSource = readFileSync(new URL("../src/stores/jarvisStore.ts", import.meta.url), "utf8");
  assert.match(storeSource, /activeVoiceRequestId/);
  assert.match(storeSource, /voiceStopRequested/);
  assert.match(widgetSource, /onBlur=\{releaseHeldVoice\}/);
  assert.match(widgetSource, /onPointerCancel=\{handleVoicePointerUp\}/);
  assert.match(widgetSource, /document\.addEventListener\("visibilitychange"/);
});

test("auto-submit releases its in-flight guard when chat is busy", () => {
  const storeSource = readFileSync(new URL("../src/stores/jarvisStore.ts", import.meta.url), "utf8");
  assert.match(storeSource, /if \(!accepted\) autoSubmittedVoiceRequests\.delete/);
  assert.match(storeSource, /activeVoiceRequestId: state\.activeVoiceRequestId === requestId \? null/);
});

test("VAD and backend event lifecycle are explicit", () => {
  const commandsSource = readFileSync(new URL("../src-tauri/src/jarvis/voice/commands.rs", import.meta.url), "utf8");
  const registrySource = readFileSync(new URL("../src-tauri/src/jarvis/voice/registry.rs", import.meta.url), "utf8");
  const captureSource = readFileSync(new URL("../src-tauri/src/jarvis/voice/capture.rs", import.meta.url), "utf8");
  assert.match(commandsSource, /status_changed/);
  assert.match(commandsSource, /emit_voice_state\(app, &transcribing\)/);
  assert.match(registrySource, /pub struct VoiceSignal/);
  assert.match(captureSource, /fn failure\(&self\)/);
});

// ---- Phase 7: agent session intelligence ----------------------------------

function checkpoint({ requestId, phase, label, status, createdAt, workspaceId = "workspace-a", targetSessionId = null }) {
  return { requestId, phase, label, status, createdAt, workspaceId, targetSessionId };
}

function idleStatusInput(overrides = {}) {
  return {
    workspaceId: "workspace-a",
    workspaceName: "Test",
    voiceError: null,
    voiceRequest: null,
    ttsStatus: { status: "idle" },
    requests: {},
    pendingActions: [],
    registrySessions: [],
    ...overrides,
  };
}

function registrySession(overrides = {}) {
  return {
    ref: {
      agentSessionId: "codex-1",
      provider: "codex",
      resolvedProvider: "codex",
      workspaceId: "workspace-a",
      terminalId: "t-1",
      generation: 1,
      createdAt: "now",
      updatedAt: "now",
    },
    state: "waiting",
    ...overrides,
  };
}

test("collapsed widget is Ready when idle and never shows agent names or counts", () => {
  assert.equal(collapsedJarvisStatus(idleStatusInput()), "Pronto quando vuoi");
  const working = collapsedJarvisStatus(idleStatusInput({ registrySessions: [registrySession({ state: "working" }), registrySession({ state: "starting", ref: { ...registrySession().ref, agentSessionId: "pi-1", provider: "pi", resolvedProvider: "pi" } })] }));
  assert.equal(working, "L'agente sta lavorando…");
  assert.doesNotMatch(working, /codex|Codex|pi|count|agenti/i);
});

test("collapsed priority is voice, then agent, then pending, then thinking, then TTS", () => {
  const base = idleStatusInput();
  assert.equal(collapsedJarvisStatus({ ...base, voiceRequest: { requestId: "v", workspaceId: "workspace-a", status: "recording", createdAt: "now", normalizedLevel: 0 } }), "Ti ascolto…");
  assert.equal(collapsedJarvisStatus({ ...base, pendingActions: [{ id: "a", status: "pending", invocation: { targetWorkspaceId: "workspace-a" } }] }), "Conferma richiesta");
  assert.equal(collapsedJarvisStatus({ ...base, requests: { r: { requestId: "r", workspaceId: "workspace-a", createdAt: "now", status: "running" } } }), "Jarvis sta pensando…");
  assert.equal(collapsedJarvisStatus({ ...base, ttsStatus: { status: "playing" } }), "Sto parlando…");
  assert.equal(collapsedJarvisStatus({ ...base, voiceError: "errore" }), "Errore voce");
  assert.equal(collapsedJarvisStatus({ ...base, workspaceId: null, workspaceName: null }), "Seleziona una workspace");
});

test("agent pending state wins over thinking while a confirmation is requested", () => {
  const input = idleStatusInput({
    pendingActions: [{ id: "a", status: "pending", invocation: { targetWorkspaceId: "workspace-a" } }],
    requests: { r: { requestId: "r", workspaceId: "workspace-a", createdAt: "now", status: "running" } },
  });
  assert.equal(collapsedJarvisStatus(input), "Conferma richiesta");
});

test("checkpoints merge deduplicates by request, phase and target and stay bounded", () => {
  const running = checkpoint({ requestId: "req-1", phase: "writing", label: "Writing to Codex…", status: "running", createdAt: "2026-08-07T00:00:00Z" });
  const done = checkpoint({ requestId: "req-1", phase: "writing", label: "Sent.", status: "done", createdAt: "2026-08-07T00:00:01Z" });
  const merged = mergeActivityEvents([running], [done, running]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, "done");
  assert.equal(merged[0].label, "Sent.");
});

test("checkpoint view is bounded and only open events are visible in the strip", () => {
  const events = [];
  for (let index = 0; index < MAX_ACTIVITY_EVENTS + 8; index += 1) {
    events.push(checkpoint({ requestId: `req-${index}`, phase: "writing", label: `L${index}`, status: index % 2 ? "done" : "running", createdAt: `2026-08-07T00:${String(index).padStart(2, "0")}:00Z` }));
  }
  const merged = mergeActivityEvents([], events);
  assert.equal(merged.length, MAX_ACTIVITY_EVENTS);
  const strip = stripActivities(merged, "workspace-a");
  assert.ok(strip.length <= MAX_ACTIVITY_STRIP);
  assert.ok(strip.every((event) => event.status === "running" || event.status === "waiting_confirmation"));
});

test("activity strip is isolated per workspace and never a conversation message", () => {
  const events = [
    checkpoint({ requestId: "req-a", phase: "writing", label: "A", status: "running", createdAt: "2026-08-07T00:00:00Z", workspaceId: "workspace-a" }),
    checkpoint({ requestId: "req-b", phase: "writing", label: "B", status: "running", createdAt: "2026-08-07T00:00:01Z", workspaceId: "workspace-b" }),
  ];
  assert.deepEqual(stripActivities(events, "workspace-a").map((event) => event.label), ["A"]);
  assert.deepEqual(stripActivities(events, "workspace-b").map((event) => event.label), ["B"]);
  assert.equal(stripActivities(events, null).length, 0);
  // The strip is a separate ephemeral element, not a conversation message.
  assert.match(stripSource, /JarvisActivityStrip/);
  assert.doesNotMatch(stripSource, /role === "user"|role === "assistant"/);
  assert.match(chatPanelSource, /JarvisActivityStrip/);
});

test("checkpoints are backend-deterministic and labels never leak terminal identity", () => {
  assert.match(checkpointsSource, /jarvis:\/\/activity/);
  assert.match(checkpointsSource, /pub fn emit_checkpoint/);
  assert.doesNotMatch(checkpointsSource, /terminal_id/);
  assert.match(chatBackendSource, /emit_checkpoint\(/);
  assert.doesNotMatch(chatBackendSource, /format!\("Writing to \{terminal/);
  assert.match(overlaySource, /listen<ActivityCheckpoint>\("jarvis:\/\/activity"/);
});

test("jarvis provenance is registered only after a successful PTY write", () => {
  assert.match(chatBackendSource, /observe_jarvis_send\(&snapshot, text, &now\(\)\)/);
  assert.match(chatBackendSource, /if written\.is_ok\(\)/);
  assert.match(chatBackendSource, /write_typed\(/);
  assert.match(chatBackendSource, /TerminalInputOrigin::JarvisPrompt/);
  assert.match(chatBackendSource, /TerminalInputOrigin::JarvisAbort/);
  assert.match(registrySource, /observe_abort/);
  assert.match(registrySource, /never mark the task completed/);
});

test("agent.activity tool is read-only and bounded, never an app-server adapter", () => {
  assert.match(chatBackendSource, /read_tool\("agent\.activity"/);
  assert.match(chatBackendSource, /MAX_ACTIVITY_LIMIT/);
  assert.match(chatBackendSource, /DEFAULT_ACTIVITY_LIMIT/);
  assert.doesNotMatch(chatBackendSource, /codex app-server|opencode serve|provider adapter/);
  const commandsSource = readFileSync(new URL("../src-tauri/src/jarvis/commands.rs", import.meta.url), "utf8");
  assert.match(commandsSource, /jarvis_agent_activity/);
  const clientSource = readFileSync(new URL("../src/lib/jarvis/client.ts", import.meta.url), "utf8");
  assert.match(clientSource, /function agentActivity\(/);
  const typesSource = readFileSync(new URL("../src/lib/jarvis/types.ts", import.meta.url), "utf8");
  assert.match(typesSource, /AgentActivityEvent/);
  assert.match(typesSource, /currentTask/);
  assert.match(typesSource, /lastActivityAt/);
});

test("no hidden provider sessions exist: Jarvis only writes into the shared PTY", () => {
  assert.doesNotMatch(chatBackendSource, /codex app-server|opencode serve/);
  assert.doesNotMatch(chatBackendSource, /spawn.*hidden|detached.*agent/i);
  assert.doesNotMatch(widgetSource, /registrySessions\.filter/);
});

test("task text and timeline bounds are enforced in the registry", () => {
  assert.match(registrySource, /MAX_TASK_TEXT_BYTES: usize = 2048/);
  assert.match(registrySource, /MAX_ACTIVITY_TIMELINE: usize = 32/);
  assert.match(registrySource, /MAX_ACTIVITY_LIMIT: usize = 16/);
  assert.match(registrySource, /DEFAULT_ACTIVITY_LIMIT: usize = 8/);
});

test("expanded panel shows the strip without converting it into chat messages", () => {
  assert.match(expandedSource, /activities: ActivityCheckpoint\[\]/);
  assert.doesNotMatch(expandedSource, /activity.*role.*user/);
});
