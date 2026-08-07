import type {
  AgentActivityEvent,
  AgentActivityKind,
  AgentSessionContext,
  JarvisRequestState,
  PendingAction,
  TtsStatusView,
  VoiceRequestStatusView,
} from "./types";

/** Maximum checkpoint events kept per workspace in the ephemeral activity view. */
export const MAX_ACTIVITY_EVENTS = 16;
/** Maximum rows shown in the expanded panel activity strip. */
export const MAX_ACTIVITY_STRIP = 3;

export type CheckpointStatus = "running" | "done" | "failed" | "waiting_confirmation";

/** Backend-emitted `jarvis://activity` checkpoint (never model-generated). */
export interface ActivityCheckpoint {
  requestId: string;
  workspaceId: string;
  phase: string;
  label: string;
  status: CheckpointStatus;
  createdAt: string;
  targetSessionId?: string;
}

export function checkpointId(event: ActivityCheckpoint): string {
  return `${event.requestId}:${event.phase}`;
}

function checkpointKey(event: ActivityCheckpoint): string {
  return `${event.requestId}:${event.phase}:${event.targetSessionId ?? ""}`;
}

const openStatuses = new Set<CheckpointStatus>(["running", "waiting_confirmation"]);
const terminalStatuses = new Set<CheckpointStatus>(["done", "failed"]);

/**
 * Merge incoming checkpoints into the bounded per-workspace view.
 * - Deduplicates by `requestId:phase:targetSessionId` keeping the newest.
 * - A terminal event (done/failed) supersedes any open event of the same key.
 * - The view is capped at `MAX_ACTIVITY_EVENTS` (newest kept).
 */
export function mergeActivityEvents(
  current: ActivityCheckpoint[],
  incoming: ActivityCheckpoint[],
): ActivityCheckpoint[] {
  const byKey = new Map<string, ActivityCheckpoint>();
  for (const event of [...current, ...incoming]) {
    const key = checkpointKey(event);
    const existing = byKey.get(key);
    if (!existing || existing.createdAt <= event.createdAt) byKey.set(key, event);
  }
  const merged = [...byKey.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.requestId.localeCompare(right.requestId),
  );
  return merged.slice(-MAX_ACTIVITY_EVENTS);
}

/**
 * The strip shows open (running / waiting confirmation) checkpoints for the
 * workspace, newest first, capped at `MAX_ACTIVITY_STRIP`. Terminal events are
 * pruned immediately: the strip is ephemeral, not a log.
 */
export function stripActivities(
  events: ActivityCheckpoint[],
  workspaceId: string | null,
): ActivityCheckpoint[] {
  return events
    .filter(
      (event) =>
        event.workspaceId === workspaceId && openStatuses.has(event.status),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_ACTIVITY_STRIP);
}

/** True when at least one open checkpoint is visible for the workspace. */
export function hasOpenActivity(events: ActivityCheckpoint[], workspaceId: string | null): boolean {
  return stripActivities(events, workspaceId).length > 0;
}

export function hasTerminalStatus(status: CheckpointStatus): boolean {
  return terminalStatuses.has(status);
}

/** Terminal kinds of the semantic activity timeline (not checkpoints). */
const openTimelineKinds = new Set<AgentActivityKind>(["prompt_submitted", "working"]);
const terminalTimelineKinds = new Set<AgentActivityKind>([
  "completion_observed",
  "result_available",
  "interrupted",
  "exited",
]);

/**
 * Prune superseded open timeline events: an open event (prompt submitted /
 * working) that precedes a terminal event is obsolete and is dropped. At most
 * one open event survives — the current one after the last terminal event.
 */
export function pruneSupersededOpenEvents(events: AgentActivityEvent[]): AgentActivityEvent[] {
  const result: AgentActivityEvent[] = [];
  let terminalSeen = false;
  for (const event of events) {
    if (openTimelineKinds.has(event.kind)) {
      if (terminalSeen) continue;
      result.push(event);
    } else {
      result.push(event);
      if (terminalTimelineKinds.has(event.kind)) terminalSeen = true;
    }
  }
  return result;
}

export interface CollapsedStatusInput {
  workspaceId: string | null;
  workspaceName: string | null;
  voiceError: string | null;
  voiceRequest: VoiceRequestStatusView | null;
  ttsStatus: TtsStatusView;
  requests: Record<string, JarvisRequestState>;
  pendingActions: PendingAction[];
  registrySessions: AgentSessionContext[];
}

/**
 * Collapsed widget status text. Priority: voice error → no workspace → voice
 * active → agent working → pending confirmation → LLM thinking → TTS speaking
 * → idle. Never shows agent names or counts ("Codex ready" is forbidden).
 */
export function collapsedJarvisStatus(input: CollapsedStatusInput): string {
  const {
    workspaceId,
    workspaceName,
    voiceError,
    voiceRequest,
    ttsStatus,
    requests,
    pendingActions,
    registrySessions,
  } = input;
  if (voiceError) return "Errore voce";
  if (!workspaceName || !workspaceId) return "Seleziona una workspace";
  if (voiceRequest?.status === "recording") return "Ti ascolto…";
  if (voiceRequest?.status === "armed") return "In ascolto…";
  if (voiceRequest?.status === "transcribing" || voiceRequest?.status === "stopping") return "Trascrivo…";
  const agentWorking = registrySessions.some(
    (session) =>
      session.ref.workspaceId === workspaceId &&
      (session.state === "working" || session.state === "starting"),
  );
  if (agentWorking) return "L'agente sta lavorando…";
  const hasPending = pendingActions.some(
    (action) => action.status === "pending" && action.invocation.targetWorkspaceId === workspaceId,
  );
  if (hasPending) return "Conferma richiesta";
  const thinking = Object.values(requests).some(
    (request) =>
      request.workspaceId === workspaceId &&
      (request.status === "running" || request.status === "cancellation_requested"),
  );
  if (thinking) return "Jarvis sta pensando…";
  if (ttsStatus.status === "synthesizing" || ttsStatus.status === "playing") return "Sto parlando…";
  return "Pronto quando vuoi";
}
