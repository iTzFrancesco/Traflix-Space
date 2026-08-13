import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { invokeWithTimeout } from "../timeout";
import type {
  ActiveWorkspaceCapture,
  AppSettings,
  AgentActivityEvent,
  AgentMessage,
  AgentResult,
  AgentOpenResult,
  AgentTail,
  AgentSessionContext,
  AgentSessionRef,
  CodexAccountView,
  CodexLoginStartView,
  CodexModelCatalog,
  CodexRateLimitsView,
  CodexRuntimeStatus,
  CodexThreadSnapshot,
  CodexUsageView,
  ContextPackageV1,
  InvocationBinding,
  JarvisErrorEnvelope,
  JarvisChatResponse,
  JarvisConversationMessage,
  JarvisProviderStatus,
  PendingAction,
  ModelContextViewV1,
  NotificationAdapterHealth,
  Provenance,
  RequestedDepth,
  TerminalSummary,
  ToolEnvelope,
  WorkspaceSummary,
  TtsSpeakRequest,
  TtsStatusView,
  TtsVoice,
  VoiceInputDevice,
  VoiceRequestStatusView,
  VoiceActivationMode,
  WakeWordStatusView,
} from "./types";

const READ_TIMEOUT_MS = 15_000;
const MODEL_TIMEOUT_MS = 90_000;

export function notificationAdapterStatus(): Promise<NotificationAdapterHealth> {
  return invokeWithTimeout(
    () => invoke<NotificationAdapterHealth>("jarvis_notification_adapter_status"),
    READ_TIMEOUT_MS,
  );
}

export function installNotificationAdapters(): Promise<NotificationAdapterHealth> {
  return invokeWithTimeout(
    () => invoke<NotificationAdapterHealth>("jarvis_notification_adapter_install"),
    60_000,
  );
}

export interface JarvisChatRequest {
  invocation: InvocationBinding;
  message: string;
  messageId?: string;
}

export function captureActiveWorkspace(
  targetTerminalId?: string,
  targetAgentSessionId?: string,
): InvocationBinding {
  const targetWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (!targetWorkspaceId) {
    throw new Error("Nessuna workspace attiva");
  }

  return {
    requestId: crypto.randomUUID(),
    targetWorkspaceId,
    targetTerminalId,
    targetAgentSessionId,
    createdAt: new Date().toISOString(),
  };
}

export function workspaceGetActive(): ActiveWorkspaceCapture {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  const capturedAt = new Date().toISOString();
  const provenance: Provenance = {
    source: "zustand-workspace-store",
    observedAt: capturedAt,
    confidence: 1,
    untrusted: false,
  };
  return { workspaceId, capturedAt, provenance };
}

export function workspaceList(): Promise<ToolEnvelope<WorkspaceSummary[]>> {
  return invokeWithTimeout(
    () => invoke<ToolEnvelope<WorkspaceSummary[]>>("jarvis_workspace_list"),
    READ_TIMEOUT_MS,
  );
}

export function terminalList(
  workspaceId: string,
  requestId = crypto.randomUUID(),
): Promise<ToolEnvelope<TerminalSummary[]>> {
  return invokeWithTimeout(
    () =>
      invoke<ToolEnvelope<TerminalSummary[]>>("jarvis_terminal_list", {
        workspaceId,
        requestId,
      }),
    READ_TIMEOUT_MS,
  );
}

export function agentOpen(
  invocation: InvocationBinding,
  provider: string,
  initialPrompt?: string,
): Promise<ToolEnvelope<AgentOpenResult>> {
  return invokeWithTimeout(
    () =>
      invoke<ToolEnvelope<AgentOpenResult>>("jarvis_agent_open", {
        invocation,
        provider,
        initialPrompt,
      }),
    MODEL_TIMEOUT_MS,
  );
}

export function agentList(
  workspaceId: string,
  requestId = crypto.randomUUID(),
): Promise<ToolEnvelope<AgentSessionRef[]>> {
  return invokeWithTimeout(
    () =>
      invoke<ToolEnvelope<AgentSessionRef[]>>("jarvis_agent_list", {
        workspaceId,
        requestId,
      }),
    READ_TIMEOUT_MS,
  );
}

