import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applyRegistrySnapshot } from "../src/lib/jarvis/registryState.ts";
import {
  isWorkspaceChatLoading,
  mergeConversationMessages,
  pendingActionsForWorkspace,
} from "../src/lib/jarvis/chatState.ts";
import {
  collapsedJarvisStatus,
  mergeActivityEvents,
  stripActivities,
} from "../src/lib/jarvis/activityState.ts";
import {
  canSendTranscript,
  shouldAutoSpeak,
  shouldStopTtsBeforeRecording,
  voiceRequestForWorkspace,
} from "../src/lib/jarvis/voiceState.ts";
import {
  inputDeviceOptions,
  italianVoices,
  sanitizedVoiceError,
  sanitizedVoiceErrorView,
} from "../src/lib/jarvis/voiceSettings.ts";
import {
  applyTtsStatusTransition,
  beginLocalTtsRequest,
} from "../src/lib/jarvis/ttsState.ts";
import { chimeNeedsVisualFallback } from "../src/lib/agentNotificationSound.ts";
import {
  defaultJarvisSettings,
  isJarvisOwnerModeReady,
  ownerModeJarvisSettings,
} from "../src/lib/jarvis/settings.ts";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

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
    provenance: {
      source: "test",
      observedAt: now,
      confidence: 1,
      untrusted: false,
    },
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
  const result = {
    content: "done",
    truncated: false,
    untrusted: true,
    provenance: {
      source: "test",
      observedAt: "now",
      confidence: 1,
      untrusted: false,
    },
  };
  const current = session("codex-1", "terminal-1", 2, result);
  const state = applyRegistrySnapshot(
    {
      sessions: [current],
      selectedSessionId: "codex-1",
      currentResult: result,
      currentResultSessionId: "codex-1",
      currentResultLoading: false,
      currentError: null,
    },
    [session("codex-1", "terminal-1", 2, result)],
  );
  assert.equal(state.selectedSessionId, "codex-1");
  assert.equal(state.currentResult.content, "done");
});

test("conversation and legacy pending state stay workspace-scoped", () => {
  const a = {
    id: "a",
    role: "user",
    content: "A",
    workspaceId: "workspace-a",
    createdAt: "2026-08-07T00:00:00Z",
  };
  const b = {
    id: "b",
    role: "assistant",
    content: "B",
    workspaceId: "workspace-a",
    createdAt: "2026-08-07T00:00:01Z",
  };
  assert.deepEqual(
    mergeConversationMessages([a], [a, b]).map((message) => message.id),
    ["a", "b"],
  );

  const requests = {
    a: {
      requestId: "a",
      workspaceId: "workspace-a",
      createdAt: "now",
      status: "running",
    },
  };
  assert.equal(isWorkspaceChatLoading(requests, "workspace-a"), true);
  assert.equal(isWorkspaceChatLoading(requests, "workspace-b"), false);

  const action = (workspaceId) => ({
    id: workspaceId,
    status: "pending",
    invocation: { targetWorkspaceId: workspaceId, requestId: workspaceId },
  });
  assert.deepEqual(
    pendingActionsForWorkspace(
      [action("workspace-a"), action("workspace-b")],
      "workspace-a",
    ).map((item) => item.id),
    ["workspace-a"],
  );
});

test("voice transcript cannot escape its origin workspace", () => {
  const request = {
    requestId: "voice-a",
    workspaceId: "workspace-a",
    status: "transcript_ready",
    transcript: "ciao",
    createdAt: "now",
    normalizedLevel: 0,
  };
  assert.equal(voiceRequestForWorkspace(request, "workspace-b"), null);
  assert.equal(canSendTranscript(request, "workspace-b", "ciao"), false);
  assert.equal(canSendTranscript(request, "workspace-a", "ciao"), true);
});

