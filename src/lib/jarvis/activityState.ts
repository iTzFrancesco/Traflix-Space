import type {
  AgentActivityEvent,
  AgentActivityKind,
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

function hasPendingActionForCheckpoint(event: ActivityCheckpoint, pendingActions: PendingAction[]): boolean {
  return pendingActions.some(
    (action) =>
      action.status === "pending" &&
      action.invocation.requestId === event.requestId &&
      action.invocation.targetWorkspaceId === event.workspaceId,
  );
}

function isEffectiveOpenCheckpoint(event: ActivityCheckpoint, pendingActions: PendingAction[]): boolean {
  if (event.status === "running") return true;
  if (event.status === "waiting_confirmation") {
    return hasPendingActionForCheckpoint(event, pendingActions);
  }
  return false;
}

/**
 * Merge incoming checkpoints into the bounded per-workspace view.
 * - Deduplicates by `requestId:phase:targetSessionId` keeping the newest.
 * - A newer phase supersedes older open phases of the same request, preventing
 *   stale "Preparing…" / "Waiting…" rows after the request moves on.
 * - Terminal events remain briefly available to the expanded recent-activity
 *   strip, but never keep the compact widget busy.
 * - The view is capped at `MAX_ACTIVITY_EVENTS` (newest kept).
 */
export function mergeActivityEvents(
  current: ActivityCheckpoint[],
  incoming: ActivityCheckpoint[],
): ActivityCheckpoint[] {
  const byKey = new Map<string, ActivityCheckpoint>();
  for (const event of current) byKey.set(checkpointKey(event), event);

  const orderedIncoming = [...incoming].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const event of orderedIncoming) {
    const key = checkpointKey(event);
    const existing = byKey.get(key);
    if (existing && existing.createdAt > event.createdAt) continue;

    for (const [candidateKey, candidate] of byKey) {
      if (
        candidateKey !== key &&
        candidate.requestId === event.requestId &&
        openStatuses.has(candidate.status) &&
        candidate.createdAt <= event.createdAt
      ) {
        byKey.delete(candidateKey);
      }
    }
    byKey.set(key, event);
  }

  const merged = [...byKey.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.requestId.localeCompare(right.requestId),
  );
  return merged.slice(-MAX_ACTIVITY_EVENTS);
}

/**
 * Expanded-panel activity is a tiny current/recent view, not a log. It may
 * show recent done/failed checkpoints as well as currently open ones. A stale
 * waiting-confirmation checkpoint is hidden as soon as its Pending Action is
 * no longer pending.
 */
export function stripActivities(
  events: ActivityCheckpoint[],
  workspaceId: string | null,
  pendingActions: PendingAction[] = [],
): ActivityCheckpoint[] {
  if (!workspaceId) return [];
  return events
    .filter(
      (event) =>
        event.workspaceId === workspaceId &&
        (event.status !== "waiting_confirmation" || hasPendingActionForCheckpoint(event, pendingActions)),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_ACTIVITY_STRIP);
}

/** True when Jarvis itself has a live checkpoint for the workspace. */
export function hasOpenActivity(
  events: ActivityCheckpoint[],
  workspaceId: string | null,
  pendingActions: PendingAction[] = [],
): boolean {
  if (!workspaceId) return false;
  return events.some(
    (event) =>
      event.workspaceId === workspaceId && isEffectiveOpenCheckpoint(event, pendingActions),
  );
}

/** Newest live Jarvis checkpoint label for the compact bar. */
export function currentActivityLabel(
  events: ActivityCheckpoint[],
  workspaceId: string | null,
  pendingActions: PendingAction[] = [],
): string | null {
  if (!workspaceId) return null;
  const label = events
    .filter(
      (event) =>
        event.workspaceId === workspaceId && isEffectiveOpenCheckpoint(event, pendingActions),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.label;
  return label ? localizeActivityLabel(label) : null;
}

/** Normalize backend checkpoint labels at the UI boundary so the compact
 * widget remains Italian even when an older backend emits English labels. */
function localizeActivityLabel(label: string): string {
  const normalized = label.trim();
  if (normalized === "Checking agents…") return "Controllo agenti…";
  if (normalized === "Checking agent…") return "Controllo agente…";
  if (normalized.startsWith("Checking ")) return `Controllo ${normalized.slice(9)}`;
  if (normalized === "Reading last result…") return "Leggo l'ultimo risultato…";
  if (normalized === "Reading agent timeline…") return "Leggo attività agente…";
  if (normalized === "Reading terminal tail…") return "Leggo coda del terminale…";
  if (normalized.startsWith("Writing to ")) return `Scrivo su ${normalized.slice(11)}`;
  if (normalized.startsWith("Interrupting ")) return `Interrompo ${normalized.slice(13)}`;
  if (normalized === "Sent.") return "Inviato.";
  return label;
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
  activities: ActivityCheckpoint[];
}

/**
 * The compact bar represents Jarvis, never the agent registry. Agent sessions
 * can be working in the background while the bar remains idle. Priority:
 * voice error → no workspace → voice → Jarvis checkpoint → pending action →
 * LLM thinking → TTS → stato inattivo localizzato.
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
    activities,
  } = input;
  if (voiceError) return "Errore voce";
  if (!workspaceName || !workspaceId) return "Seleziona uno spazio di lavoro";
  if (voiceRequest?.status === "recording") return "In ascolto…";
  if (voiceRequest?.status === "armed") return "Ascolto attivo…";
  if (voiceRequest?.status === "transcribing" || voiceRequest?.status === "stopping") return "Trascrivo…";
  if (voiceRequest?.status === "transcript_ready") return "Invio a Jarvis…";

  const activityLabel = currentActivityLabel(activities, workspaceId, pendingActions);
  if (activityLabel) return activityLabel;

  const hasPending = pendingActions.some(
    (action) => action.status === "pending" && action.invocation.targetWorkspaceId === workspaceId,
  );
  if (hasPending) return "In attesa di conferma…";

  const thinking = Object.values(requests).some(
    (request) =>
      request.workspaceId === workspaceId &&
      (request.status === "running" || request.status === "cancellation_requested"),
  );
  if (thinking) return "Sto elaborando…";
  if (ttsStatus.status === "synthesizing" || ttsStatus.status === "playing") return "Sto parlando…";
  return "Pronto quando vuoi";
}