export function agentSnapshot(
  workspaceId: string,
  requestId = crypto.randomUUID(),
): Promise<ToolEnvelope<AgentSessionContext[]>> {
  return invokeWithTimeout(
    () =>
      invoke<ToolEnvelope<AgentSessionContext[]>>("jarvis_agent_snapshot", {
        workspaceId,
        requestId,
      }),
    READ_TIMEOUT_MS,
  );
}

export function agentGetStatus(
  workspaceId: string,
  agentSessionId: string,
  requestId = crypto.randomUUID(),
): Promise<ToolEnvelope<AgentSessionContext>> {
  return invokeWithTimeout(
    () =>
      invoke<ToolEnvelope<AgentSessionContext>>("jarvis_agent_get_status", {
        workspaceId,
        agentSessionId,
        requestId,
      }),
    READ_TIMEOUT_MS,
  );
}

export function agentGetLastResult(
  workspaceId: string,
  agentSessionId: string,
  requestId = crypto.randomUUID(),
): Promise<ToolEnvelope<AgentResult | null>> {
  return invokeWithTimeout(
    () =>
      invoke<ToolEnvelope<AgentResult | null>>("jarvis_agent_get_last_result", {
        workspaceId,
        agentSessionId,
        requestId,
      }),
    READ_TIMEOUT_MS,
  );
}

export function agentGetMessages(
  workspaceId: string,
  agentSessionId: string,
  requestId = crypto.randomUUID(),
): Promise<ToolEnvelope<AgentMessage[]>> {
  return invokeWithTimeout(
    () =>
      invoke<ToolEnvelope<AgentMessage[]>>("jarvis_agent_get_messages", {
        workspaceId,
        agentSessionId,
        requestId,
      }),
    READ_TIMEOUT_MS,
  );
}

export function agentActivity(
  workspaceId: string,
  agentSessionId: string,
  limit = 8,
  requestId = crypto.randomUUID(),
): Promise<ToolEnvelope<AgentActivityEvent[]>> {
  return invokeWithTimeout(
    () =>
      invoke<ToolEnvelope<AgentActivityEvent[]>>("jarvis_agent_activity", {
        workspaceId,
        agentSessionId,
        limit,
        requestId,
      }),
    READ_TIMEOUT_MS,
  );
}

export function agentTail(
  workspaceId: string,
  terminalId: string,
  generation: number,
  maxLines = 40,
  requestId = crypto.randomUUID(),
): Promise<ToolEnvelope<AgentTail>> {
  return invokeWithTimeout(
    () => invoke<ToolEnvelope<AgentTail>>("jarvis_agent_tail", {
      workspaceId,
      terminalId,
      generation,
      maxLines,
      requestId,
    }),
    READ_TIMEOUT_MS,
  );
}

export function buildContext(
  requestedDepth: RequestedDepth = "summary",
  targetTerminalId?: string,
  targetAgentSessionId?: string,
): Promise<ContextPackageV1> {
  const invocation = captureActiveWorkspace(targetTerminalId, targetAgentSessionId);
  return invokeWithTimeout(
    () =>
      invoke<ContextPackageV1>("jarvis_build_context", {
        workspaceId: invocation.targetWorkspaceId,
        requestId: invocation.requestId,
        requestedDepth,
        targetTerminalId: invocation.targetTerminalId,
        targetAgentSessionId: invocation.targetAgentSessionId,
      }),
    READ_TIMEOUT_MS,
  );
}

export function refreshContext(
  requestedDepth: RequestedDepth = "summary",
  targetTerminalId?: string,
  targetAgentSessionId?: string,
): Promise<ContextPackageV1> {
  const invocation = captureActiveWorkspace(targetTerminalId, targetAgentSessionId);
  return invokeWithTimeout(
    () =>
      invoke<ContextPackageV1>("jarvis_refresh_context", {
        workspaceId: invocation.targetWorkspaceId,
        requestId: invocation.requestId,
        requestedDepth,
        targetTerminalId: invocation.targetTerminalId,
        targetAgentSessionId: invocation.targetAgentSessionId,
      }),
    READ_TIMEOUT_MS,
  );
}