test("owner mode defaults to hands-free VAD with automatic submit and speech", () => {
  const settings = defaultJarvisSettings();
  assert.equal(isJarvisOwnerModeReady(settings), true);
  assert.equal(settings.voiceInput.activationMode, "vad");
  assert.equal(settings.voiceInput.vadEnabled, true);
  assert.ok(settings.voiceInput.maxArmedSeconds >= 120);
  assert.equal(settings.voiceInput.autoSubmitTranscript, true);
  assert.equal(settings.voiceOutput.enabled, true);
  assert.equal(settings.voiceOutput.autoSpeak, true);
  assert.equal(settings.voiceOutput.stopOnUserSpeech, true);
  assert.equal(shouldAutoSpeak(settings.voiceOutput), true);
  assert.equal(shouldStopTtsBeforeRecording("playing"), true);
});

test("owner mode upgrades old automatic modes without rewriting model choice or hold-to-talk", () => {
  const old = defaultJarvisSettings();
  old.textModel.primaryModel = "custom-model";
  old.textModel.privacyConsent = false;
  old.voiceInput.activationMode = "click_toggle";
  old.voiceInput.vadEnabled = false;
  old.voiceInput.autoSubmitTranscript = false;
  old.voiceOutput.autoSpeak = false;
  const upgraded = ownerModeJarvisSettings(old);
  assert.equal(upgraded.textModel.primaryModel, "custom-model");
  assert.equal(upgraded.voiceInput.activationMode, "vad");
  assert.equal(isJarvisOwnerModeReady(upgraded), true);

  const hold = defaultJarvisSettings();
  hold.voiceInput.activationMode = "hold_to_talk";
  assert.equal(
    ownerModeJarvisSettings(hold).voiceInput.activationMode,
    "hold_to_talk",
  );
});

test("voice utility output is safe and bounded", () => {
  const message = sanitizedVoiceError({
    message: "Bearer gsk_test_secret_value",
  });
  assert.equal(message.includes("gsk_test_secret_value"), false);
  assert.ok(message.length <= 240);
  assert.deepEqual(
    sanitizedVoiceErrorView(
      { code: "tts_output_device_unavailable", message: "Speaker assente" },
      "tts_ipc_failed",
    ),
    { code: "tts_output_device_unavailable", message: "Speaker assente" },
  );
  assert.deepEqual(
    inputDeviceOptions([
      { id: "mic", name: "Desk mic", isDefault: true, available: true },
    ]),
    [{ id: "mic", label: "Desk mic (predefinito)" }],
  );
  assert.deepEqual(
    italianVoices([
      { shortName: "it-IT-A", locale: "it-IT" },
      { shortName: "en-US-A", locale: "en-US" },
    ]).map((voice) => voice.shortName),
    ["it-IT-A"],
  );
});

test("TTS state is monotonic and an older request cannot replace a local successor", () => {
  const initial = {
    ttsStatus: {
      requestId: "tts-a",
      workspaceId: "workspace-a",
      sequence: 4,
      status: "playing",
    },
    pendingTtsRequestId: null,
  };
  const pendingB = beginLocalTtsRequest(initial, "tts-b", "workspace-b");
  const staleA = applyTtsStatusTransition(pendingB, {
    requestId: "tts-a",
    workspaceId: "workspace-a",
    sequence: 5,
    status: "idle",
  });
  assert.equal(staleA.accepted, false);
  assert.equal(staleA.ttsStatus.requestId, "tts-b");

  const synthesizingB = applyTtsStatusTransition(pendingB, {
    requestId: "tts-b",
    workspaceId: "workspace-b",
    sequence: 6,
    status: "synthesizing",
  });
  assert.equal(synthesizingB.accepted, true);
  assert.equal(synthesizingB.pendingTtsRequestId, null);
  const outOfOrderB = applyTtsStatusTransition(synthesizingB, {
    requestId: "tts-b",
    workspaceId: "workspace-b",
    sequence: 5,
    status: "playing",
  });
  assert.equal(outOfOrderB.accepted, false);
  assert.equal(outOfOrderB.ttsStatus.status, "synthesizing");
});

