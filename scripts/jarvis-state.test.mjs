import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applyRegistrySnapshot } from "../src/lib/jarvis/registryState.ts";
import { isWorkspaceChatLoading, mergeConversationMessages, pendingActionsForWorkspace } from "../src/lib/jarvis/chatState.ts";
import { collapsedJarvisStatus, mergeActivityEvents, stripActivities } from "../src/lib/jarvis/activityState.ts";
import { canSendTranscript, shouldAutoSpeak, shouldStopTtsBeforeRecording, voiceRequestForWorkspace } from "../src/lib/jarvis/voiceState.ts";
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
const chatSource = source("../src-tauri/src/jarvis/chat.rs");
const controlSource = source("../src-tauri/src/jarvis/control.rs");
const commandsSource = source("../src-tauri/src/jarvis/commands.rs");
const voiceCommandsSource = source("../src-tauri/src/jarvis/voice/commands.rs");
const captureSource = source("../src-tauri/src/jarvis/voice/capture.rs");
const storeSource = source("../src/stores/jarvisStore.ts");
const workspaceViewSource = source("../src/components/workspace/WorkspaceView.tsx");

function session(id, terminalId, generation, result = null) {
  const now = "2026-08-07T10:00:00Z";
  return {
    ref: {
      agentSessionId: id,
      provider: "codex",
      resolvedProvider: "codex",
      configuredAgentId: "codex",
      observedProvider: "codex",
      detectionSource: "completion-event",
      detectionConfidence: 1,
      identityWarnings: [],
      identityNeedsConfirmation: false,
      workspaceId: "workspace-a",
      terminalId,
      generation,
      createdAt: now,
      updatedAt: now,
    },
    state: "waiting",
    lastResult: result,
    warnings: [],
    provenance: { source: "test", observedAt: now, confidence: 1, untrusted: false },
  };
}

