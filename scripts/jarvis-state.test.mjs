import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applyRegistrySnapshot } from "../src/lib/jarvis/registryState.ts";
import {
  isWorkspaceChatLoading,
  MAX_COMPLETED_REQUEST_HISTORY,
  mergeConversationMessages,
  pendingActionsForWorkspace,
  pruneRequestHistory,
} from "../src/lib/jarvis/chatState.ts";
import {
  collapsedJarvisStatus,
  MAX_ACTIVITY_EVENTS,
  MAX_ACTIVITY_STRIP,
  mergeActivityEvents,
  stripActivities,
} from "../src/lib/jarvis/activityState.ts";
import {
  canSendTranscript,
  shouldAutoSpeak,
  shouldStopTtsBeforeRecording,
  voiceRequestForWorkspace,
} from "../src/lib/jarvis/voiceState.ts";
import { inputDeviceOptions, italianVoices, sanitizedVoiceError } from "../src/lib/jarvis/voiceSettings.ts";
import { defaultJarvisSettings, isJarvisOwnerModeReady, ownerModeJarvisSettings } from "../src/lib/jarvis/settings.ts";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const widgetSource = source("../src/components/jarvis/JarvisWidget.tsx");
const settingsSource = source("../src/components/layout/SettingsModal.tsx");
const sidebarSource = source("../src/components/layout/Sidebar.tsx");
const rightPanelSource = source("../src/components/layout/RightPanel.tsx");
const gridSource = source("../src/components/workspace/WorkspaceGrid.tsx");
const globalsSource = source("../src/styles/globals.css");
const overlaySource = source("../src/components/jarvis/JarvisGlobalOverlay.tsx");
const registrySource = source("../src-tauri/src/jarvis/agent_registry.rs");
const chatBackendSource = source("../src-tauri/src/jarvis/chat.rs");
const controlSource = source("../src-tauri/src/jarvis/control.rs");
const commandsSource = source("../src-tauri/src/jarvis/commands.rs");
const voiceCommandsSource = source("../src-tauri/src/jarvis/voice/commands.rs");
const captureSource = source("../src-tauri/src/jarvis/voice/capture.rs");
const storeSource = source("../src/stores/jarvisStore.ts");
const workspaceViewSource = source("../src/components/workspace/WorkspaceView.tsx");

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
    activities: [],
    ...overrides,
  };
}

test("registry refresh preserves selected live generation and result", () => {
  const initial = session({
    id: "codex-1",
    terminalId: "terminal-1",
    generation: 2,
    updatedAt: "2026-08-07T10:00:00Z",
    result: { content: "done", truncated: false, untrusted: true, provenance: { source: "test", observedAt: "now", confidence: 1, untrusted: false } },
  });
  const next = session({ id: "codex-1", terminalId: "terminal-1", generation: 2, updatedAt: "2026-08-07T10:01:00Z", result: initial.lastResult });
  const state = applyRegistrySnapshot(
    { sessions: [initial], selectedSessionId: "codex-1", currentResult: initial.lastResult, currentResultSessionId: "codex-1", currentResultLoading: false, currentError: null },
    [next],
  );
  assert.equal(state.selectedSessionId, "codex-1");
  assert.equal(state.currentResult.content, "done");
});

test("missing sessions are removed only by a successful registry snapshot", () => {
  const initial = session({ id: "pi-1", terminalId: "pi", generation: 1, updatedAt: "2026-08-07T10:00:00Z", provider: "pi" });
  const state = applyRegistrySnapshot(
    { sessions: [initial], selectedSessionId: "pi-1", currentResult: null, currentResultSessionId: "pi-1", currentResultLoading: false, currentError: null },
    [],
  );
  assert.equal(state.selectedSessionId, null);
  assert.equal(state.currentResultSessionId, null);
});

