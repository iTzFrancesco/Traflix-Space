import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applyRegistrySnapshot } from "../src/lib/jarvis/registryState.ts";
import {
  isWorkspaceChatLoading,
  mergeConversationMessages,
  mergeJarvisRequestState,
  pendingActionsForWorkspace,
} from "../src/lib/jarvis/chatState.ts";
import {
  collapsedJarvisStatus,
  hasOpenActivity,
  jarvisStepLabel,
  mergeActivityEvents,
  stripActivities,
} from "../src/lib/jarvis/activityState.ts";
import {
  canSendTranscript,
  isVoiceCaptureBusy,
  isVoiceEndpointPaused,
  mergeVoiceRequestStatus,
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
const planSource = source("../src-tauri/src/jarvis/control/plan.rs");
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

test("a successful chat response cannot be rewritten by a late cancellation", () => {
  const running = {
    requestId: "chat-voice",
    workspaceId: "workspace-a",
    voiceRequestId: "voice-a",
    createdAt: "now",
    status: "running",
  };
  const cancellation = mergeJarvisRequestState(running, {
    ...running,
    status: "cancellation_requested",
  });
  const completed = mergeJarvisRequestState(cancellation, {
    ...running,
    status: "completed",
  });
  const lateCancellation = mergeJarvisRequestState(completed, {
    ...running,
    status: "cancellation_requested",
  });
  assert.equal(completed.status, "completed");
  assert.equal(lateCancellation.status, "completed");
  assert.equal(lateCancellation.voiceRequestId, "voice-a");
});

test("a PTY write receipt closes its local activity even without turn_started", () => {
  const running = {
    requestId: "dispatch-1",
    workspaceId: "workspace-a",
    phase: "writing",
    label: "Writing to Codex…",
    status: "running",
    targetSessionId: "session-old",
    createdAt: "2026-08-14T20:00:00.000Z",
  };
  const completed = {
    ...running,
    label: "Scritto; avvio turno non confermato.",
    status: "done",
    targetSessionId: undefined,
    createdAt: "2026-08-14T20:00:00.100Z",
  };
  const activities = mergeActivityEvents([running], [completed]);
  assert.equal(hasOpenActivity(activities, "workspace-a"), false);
  assert.equal(
    collapsedJarvisStatus(idle({ activities })),
    "Al tuo comando",
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

test("same-request voice events cannot rewind speech into standby", () => {
  const recording = {
    requestId: "voice-order",
    workspaceId: "workspace-a",
    status: "recording",
    createdAt: "now",
    normalizedLevel: 0.4,
    durationMs: 500,
    endpointState: "pause",
    vadState: "silence",
  };
  const lateStartResponse = { ...recording, status: "armed", endpointState: "standby" };
  assert.equal(mergeVoiceRequestStatus(recording, lateStartResponse), recording);
  assert.equal(
    mergeVoiceRequestStatus(recording, {
      ...recording,
      durationMs: 400,
      endpointState: "speaking",
    }),
    recording,
  );

  const resumed = mergeVoiceRequestStatus(recording, {
    ...recording,
    durationMs: 650,
    endpointState: "speaking",
    normalizedLevel: 0.7,
  });
  assert.equal(resumed.status, "recording");
  assert.equal(resumed.endpointState, "speaking");
  assert.equal(isVoiceEndpointPaused(recording), true);
  assert.equal(isVoiceEndpointPaused(resumed), false);
  assert.equal(isVoiceCaptureBusy({ ...recording, status: "transcript_ready" }), false);
});

test("terminal voice state wins over a shorter WAV duration", () => {
  const transcribing = {
    requestId: "voice-terminal",
    workspaceId: "workspace-a",
    status: "transcribing",
    createdAt: "now",
    normalizedLevel: 0,
    durationMs: 5_300,
    vadState: "silence",
  };
  const terminal = mergeVoiceRequestStatus(transcribing, {
    ...transcribing,
    status: "transcript_ready",
    durationMs: 5_120,
    transcript: "Ehi Jarvis, mi senti?",
  });
  assert.equal(terminal.status, "transcript_ready");
  assert.equal(terminal.durationMs, 5_120);
  assert.equal(terminal.transcript, "Ehi Jarvis, mi senti?");
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
  hold.voiceInput.globalShortcutEnabled = false;
  const holdSettings = ownerModeJarvisSettings(hold);
  assert.equal(holdSettings.voiceInput.activationMode, "hold_to_talk");
  assert.equal(holdSettings.voiceInput.globalShortcutEnabled, true);
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
  const completionListenerSource = source(
    "../src/components/agent/AgentCompletionListener.tsx",
  );
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
  assert.match(chimeSource, /export async function primeAgentCompletionChime/);
  assert.match(chimeSource, /audioContext\.resume\(\)/);
  assert.match(completionListenerSource, /primeChimeFromGesture/);
  assert.match(completionListenerSource, /window\.addEventListener\("pointerdown"/);
  assert.match(completionListenerSource, /window\.addEventListener\("keydown"/);
});

test("idle and active status hierarchy stays compact", () => {
  assert.equal(collapsedJarvisStatus(idle()), "Al tuo comando");
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
    "Ti ascolto",
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
    "Elaboro…",
  );
  assert.equal(
    collapsedJarvisStatus(idle({ ttsStatus: { status: "playing" } })),
    "Sto parlando…",
  );
});

test("completed Codex messages do not keep the compact widget animated", () => {
  const input = {
    workspaceId: "workspace-a",
    voiceRequest: null,
    ttsStatus: { status: "idle" },
    activities: [],
    pendingActions: [],
    codexTool: null,
    codexTurnActive: false,
    codexMessage: "Sono qui, Jarvis all'ascolto…",
  };
  assert.equal(jarvisStepLabel(input), null);
  assert.equal(
    jarvisStepLabel({ ...input, codexTurnActive: true }),
    "Sono qui, Jarvis all'ascolto…",
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

test("single watchdog publishes capture states and the latch self-heals", () => {
  assert.match(
    voiceCommandsSource,
    /matches!\(\s*current\.status,\s*VoiceRequestStatus::Recording \| VoiceRequestStatus::Armed\s*\)/s,
  );
  assert.match(voiceCommandsSource, /One watchdog owns capture telemetry/);
  assert.match(voiceCommandsSource, /current\.status == VoiceRequestStatus::Failed/);
  assert.equal(
    (voiceCommandsSource.match(/tokio::spawn\(async move/g) ?? []).length,
    1,
  );
  assert.match(overlaySource, /Reconcile a stale active request/);
  assert.match(
    overlaySource,
    /\["idle", "transcript_ready", "cancelled", "failed"\]\.includes\(\s*latched\.status[,\s]*\)/s,
  );
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
  // Codex App Server uses the dotted tool name; the planner implementation
  // remains typed and allowlisted in the control module.
  assert.match(controlSource, /conversational_plan/);
  assert.match(controlSource, /execute_plan\(/);
  assert.match(planSource, /pub enum PlanOperation/);
  assert.match(planSource, /AgentHandoff/);
  assert.match(planSource, /DraftPrompt/);
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
  assert.match(controlSource, /write_typed_for_runtime\(/);
  assert.match(controlSource, /TerminalInputOrigin::JarvisPrompt/);
  assert.match(controlSource, /observe_jarvis_send_for_session/);
  assert.match(registrySource, /observe_jarvis_send_for_session/);
  assert.match(controlSource, /submission_unconfirmed/);
});

test("semantic target resolution remains bounded and ambiguity-aware", () => {
  assert.match(controlSource, /terminal\.title/);
  assert.match(controlSource, /session\.current_task/);
  assert.match(controlSource, /session\.last_result/);
  assert.match(controlSource, /read_agent_tail/);
  assert.match(controlSource, /MAX_TAIL_BYTES: usize = 12 \* 1024/);
  assert.match(controlSource, /TargetResolution::Ambiguous/);
});

test("agent routing binds alias separately from duplicate display titles", () => {
  assert.match(controlSource, /agent_alias/);
  assert.match(controlSource, /agent_session_id/);
  assert.match(controlSource, /provider_session_id/);
  assert.match(controlSource, /target_from_binding/);
  assert.match(controlSource, /agent_binding_stale_or_mismatch/);
  assert.match(controlSource, /Non ho un binding attivo per questo follow-up/);
  // The implementation now handles stale bindings in a dedicated match so a
  // live binding can be reactivated without conflating it with ambiguity.
  assert.match(controlSource, /match target_from_binding\(context, &binding\)/);
  assert.match(controlSource, /TargetResolution::Selected\(target\)/);
  assert.match(controlSource, /follow_up/);
  assert.match(controlSource, /automatic_follow_up_requested/);
  assert.match(controlSource, /followUp/);
  assert.match(registrySource, /dispatch_lock/);
  assert.match(registrySource, /current_session_id/);
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
  assert.match(controlSource, /Duration::from_secs\(30\)/);
  assert.match(controlSource, /ReadinessEvidence::ProcessTree/);
  assert.match(controlSource, /ReadinessEvidence::TerminalHint/);
  assert.match(controlSource, /validate_readiness_runtime/);
  assert.match(controlSource, /startup_failure_code/);
});

test("agent.open rollback removes config only after the exact PTY lifetime is removed", () => {
  const rollbackStart = controlSource.indexOf("async fn rollback_open_agent");
  const rollbackEnd = controlSource.indexOf("async fn wait_until_ready", rollbackStart);
  const rollback = controlSource.slice(rollbackStart, rollbackEnd);
  assert.ok(rollbackStart >= 0 && rollbackEnd > rollbackStart);
  assert.ok(
    rollback.indexOf("kill_generation") < rollback.indexOf("commit_terminal_close"),
  );
  assert.match(rollback, /rollback-runtime-mismatch/);
  assert.match(rollback, /rollback-close-commit-failed/);
});

test("no hidden provider session or completion-triggered future chain exists", () => {
  assert.doesNotMatch(
    controlSource,
    /codex app-server|opencode serve|spawn.*hidden|detached.*agent|AgentTurnCompleted|completion.*spawn|schedule/i,
  );
  assert.doesNotMatch(chatSource, /opencode serve/);
  assert.match(chatSource, /state\s*\.model\s*\.complete/);
});

test("handoff is bounded to last result or recent terminal evidence", () => {
  assert.match(controlSource, /MAX_HANDOFF_CONTEXT_BYTES: usize = 6 \* 1024/);
  assert.match(controlSource, /source_evidence/);
  assert.match(controlSource, /last_result/);
  assert.match(controlSource, /build_handoff_prompt/);
});