export function buildModelContext(
  requestedDepth: RequestedDepth = "summary",
  requestedDocumentPaths: string[] = [],
  targetTerminalId?: string,
  targetAgentSessionId?: string,
): Promise<ModelContextViewV1> {
  const invocation = captureActiveWorkspace(targetTerminalId, targetAgentSessionId);
  return invokeWithTimeout(
    () =>
      invoke<ModelContextViewV1>("jarvis_build_model_context", {
        workspaceId: invocation.targetWorkspaceId,
        requestId: invocation.requestId,
        requestedDepth,
        targetTerminalId: invocation.targetTerminalId,
        targetAgentSessionId: invocation.targetAgentSessionId,
        requestedDocumentPaths,
      }),
    READ_TIMEOUT_MS,
  );
}

export function refreshModelContext(
  requestedDepth: RequestedDepth = "summary",
  requestedDocumentPaths: string[] = [],
  targetTerminalId?: string,
  targetAgentSessionId?: string,
): Promise<ModelContextViewV1> {
  const invocation = captureActiveWorkspace(targetTerminalId, targetAgentSessionId);
  return invokeWithTimeout(
    () =>
      invoke<ModelContextViewV1>("jarvis_refresh_model_context", {
        workspaceId: invocation.targetWorkspaceId,
        requestId: invocation.requestId,
        requestedDepth,
        targetTerminalId: invocation.targetTerminalId,
        targetAgentSessionId: invocation.targetAgentSessionId,
        requestedDocumentPaths,
      }),
    READ_TIMEOUT_MS,
  );
}

export type JarvisClientError = JarvisErrorEnvelope;

export function getSettings(): Promise<AppSettings> {
  return invokeWithTimeout(
    () => invoke<AppSettings>("get_settings"),
    READ_TIMEOUT_MS,
  );
}

export function setSettings(settings: AppSettings): Promise<void> {
  return invokeWithTimeout(
    () => invoke<void>("set_settings", { settings }),
    READ_TIMEOUT_MS,
  );
}

export function jarvisChat(request: JarvisChatRequest): Promise<JarvisChatResponse> {
  return invokeWithTimeout(
    () => invoke<JarvisChatResponse>("jarvis_chat", { request }),
    MODEL_TIMEOUT_MS,
  );
}

export function cancelChat(requestId: string): Promise<{ requestId: string; status: string }> {
  return invokeWithTimeout(
    () => invoke<{ requestId: string; status: string }>("jarvis_cancel_chat", { requestId }),
    READ_TIMEOUT_MS,
  );
}

export function chatStatus(requestId: string): Promise<{ requestId: string; status: string }> {
  return invokeWithTimeout(
    () => invoke<{ requestId: string; status: string }>("jarvis_chat_status", { requestId }),
    READ_TIMEOUT_MS,
  );
}

export function conversationHistory(workspaceId: string): Promise<JarvisConversationMessage[]> {
  return invokeWithTimeout(
    () => invoke<JarvisConversationMessage[]>("jarvis_conversation_history", { workspaceId }),
    READ_TIMEOUT_MS,
  );
}

export function providerStatus(): Promise<JarvisProviderStatus> {
  return invokeWithTimeout(
    () => invoke<JarvisProviderStatus>("jarvis_provider_status"),
    READ_TIMEOUT_MS,
  );
}

export function pendingActions(): Promise<ToolEnvelope<PendingAction[]>> {
  return invokeWithTimeout(
    () => invoke<ToolEnvelope<PendingAction[]>>("jarvis_pending_actions"),
    READ_TIMEOUT_MS,
  );
}

export function confirmAction(actionId: string, invocation: InvocationBinding): Promise<PendingAction> {
  return invokeWithTimeout(
    () => invoke<PendingAction>("jarvis_confirm_action", { actionId, invocation }),
    READ_TIMEOUT_MS,
  );
}

export function rejectAction(actionId: string, invocation: InvocationBinding): Promise<PendingAction> {
  return invokeWithTimeout(
    () => invoke<PendingAction>("jarvis_reject_action", { actionId, invocation }),
    READ_TIMEOUT_MS,
  );
}

export function updatePendingAction(actionId: string, invocation: InvocationBinding, text: string): Promise<PendingAction> {
  return invokeWithTimeout(
    () => invoke<PendingAction>("jarvis_update_pending_action", { actionId, invocation, text }),
    READ_TIMEOUT_MS,
  );
}

