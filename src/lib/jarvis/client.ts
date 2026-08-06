import { invoke } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { invokeWithTimeout } from "../timeout";
import type {
  ActiveWorkspaceCapture,
  AppSettings,
  AgentMessage,
  AgentResult,
  AgentSessionContext,
  AgentSessionRef,
  ContextPackageV1,
  InvocationBinding,
  JarvisErrorEnvelope,
  ModelContextViewV1,
  Provenance,
  RequestedDepth,
  TerminalSummary,
  ToolEnvelope,
  WorkspaceSummary,
} from "./types";

const READ_TIMEOUT_MS = 15_000;

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