function idle(overrides = {}) {
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

test("registry refresh preserves canonical live selection and result", () => {
  const result = { content: "done", truncated: false, untrusted: true, provenance: { source: "test", observedAt: "now", confidence: 1, untrusted: false } };
  const current = session("codex-1", "terminal-1", 2, result);
  const state = applyRegistrySnapshot(
    { sessions: [current], selectedSessionId: "codex-1", currentResult: result, currentResultSessionId: "codex-1", currentResultLoading: false, currentError: null },
    [session("codex-1", "terminal-1", 2, result)],
  );
  assert.equal(state.selectedSessionId, "codex-1");
  assert.equal(state.currentResult.content, "done");
});

test("conversation merge is idempotent and preserves workspace ordering", () => {
  const a = { id: "a", role: "user", content: "A", workspaceId: "workspace-a", createdAt: "2026-08-07T00:00:00Z" };
  const b = { id: "b", role: "assistant", content: "B", workspaceId: "workspace-a", createdAt: "2026-08-07T00:00:01Z" };
  assert.deepEqual(mergeConversationMessages([a], [a, b]).map((message) => message.id), ["a", "b"]);
});

test("chat concurrency and legacy Pending Actions remain workspace-scoped", () => {
  const requests = { a: { requestId: "a", workspaceId: "workspace-a", createdAt: "now", status: "running" } };
  assert.equal(isWorkspaceChatLoading(requests, "workspace-a"), true);
  assert.equal(isWorkspaceChatLoading(requests, "workspace-b"), false);
  const action = (workspaceId) => ({ id: workspaceId, status: "pending", invocation: { targetWorkspaceId: workspaceId, requestId: workspaceId } });
  assert.deepEqual(pendingActionsForWorkspace([action("workspace-a"), action("workspace-b")], "workspace-a").map((item) => item.id), ["workspace-a"]);
});

test("voice transcripts can only be submitted inside their origin workspace", () => {
  const request = { requestId: "voice-a", workspaceId: "workspace-a", status: "transcript_ready", transcript: "ciao", createdAt: "now", normalizedLevel: 0 };
  assert.equal(voiceRequestForWorkspace(request, "workspace-b"), null);
  assert.equal(canSendTranscript(request, "workspace-b", "ciao"), false);
  assert.equal(canSendTranscript(request, "workspace-a", "ciao"), true);
});

test("voice helper policies preserve spoken-response and barge-in safety", () => {
  assert.equal(shouldAutoSpeak({ enabled: true, autoSpeak: true, privacyConsent: true, privacyConsentAt: "owner-mode" }), true);
  assert.equal(shouldAutoSpeak({ enabled: true, autoSpeak: false, privacyConsent: true, privacyConsentAt: "owner-mode" }), false);
  assert.equal(shouldStopTtsBeforeRecording("playing"), true);
});

test("owner mode guarantees the one-click automatic voice contract", () => {
  const settings = defaultJarvisSettings();
  assert.equal(isJarvisOwnerModeReady(settings), true);
  assert.equal(settings.voiceInput.activationMode, "click_toggle");
  assert.equal(settings.voiceInput.vadEnabled, true);
  assert.equal(settings.voiceInput.autoSubmitTranscript, true);
  assert.equal(settings.voiceOutput.enabled, true);
  assert.equal(settings.voiceOutput.autoSpeak, true);
  assert.equal(settings.voiceOutput.stopOnUserSpeech, true);
});

test("owner mode upgrades old persisted flags without rewriting model choice", () => {
  const old = defaultJarvisSettings();
  old.textModel.primaryModel = "custom-model";
  old.textModel.privacyConsent = false;
  old.voiceInput.vadEnabled = false;
  old.voiceInput.autoSubmitTranscript = false;
  old.voiceOutput.autoSpeak = false;
  const upgraded = ownerModeJarvisSettings(old);
  assert.equal(upgraded.textModel.primaryModel, "custom-model");
  assert.equal(isJarvisOwnerModeReady(upgraded), true);
});

test("voice utility output is safe and bounded", () => {
  const message = sanitizedVoiceError({ message: "Bearer gsk_test_secret_value" });
  assert.equal(message.includes("gsk_test_secret_value"), false);
  assert.ok(message.length <= 240);
  assert.deepEqual(inputDeviceOptions([{ id: "mic", name: "Desk mic", isDefault: true, available: true }]), [{ id: "mic", label: "Desk mic (predefinito)" }]);
  assert.deepEqual(italianVoices([{ shortName: "it-IT-A", locale: "it-IT" }, { shortName: "en-US-A", locale: "en-US" }]).map((voice) => voice.shortName), ["it-IT-A"]);
});

test("Jarvis pill is voice-first and cannot mount the old transcript/chat drawer", () => {
  assert.match(widgetSource, /VoiceMeter/);
  assert.match(widgetSource, /termino quando fai una pausa/);
  assert.doesNotMatch(widgetSource, /JarvisExpandedPanel|JarvisChatPanel|JarvisTranscriptCard|MessageSquareText|textarea/);
});

test("Jarvis exposes clear audio and visual listening feedback", () => {
  assert.match(widgetSource, /playCue\("start"\)/);
  assert.match(widgetSource, /playCue\("stop"\)/);
  assert.match(widgetSource, /createOscillator/);
  assert.match(widgetSource, /normalizedLevel/);
  assert.match(widgetSource, /jarvis-pill--listening/);
});

test("Jarvis drag activates only after a deliberate long press", () => {
  assert.match(widgetSource, /DRAG_HOLD_MS = 340/);
  assert.match(widgetSource, /activated: false/);
  assert.match(widgetSource, /window\.setTimeout/);
  assert.match(widgetSource, /intent\.activated = true;\s*setDragging\(true\)/s);
  assert.match(widgetSource, /if \(!intent\?\.activated/);
});

test("hold-to-talk fallback still guards lost releases", () => {
  assert.match(widgetSource, /onBlur=\{releaseHeldVoice\}/);
  assert.match(widgetSource, /onPointerCancel=\{handleVoicePointerUp\}/);
  assert.match(widgetSource, /visibilitychange/);
});

test("normal settings expose only useful provider and voice controls", () => {
  assert.match(settingsSource, /OpenCode Zen/);
  assert.match(settingsSource, /Groq/);
  assert.match(settingsSource, /Turn detection automatica/);
  assert.doesNotMatch(settingsSource, /Consenso audio|Consenso testo|Consenso contesto/);
});

test("compatibility activation modes remain implemented without cluttering primary UX", () => {
  assert.match(settingsSource, /click_toggle/);
  assert.match(settingsSource, /hold_to_talk/);
  assert.match(settingsSource, /vad/);
  assert.match(settingsSource, /Hotkey globale/);
});

test("idle and active status hierarchy stays compact and exact", () => {
  assert.equal(collapsedJarvisStatus(idle()), "Ready when you are");
  assert.equal(collapsedJarvisStatus(idle({ voiceRequest: { requestId: "v", workspaceId: "workspace-a", status: "recording", createdAt: "now", normalizedLevel: 0.2 } })), "Listening…");
  assert.equal(collapsedJarvisStatus(idle({ voiceRequest: { requestId: "v", workspaceId: "workspace-a", status: "transcribing", createdAt: "now", normalizedLevel: 0 } })), "Transcribing…");
  assert.equal(collapsedJarvisStatus(idle({ ttsStatus: { status: "playing" } })), "Speaking…");
  assert.doesNotMatch(widgetSource, /registrySessions/);
});

test("activity timeline supersedes stale phases and stays workspace-scoped", () => {
  const preparing = { requestId: "r", workspaceId: "workspace-a", phase: "preparing", label: "Preparing", status: "running", createdAt: "2026-08-07T00:00:00Z", targetSessionId: null };
  const writing = { ...preparing, phase: "writing", label: "Writing", createdAt: "2026-08-07T00:00:01Z" };
  const merged = mergeActivityEvents([preparing], [writing]);
  assert.equal(merged.some((item) => item.phase === "preparing"), false);
  assert.deepEqual(stripActivities(merged, "workspace-a").map((item) => item.phase), ["writing"]);
  assert.equal(stripActivities(merged, "workspace-b").length, 0);
});

test("click-toggle owner mode uses local VAD to close the turn automatically", () => {
  assert.match(voiceCommandsSource, /input\.vad_enabled/);
  assert.match(voiceCommandsSource, /signal\.should_stop/);
  assert.match(voiceCommandsSource, /finish_voice_stop/);
  assert.match(captureSource, /options\.vad_enabled/);
  assert.match(captureSource, /EnergyVad/);
  assert.match(captureSource, /should_auto_stop/);
});

test("voice level events drive the live compact meter", () => {
  assert.match(voiceCommandsSource, /VOICE_LEVEL_EVENT/);
  assert.match(voiceCommandsSource, /normalized_level/);
  assert.match(overlaySource, /jarvis:\/\/voice-level/);
});

test("a successful model reply is automatically spoken", () => {
  assert.match(storeSource, /voiceSettings\.enabled && voiceSettings\.autoSpeak/);
  assert.match(storeSource, /ttsSpeak\(/);
  assert.match(storeSource, /setTtsStatus/);
});

test("automatic transcript submission is request-scoped and retry-safe", () => {
  assert.match(storeSource, /autoSubmittedVoiceRequests/);
  assert.match(storeSource, /sendVoiceTranscript/);
  assert.match(storeSource, /if \(!accepted\) autoSubmittedVoiceRequests\.delete/);
});

test("Phase 8 planner remains semantic, typed and allowlisted", () => {
  assert.match(chatSource, /conversational\.plan/);
  assert.match(chatSource, /execute_plan\(/);
  assert.match(controlSource, /pub enum PlanOperation/);
  assert.match(controlSource, /AgentHandoff/);
  assert.match(controlSource, /DraftPrompt/);
  assert.doesNotMatch(chatSource, /if .*manda.*=>|if .*scrivi.*=>|if .*fai.*=>/i);
});

test("clarification is a hard synchronous boundary", () => {
  assert.match(controlSource, /hard conversational/);
  assert.match(controlSource, /state\.control\.pending\(&invocation\.target_workspace_id\)\.is_some\(\)/);
});

test("every PTY mutation revalidates workspace, generation, process and identity", () => {
  assert.match(controlSource, /fresh_snapshot/);
  assert.match(controlSource, /snapshot\.workspace_id != invocation\.target_workspace_id/);
  assert.match(controlSource, /snapshot\.generation != target\.terminal\.generation/);
  assert.match(controlSource, /process_alive/);
  assert.match(controlSource, /control_allowed/);
  assert.match(commandsSource, /terminal_generation_mismatch/);
});

test("Jarvis registers provenance only after shared-PTY writes", () => {
  assert.match(controlSource, /write_typed\(/);
  assert.match(controlSource, /TerminalInputOrigin::JarvisPrompt/);
  assert.match(controlSource, /observe_jarvis_send/);
  assert.match(registrySource, /observe_jarvis_send/);
});

test("semantic target resolution remains bounded and ambiguity-aware", () => {
  assert.match(controlSource, /terminal\.title/);
  assert.match(controlSource, /session\.current_task/);
  assert.match(controlSource, /session\.last_result/);
  assert.match(controlSource, /read_agent_tail/);
  assert.match(controlSource, /MAX_TAIL_BYTES: usize = 12 \* 1024/);
  assert.match(controlSource, /TargetResolution::Ambiguous/);
});

test("busy and destructive actions remain conversational and stale-safe", () => {
  assert.match(controlSource, /sta ancora lavorando/);
  assert.match(controlSource, /Lo interrompo comunque/);
  assert.match(controlSource, /confirmation_matches/);
  assert.match(controlSource, /generation: Some\(target\.terminal\.generation\)/);
});

test("agent.open creates the same visible Traflix PTY and waits for readiness", () => {
  assert.match(commandsSource, /jarvis_agent_open/);
  assert.match(controlSource, /manager\.spawn\(app\.clone\(\), config\.clone\(\)/);
  assert.match(controlSource, /READINESS_TIMEOUT/);
  assert.match(controlSource, /wait_until_ready/);
  assert.match(workspaceViewSource, /jarvis-agent-opened/);
  assert.match(workspaceViewSource, /markSpawned/);
});

test("no hidden provider session or completion-triggered future chain exists", () => {
  assert.doesNotMatch(controlSource, /codex app-server|opencode serve|spawn.*hidden|detached.*agent|AgentTurnCompleted|completion.*spawn|schedule/i);
  assert.doesNotMatch(chatSource, /codex app-server|opencode serve/);
  assert.match(chatSource, /never starts future work/);
});

test("handoff is bounded to last result or recent terminal evidence", () => {
  assert.match(controlSource, /MAX_HANDOFF_CONTEXT_BYTES: usize = 6 \* 1024/);
  assert.match(controlSource, /source_evidence/);
  assert.match(controlSource, /last_result/);
  assert.match(controlSource, /build_handoff_prompt/);
});

test("desktop UX is flat, compact, accessible and BridgeMind-like", () => {
  assert.doesNotMatch(globalsSource, /radial-gradient|backdrop-filter/);
  assert.match(globalsSource, /--radius-pane: 7px/);
  assert.match(globalsSource, /prefers-reduced-motion/);
  assert.match(globalsSource, /color: var\(--color-neutral-text\)/);
  assert.match(sidebarSource, /New space/);
  assert.doesNotMatch(sidebarSource, /setExpanded/);
  assert.match(rightPanelSource, /PANEL_SLOTS/);
  assert.match(gridSource, /gap: isFocusMode \? 0 : "4px"/);
});

test("normal Jarvis UI contains no diagnostics or transcript editor", () => {
  assert.doesNotMatch(widgetSource, /Diagnostics|Context Broker|JarvisTranscriptCard|JarvisExpandedPanel|conversation\.map|textarea/);
});