test("completion chime failures require a visual notification fallback", () => {
  assert.equal(chimeNeedsVisualFallback({ status: "scheduled" }), false);
  assert.equal(chimeNeedsVisualFallback({ status: "throttled" }), false);
  assert.equal(chimeNeedsVisualFallback({ status: "resume_failed" }), true);
  assert.equal(chimeNeedsVisualFallback({ status: "unsupported" }), true);
  const chimeSource = source("../src/lib/agentNotificationSound.ts");
  assert.ok(
    chimeSource.indexOf("scheduleChime(context)") <
      chimeSource.indexOf("lastPlayedAt = performance.now()"),
    "only a successfully scheduled chime may start the throttle window",
  );
  assert.match(
    chimeSource,
    /lastPlayedAt > 0 && now - lastPlayedAt < 180/,
    "the first completion must not be throttled before any chime was scheduled",
  );
  assert.match(chimeSource, /remainingNotes === 0\) master\.disconnect\(\)/);
});

test("idle and active status hierarchy stays compact", () => {
  assert.equal(collapsedJarvisStatus(idle()), "Pronto quando vuoi");
  assert.equal(
    collapsedJarvisStatus(idle({ voiceError: "Nessun dispositivo audio disponibile." })),
    "Nessun dispositivo audio disponibile.",
  );
  assert.equal(
    collapsedJarvisStatus(
      idle({
        voiceRequest: {
          requestId: "v",
          workspaceId: "workspace-a",
          status: "recording",
          createdAt: "now",
          normalizedLevel: 0.2,
        },
      }),
    ),
    "In ascolto…",
  );
  assert.equal(
    collapsedJarvisStatus(
      idle({
        voiceRequest: {
          requestId: "v",
          workspaceId: "workspace-a",
          status: "transcribing",
          createdAt: "now",
          normalizedLevel: 0,
        },
      }),
    ),
    "Trascrivo…",
  );
  assert.equal(
    collapsedJarvisStatus(idle({ ttsStatus: { status: "playing" } })),
    "Sto parlando…",
  );
});

test("activity timeline supersedes stale phases and stays workspace-scoped", () => {
  const preparing = {
    requestId: "r",
    workspaceId: "workspace-a",
    phase: "preparing",
    label: "Preparing",
    status: "running",
    createdAt: "2026-08-07T00:00:00Z",
    targetSessionId: null,
  };
  const writing = {
    ...preparing,
    phase: "writing",
    label: "Writing",
    createdAt: "2026-08-07T00:00:01Z",
  };
  const merged = mergeActivityEvents([preparing], [writing]);
  assert.equal(merged.some((item) => item.phase === "preparing"), false);
  assert.deepEqual(
    stripActivities(merged, "workspace-a").map((item) => item.phase),
    ["writing"],
  );
  assert.equal(stripActivities(merged, "workspace-b").length, 0);
});

test("VAD capture closes speech turns automatically and re-arms hands-free", () => {
  assert.match(voiceCommandsSource, /signal\.should_stop/);
  assert.match(voiceCommandsSource, /finish_voice_stop/);
  assert.match(captureSource, /options\.vad_enabled/);
  assert.match(captureSource, /EnergyVad/);
  assert.match(captureSource, /should_auto_stop/);
  assert.match(overlaySource, /AUTO_ARM_DELAY_MS/);
  assert.match(overlaySource, /activeVoiceRequestId/);
  assert.match(overlaySource, /store\.startVoice\(\)/);
});