export function clearConversation(workspaceId: string): Promise<void> {
  return invokeWithTimeout(
    () => invoke<void>("jarvis_clear_conversation", { workspaceId }),
    READ_TIMEOUT_MS,
  );
}

export type IdentityDecision = "confirm" | "ignore" | "clear";

export function setIdentityDecision(
  decision: IdentityDecision,
  session: AgentSessionRef,
): Promise<ToolEnvelope<AgentSessionRef>> {
  if (!session.terminalId) return Promise.reject(new Error("Terminale non disponibile"));
  const command = decision === "confirm" ? "jarvis_confirm_identity" : decision === "ignore" ? "jarvis_ignore_identity" : "jarvis_clear_identity_decision";
  return invokeWithTimeout(
    () => invoke<ToolEnvelope<AgentSessionRef>>(command, {
      workspaceId: session.workspaceId,
      terminalId: session.terminalId,
      generation: session.generation,
      provider: session.observedProvider ?? session.resolvedProvider,
      requestId: crypto.randomUUID(),
    }),
    READ_TIMEOUT_MS,
  );
}

export function markSelectedAgent(
  workspaceId: string,
  agentSessionId: string,
): Promise<void> {
  return invokeWithTimeout(
    () => invoke<void>("jarvis_mark_selected_agent", {
      workspaceId,
      agentSessionId,
      requestId: crypto.randomUUID(),
    }),
    READ_TIMEOUT_MS,
  );
}

export function voiceListInputDevices(): Promise<VoiceInputDevice[]> {
  return invokeWithTimeout(() => invoke<VoiceInputDevice[]>("jarvis_voice_list_input_devices"), READ_TIMEOUT_MS);
}

export function getWakeWordStatus(): Promise<WakeWordStatusView> {
  return invokeWithTimeout(
    () => invoke<WakeWordStatusView>("jarvis_wake_word_status"),
    READ_TIMEOUT_MS,
  );
}

export function voiceSyncShortcut(): Promise<void> {
  return invokeWithTimeout(() => invoke<void>("jarvis_voice_sync_shortcut"), READ_TIMEOUT_MS);
}

export function voiceStart(request: { requestId: string; workspaceId: string; selectedDeviceId?: string | null; activationMode?: VoiceActivationMode; forceEndpointing?: boolean }): Promise<VoiceRequestStatusView> {
  return invokeWithTimeout(() => invoke<VoiceRequestStatusView>("jarvis_voice_start", { request }), READ_TIMEOUT_MS);
}

export function voiceStop(requestId: string): Promise<VoiceRequestStatusView> {
  return invokeWithTimeout(() => invoke<VoiceRequestStatusView>("jarvis_voice_stop", { request: { requestId } }), MODEL_TIMEOUT_MS);
}

export function voiceCancel(requestId: string): Promise<VoiceRequestStatusView> {
  return invokeWithTimeout(() => invoke<VoiceRequestStatusView>("jarvis_voice_cancel", { request: { requestId } }), READ_TIMEOUT_MS);
}

export function voiceStatus(requestId?: string): Promise<VoiceRequestStatusView> {
  return invokeWithTimeout(() => invoke<VoiceRequestStatusView>("jarvis_voice_status", { requestId }), READ_TIMEOUT_MS);
}

export function voiceWorkspaceStatus(workspaceId: string): Promise<VoiceRequestStatusView | null> {
  return invokeWithTimeout(() => invoke<VoiceRequestStatusView | null>("jarvis_voice_workspace_status", { workspaceId }), READ_TIMEOUT_MS);
}

export function voiceDiscardTranscript(requestId: string): Promise<void> {
  return invokeWithTimeout(() => invoke<void>("jarvis_voice_discard_transcript", { requestId }), READ_TIMEOUT_MS);
}

export function voiceShutdown(): Promise<void> {
  return invokeWithTimeout(() => invoke<void>("jarvis_voice_shutdown"), READ_TIMEOUT_MS);
}

export function ttsSpeak(request: TtsSpeakRequest): Promise<TtsStatusView> {
  return invokeWithTimeout(() => invoke<TtsStatusView>("jarvis_tts_speak", { request }), MODEL_TIMEOUT_MS);
}

export function ttsStop(): Promise<TtsStatusView> {
  return invokeWithTimeout(() => invoke<TtsStatusView>("jarvis_tts_stop"), READ_TIMEOUT_MS);
}