test("conversation reconciliation stays workspace-safe and idempotent", () => {
  const a = { id: "a", role: "user", content: "A", workspaceId: "workspace-a", createdAt: "2026-08-07T00:00:00Z" };
  const reply = { id: "reply", role: "assistant", content: "ok", workspaceId: "workspace-a", createdAt: "2026-08-07T00:00:01Z" };
  const b = { id: "b", role: "user", content: "B", workspaceId: "workspace-b", createdAt: "2026-08-07T00:00:02Z" };
  assert.deepEqual(mergeConversationMessages([a, b], [reply, a]).map((message) => message.id), ["a", "reply", "b"]);
});

test("chat requests may run in different workspaces but not twice in one", () => {
  const requests = {
    a: { requestId: "a", workspaceId: "workspace-a", createdAt: "now", status: "running" },
    b: { requestId: "b", workspaceId: "workspace-b", createdAt: "now", status: "running" },
  };
  assert.equal(isWorkspaceChatLoading(requests, "workspace-a"), true);
  assert.equal(isWorkspaceChatLoading(requests, "workspace-c"), false);
});

test("request history pruning keeps all active requests and remains bounded", () => {
  const requests = {
    active: { requestId: "active", workspaceId: "workspace-a", createdAt: "later", status: "running" },
  };
  for (let index = 0; index < MAX_COMPLETED_REQUEST_HISTORY + 10; index += 1) {
    requests[`done-${index}`] = { requestId: `done-${index}`, workspaceId: "workspace-a", createdAt: `2026-08-07T00:${String(index).padStart(2, "0")}:00Z`, status: "completed" };
  }
  const pruned = pruneRequestHistory(requests);
  assert.equal(pruned.active.status, "running");
  assert.equal(Object.keys(pruned).length, MAX_COMPLETED_REQUEST_HISTORY + 1);
});

test("legacy Pending Actions remain scoped to their workspace", () => {
  const action = (workspaceId) => ({ id: workspaceId, status: "pending", invocation: { targetWorkspaceId: workspaceId, requestId: workspaceId } });
  assert.deepEqual(pendingActionsForWorkspace([action("workspace-a"), action("workspace-b")], "workspace-a").map((item) => item.id), ["workspace-a"]);
});

test("voice transcript is never reusable from another workspace", () => {
  const request = { requestId: "voice-a", workspaceId: "workspace-a", status: "transcript_ready", transcript: "ciao", createdAt: "now", normalizedLevel: 0 };
  assert.equal(voiceRequestForWorkspace(request, "workspace-b"), null);
  assert.equal(canSendTranscript(request, "workspace-b", "ciao"), false);
  assert.equal(canSendTranscript(request, "workspace-a", "ciao"), true);
});

test("TTS helper policy still requires enabled auto speak and internal authorization state", () => {
  assert.equal(shouldAutoSpeak({ enabled: true, autoSpeak: true, privacyConsent: false }), false);
  assert.equal(shouldAutoSpeak({ enabled: true, autoSpeak: true, privacyConsent: true, privacyConsentAt: "owner-mode" }), true);
  assert.equal(shouldStopTtsBeforeRecording("playing"), true);
});

test("owner mode normalizes the complete voice-first contract", () => {
  const owner = defaultJarvisSettings();
  assert.equal(isJarvisOwnerModeReady(owner), true);
  assert.equal(owner.voiceInput.activationMode, "click_toggle");
  assert.equal(owner.voiceInput.vadEnabled, true);
  assert.equal(owner.voiceInput.autoSubmitTranscript, true);
  assert.equal(owner.voiceOutput.autoSpeak, true);
  assert.equal(owner.voiceOutput.stopOnUserSpeech, true);
});

test("owner mode upgrades old persisted settings without changing provider/model choices", () => {
  const old = defaultJarvisSettings();
  old.textModel.primaryModel = "custom-model";
  old.textModel.privacyConsent = false;
  old.voiceInput.vadEnabled = false;
  old.voiceInput.autoSubmitTranscript = false;
  old.voiceOutput.autoSpeak = false;
  const normalized = ownerModeJarvisSettings(old);
  assert.equal(normalized.textModel.primaryModel, "custom-model");
  assert.equal(normalized.textModel.privacyConsent, true);
  assert.equal(normalized.voiceInput.vadEnabled, true);
  assert.equal(normalized.voiceInput.autoSubmitTranscript, true);
  assert.equal(normalized.voiceOutput.autoSpeak, true);
});