test("successful model replies are spoken and transcripts auto-submit", () => {
  assert.match(
    storeSource,
    /voiceSettings\.enabled && voiceSettings\.autoSpeak/,
  );
  assert.match(storeSource, /ttsSpeak\(/);
  assert.match(storeSource, /autoSubmittedVoiceRequests/);
  assert.match(storeSource, /sendVoiceTranscript/);
  assert.match(
    storeSource,
    /if \(!accepted\)[\s\S]*autoSubmittedVoiceRequests\.delete/,
  );
});

test("voice failures are observable at every async boundary and rejected drafts can retry", () => {
  assert.match(storeSource, /function voiceLog\(/);
  assert.match(storeSource, /function voiceWarn\(/);
  assert.match(storeSource, /voiceWarn\("start failed"/);
  assert.match(storeSource, /voiceWarn\("stop failed"/);
  assert.match(storeSource, /voiceLog\("transcript submission started"/);
  assert.match(storeSource, /voiceWarn\("transcript submission rejected/);
  assert.match(storeSource, /autoSubmittedVoiceRequests\.delete\(voiceRequest\.requestId\)/);
  assert.match(storeSource, /acceptedVoiceRequestIds/);
  assert.match(storeSource, /ACCEPTED_VOICE_REQUESTS_STORAGE_KEY/);
  assert.match(storeSource, /accepted transcript draft found during reload/);
  assert.match(overlaySource, /\[Jarvis voice\] frontend state event/);
  assert.match(voiceCommandsSource, /active_voice_stops/);
  assert.match(voiceCommandsSource, /Duplicate voice stop ignored by single-flight guard/);
  assert.match(voiceCommandsSource, /Voice stop pipeline entered/);
  assert.match(voiceCommandsSource, /Voice STT request started/);
  assert.match(voiceCommandsSource, /Voice STT request completed/);
  assert.match(voiceCommandsSource, /Voice STT request failed/);
});

test("Phase 8 planner remains semantic, typed and allowlisted", () => {
  assert.match(chatSource, /conversational\.plan/);
  assert.match(chatSource, /execute_plan\(/);
  assert.match(controlSource, /pub enum PlanOperation/);
  assert.match(controlSource, /AgentHandoff/);
  assert.match(controlSource, /DraftPrompt/);
  assert.doesNotMatch(
    chatSource,
    /if .*manda.*=>|if .*scrivi.*=>|if .*fai.*=>/i,
  );
});

test("clarification remains a hard synchronous boundary", () => {
  assert.match(controlSource, /hard conversational/);
  assert.match(
    controlSource,
    /\.control\s*\.pending\(&invocation\.target_workspace_id\)\s*\.is_some\(\)/s,
  );
});

test("every PTY mutation revalidates workspace, generation, process and identity", () => {
  assert.match(controlSource, /fresh_snapshot/);
  assert.match(
    controlSource,
    /snapshot\.workspace_id != invocation\.target_workspace_id/,
  );
  assert.match(
    controlSource,
    /snapshot\.generation != target\.terminal\.generation/,
  );
  assert.match(controlSource, /process_alive/);
  assert.match(controlSource, /control_allowed/);
  assert.match(commandsSource, /terminal_generation_mismatch/);
});

test("Jarvis registers provenance only after shared-PTY writes", () => {
  assert.match(controlSource, /write_typed_for_generation\(/);
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
  assert.match(
    controlSource,
    /generation: Some\(target\.terminal\.generation\)/,
  );
});

test("agent.open creates the same visible Traflix PTY and waits for readiness", () => {
  assert.match(commandsSource, /jarvis_agent_open/);
  assert.match(
    controlSource,
    /manager\s*\.spawn\(\s*app\.clone\(\),\s*config\.clone\(\),/s,
  );
  assert.match(controlSource, /READINESS_TIMEOUT/);
  assert.match(controlSource, /wait_until_ready/);
  assert.match(workspaceViewSource, /jarvis-agent-opened/);
  assert.match(workspaceViewSource, /markSpawned/);
  assert.match(workspaceViewSource, /markBackendAgentLaunch/);
  assert.match(controlSource, /set_backend_agent_launch_state/);
  assert.match(controlSource, /launch_state: "starting"/);
  assert.match(controlSource, /launch_state: "ready"/);
});

test("no hidden provider session or completion-triggered future chain exists", () => {
  assert.doesNotMatch(
    controlSource,
    /codex app-server|opencode serve|spawn.*hidden|detached.*agent|AgentTurnCompleted|completion.*spawn|schedule/i,
  );
  assert.doesNotMatch(chatSource, /codex app-server|opencode serve/);
  assert.match(chatSource, /never starts future work/);
});

test("handoff is bounded to last result or recent terminal evidence", () => {
  assert.match(controlSource, /MAX_HANDOFF_CONTEXT_BYTES: usize = 6 \* 1024/);
  assert.match(controlSource, /source_evidence/);
  assert.match(controlSource, /last_result/);
  assert.match(controlSource, /build_handoff_prompt/);
});