export function ttsStatus(): Promise<TtsStatusView> {
  return invokeWithTimeout(() => invoke<TtsStatusView>("jarvis_tts_status"), READ_TIMEOUT_MS);
}

export function ttsListVoices(): Promise<TtsVoice[]> {
  return invokeWithTimeout(() => invoke<TtsVoice[]>("jarvis_tts_list_voices"), READ_TIMEOUT_MS);
}

// --- Codex App Server (C1/C2) ---

export function codexRuntimeStatus(): Promise<CodexRuntimeStatus> {
  return invokeWithTimeout(
    () => invoke<CodexRuntimeStatus>("jarvis_codex_runtime_status"),
    READ_TIMEOUT_MS,
  );
}

export function codexRuntimeStart(): Promise<CodexRuntimeStatus> {
  return invokeWithTimeout(
    () => invoke<CodexRuntimeStatus>("jarvis_codex_runtime_start"),
    MODEL_TIMEOUT_MS,
  );
}

export function codexRuntimeRestart(): Promise<CodexRuntimeStatus> {
  return invokeWithTimeout(
    () => invoke<CodexRuntimeStatus>("jarvis_codex_runtime_restart"),
    READ_TIMEOUT_MS,
  );
}

export function codexAccountRead(): Promise<CodexAccountView> {
  return invokeWithTimeout(
    () => invoke<CodexAccountView>("jarvis_codex_account_read"),
    READ_TIMEOUT_MS,
  );
}

export function codexLoginStart(): Promise<CodexLoginStartView> {
  return invokeWithTimeout(
    () => invoke<CodexLoginStartView>("jarvis_codex_login_start"),
    READ_TIMEOUT_MS,
  );
}

export function codexLoginCancel(loginId: string): Promise<void> {
  return invokeWithTimeout(
    () => invoke<void>("jarvis_codex_login_cancel", { loginId }),
    READ_TIMEOUT_MS,
  );
}

export function codexLogout(): Promise<void> {
  return invokeWithTimeout(
    () => invoke<void>("jarvis_codex_logout"),
    READ_TIMEOUT_MS,
  );
}

export function codexModelList(): Promise<CodexModelCatalog> {
  return invokeWithTimeout(
    () => invoke<CodexModelCatalog>("jarvis_codex_model_list"),
    READ_TIMEOUT_MS,
  );
}

export function codexRateLimits(): Promise<CodexRateLimitsView> {
  return invokeWithTimeout(
    () => invoke<CodexRateLimitsView>("jarvis_codex_rate_limits"),
    READ_TIMEOUT_MS,
  );
}

export function codexUsage(): Promise<CodexUsageView> {
  return invokeWithTimeout(
    () => invoke<CodexUsageView>("jarvis_codex_usage"),
    READ_TIMEOUT_MS,
  );
}

export function codexThreads(): Promise<CodexThreadSnapshot> {
  return invokeWithTimeout(
    () => invoke<CodexThreadSnapshot>("jarvis_codex_threads"),
    READ_TIMEOUT_MS,
  );
}

export function codexThreadEnsure(workspaceId: string): Promise<unknown> {
  return invokeWithTimeout(
    () => invoke<unknown>("jarvis_codex_thread_ensure", { workspaceId }),
    READ_TIMEOUT_MS,
  );
}

export function codexThreadDelete(workspaceId: string): Promise<void> {
  return invokeWithTimeout(
    () => invoke<void>("jarvis_codex_thread_delete", { workspaceId }),
    READ_TIMEOUT_MS,
  );
}

export function codexTurnStart(workspaceId: string, input: string): Promise<string> {
  return invokeWithTimeout(
    () => invoke<string>("jarvis_codex_turn_start", { workspaceId, input }),
    READ_TIMEOUT_MS,
  );
}

export function codexTurnInterrupt(workspaceId: string): Promise<void> {
  return invokeWithTimeout(
    () => invoke<void>("jarvis_codex_turn_interrupt", { workspaceId }),
    READ_TIMEOUT_MS,
  );
}

export function codexTurnSteer(workspaceId: string, steerText: string): Promise<void> {
  return invokeWithTimeout(
    () => invoke<void>("jarvis_codex_turn_steer", { workspaceId, steerText }),
    READ_TIMEOUT_MS,
  );
}