test("voice settings preserve input device labeling and Italian TTS filtering", () => {
  assert.deepEqual(inputDeviceOptions([{ id: "mic", name: "Desk mic", isDefault: true, available: true }]), [{ id: "mic", label: "Desk mic (predefinito)" }]);
  assert.deepEqual(italianVoices([{ shortName: "it-IT-A", locale: "it-IT" }, { shortName: "en-US-A", locale: "en-US" }]).map((voice) => voice.shortName), ["it-IT-A"]);
});

test("voice errors sanitize secrets", () => {
  const message = sanitizedVoiceError({ message: "Bearer gsk_test_secret_value" });
  assert.equal(message.includes("gsk_test_secret_value"), false);
  assert.ok(message.length <= 240);
});

test("compact widget is voice-first and never mounts the old chat/transcript drawer", () => {
  assert.match(widgetSource, /VoiceMeter/);
  assert.match(widgetSource, /termino quando fai una pausa/);
  assert.match(widgetSource, /voiceActive/);
  assert.doesNotMatch(widgetSource, /JarvisExpandedPanel|JarvisChatPanel|JarvisTranscriptCard|MessageSquareText/);
});

test("voice widget has explicit start and stop audio cues", () => {
  assert.match(widgetSource, /playCue\("start"\)/);
  assert.match(widgetSource, /playCue\("stop"\)/);
  assert.match(widgetSource, /createOscillator/);
});

test("widget drag is intentionally long-press only", () => {
  assert.match(widgetSource, /DRAG_HOLD_MS = 340/);
  assert.match(widgetSource, /setTimeout/);
  assert.match(widgetSource, /intent\.activated = true/);
  assert.doesNotMatch(widgetSource, /setDragging\(true\);\s*$/m);
});

test("widget keeps robust hold-to-talk release guards for compatibility", () => {
  assert.match(widgetSource, /onBlur=\{releaseHeldVoice\}/);
  assert.match(widgetSource, /onPointerCancel=\{handleVoicePointerUp\}/);
  assert.match(widgetSource, /visibilitychange/);
});

test("normal settings expose provider keys and no privacy-consent toggles", () => {
  assert.match(settingsSource, /OpenCode Zen/);
  assert.match(settingsSource, /Groq/);
  assert.match(settingsSource, /ownerModeJarvisSettings/);
  assert.doesNotMatch(settingsSource, /Consenso audio|Consenso testo|Consenso contesto/);
});

test("settings keep compatibility activation modes but present automatic turn detection", () => {
  assert.match(settingsSource, /click_toggle/);
  assert.match(settingsSource, /hold_to_talk/);
  assert.match(settingsSource, /vad/);
  assert.match(settingsSource, /Turn detection automatica/);
  assert.match(settingsSource, /Hotkey globale/);
});

test("collapsed Jarvis status remains exact and registry-independent", () => {
  assert.equal(collapsedJarvisStatus(idleStatusInput()), "Ready when you are");
  assert.doesNotMatch(widgetSource, /registrySessions/);
});

test("collapsed status prioritizes listening, transcribing, thinking and speaking", () => {
  const base = idleStatusInput();
  assert.equal(collapsedJarvisStatus({ ...base, voiceRequest: { requestId: "v", workspaceId: "workspace-a", status: "recording", createdAt: "now", normalizedLevel: 0.2 } }), "Listening…");
  assert.equal(collapsedJarvisStatus({ ...base, voiceRequest: { requestId: "v", workspaceId: "workspace-a", status: "transcribing", createdAt: "now", normalizedLevel: 0 } }), "Transcribing…");
  assert.equal(collapsedJarvisStatus({ ...base, requests: { r: { requestId: "r", workspaceId: "workspace-a", createdAt: "now", status: "running" } } }), "Thinking…");
  assert.equal(collapsedJarvisStatus({ ...base, ttsStatus: { status: "playing" } }), "Speaking…");
});

test("activity checkpoints supersede stale phases and remain bounded", () => {
  const preparing = checkpoint({ requestId: "req", phase: "preparing", label: "Preparing…", status: "running", createdAt: "2026-08-07T00:00:00Z" });
  const writing = checkpoint({ requestId: "req", phase: "writing", label: "Writing…", status: "running", createdAt: "2026-08-07T00:00:01Z" });
  const merged = mergeActivityEvents([preparing], [writing]);
  assert.equal(merged.some((event) => event.phase === "preparing"), false);
  const many = Array.from({ length: MAX_ACTIVITY_EVENTS + 5 }, (_, index) => checkpoint({ requestId: `r${index}`, phase: "x", label: "x", status: "done", createdAt: `2026-08-07T00:${String(index).padStart(2, "0")}:00Z` }));
  assert.equal(mergeActivityEvents([], many).length, MAX_ACTIVITY_EVENTS);
});

test("activity strip is workspace-scoped and compact", () => {
  const events = [
    checkpoint({ requestId: "a", phase: "x", label: "A", status: "running", createdAt: "2026-08-07T00:00:00Z", workspaceId: "workspace-a" }),
    checkpoint({ requestId: "b", phase: "x", label: "B", status: "running", createdAt: "2026-08-07T00:00:01Z", workspaceId: "workspace-b" }),
  ];
  assert.deepEqual(stripActivities(events, "workspace-a").map((event) => event.label), ["A"]);
  assert.ok(stripActivities(events, "workspace-a").length <= MAX_ACTIVITY_STRIP);
});

test("voice backend enables VAD for click-toggle owner mode and auto-stops on silence", () => {
  assert.match(voiceCommandsSource, /input\.vad_enabled/);
  assert.match(voiceCommandsSource, /signal\.should_stop/);
  assert.match(voiceCommandsSource, /finish_voice_stop/);
  assert.match(captureSource, /options\.vad_enabled/);
  assert.match(captureSource, /EnergyVad/);
  assert.match(captureSource, /should_auto_stop/);
});

test("voice backend emits level updates for the compact meter", () => {
  assert.match(voiceCommandsSource, /VOICE_LEVEL_EVENT/);
  assert.match(voiceCommandsSource, /normalized_level/);
  assert.match(overlaySource, /jarvis:\/\/voice-level/);
});

test("successful Jarvis replies auto-speak through Edge TTS", () => {
  assert.match(storeSource, /voiceSettings\.enabled && voiceSettings\.autoSpeak/);
  assert.match(storeSource, /ttsSpeak\(/);
  assert.match(storeSource, /setTtsStatus/);
});

test("auto-submit is request-scoped and releases its guard on failure", () => {
  assert.match(storeSource, /autoSubmittedVoiceRequests/);
  assert.match(storeSource, /sendVoiceTranscript/);
  assert.match(storeSource, /if \(!accepted\) autoSubmittedVoiceRequests\.delete/);
});

test("Phase 8 uses a typed semantic planner for ordinary explicit commands", () => {
  assert.match(chatBackendSource, /conversational\.plan/);
  assert.match(chatBackendSource, /execute_plan\(/);
  assert.match(controlSource, /pub enum PlanOperation/);
  assert.match(controlSource, /AgentHandoff/);
  assert.match(controlSource, /DraftPrompt/);
  assert.doesNotMatch(chatBackendSource, /if .*manda.*=>|if .*scrivi.*=>|if .*fai.*=>/i);
});

test("clarification is a hard boundary and cannot execute later plan steps", () => {
  assert.match(controlSource, /A clarification\/confirmation is a hard conversational/);
  assert.match(controlSource, /state\.control\.pending\(&invocation\.target_workspace_id\)\.is_some\(\)/);
  assert.match(controlSource, /break;/);
});

test("PTY mutations revalidate current workspace, generation and identity", () => {
  assert.match(controlSource, /fresh_snapshot/);
  assert.match(controlSource, /snapshot\.workspace_id != invocation\.target_workspace_id/);
  assert.match(controlSource, /snapshot\.generation != target\.terminal\.generation/);
  assert.match(controlSource, /control_allowed/);
  assert.match(commandsSource, /terminal_generation_mismatch/);
});

test("Jarvis provenance is registered only after a successful shared-PTY write", () => {
  assert.match(controlSource, /write_typed\(/);
  assert.match(controlSource, /TerminalInputOrigin::JarvisPrompt/);
  assert.match(controlSource, /observe_jarvis_send/);
  assert.match(registrySource, /observe_jarvis_send/);
});

test("target resolution remains semantic and bounded", () => {
  assert.match(controlSource, /terminal\.title/);
  assert.match(controlSource, /session\.current_task/);
  assert.match(controlSource, /session\.last_result/);
  assert.match(controlSource, /read_agent_tail/);
  assert.match(controlSource, /MAX_TAIL_BYTES: usize = 12 \* 1024/);
  assert.match(controlSource, /MAX_TAIL_LINES: usize = 100/);
  assert.match(controlSource, /TargetResolution::Ambiguous/);
});

test("busy and destructive actions remain conversational and generation-bound", () => {
  assert.match(controlSource, /sta ancora lavorando/);
  assert.match(controlSource, /Lo interrompo comunque/);
  assert.match(controlSource, /confirmation_matches/);
  assert.match(controlSource, /generation: Some\(target\.terminal\.generation\)/);
});

test("agent.open uses a visible normal Traflix PTY and bounded readiness", () => {
  assert.match(commandsSource, /jarvis_agent_open/);
  assert.match(controlSource, /manager\.spawn\(app\.clone\(\), config\.clone\(\)/);
  assert.match(controlSource, /READINESS_TIMEOUT/);
  assert.match(controlSource, /wait_until_ready/);
  assert.match(workspaceViewSource, /jarvis-agent-opened/);
  assert.match(workspaceViewSource, /markSpawned/);
});

test("there are no hidden provider sessions or app-server adapters", () => {
  assert.doesNotMatch(controlSource, /codex app-server|opencode serve|spawn.*hidden|detached.*agent/i);
  assert.doesNotMatch(chatBackendSource, /codex app-server|opencode serve/);
});

test("handoff context is bounded and sourced from last result or terminal tail", () => {
  assert.match(controlSource, /MAX_HANDOFF_CONTEXT_BYTES: usize = 6 \* 1024/);
  assert.match(controlSource, /source_evidence/);
  assert.match(controlSource, /last_result/);
  assert.match(controlSource, /build_handoff_prompt/);
});

test("Jarvis remains reactive: no completion-triggered future chain", () => {
  assert.match(chatBackendSource, /never starts future work/);
  assert.doesNotMatch(controlSource, /AgentTurnCompleted|completion.*spawn|schedule/i);
  assert.equal(collapsedJarvisStatus(idleStatusInput()), "Ready when you are");
});

test("desktop shell follows the compact flat BridgeMind-like direction", () => {
  assert.doesNotMatch(globalsSource, /radial-gradient/);
  assert.doesNotMatch(globalsSource, /backdrop-filter/);
  assert.match(globalsSource, /--radius-pane: 7px/);
  assert.match(globalsSource, /prefers-reduced-motion/);
  assert.match(sidebarSource, /New space/);
  assert.doesNotMatch(sidebarSource, /setExpanded/);
  assert.match(rightPanelSource, /PANEL_SLOTS/);
  assert.match(gridSource, /gap: isFocusMode \? 0 : "4px"/);
});

test("normal UI keeps diagnostics and transcript surfaces out of the Jarvis pill", () => {
  assert.doesNotMatch(widgetSource, /Diagnostics|Context Broker|JarvisTranscriptCard|JarvisExpandedPanel/);
  assert.doesNotMatch(widgetSource, /conversation\.map|textarea/);
});
