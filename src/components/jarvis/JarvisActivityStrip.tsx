import { Activity, CheckCircle2, Loader2, TimerReset, XCircle } from "lucide-react";
import { stripActivities, type ActivityCheckpoint } from "../../lib/jarvis/activityState";
import type { PendingAction } from "../../lib/jarvis/types";

interface Props {
  activities: ActivityCheckpoint[];
  workspaceId: string | null;
  pendingActions: PendingAction[];
}

/**
 * Ephemeral backend-deterministic activity strip. Shows at most three current
 * or recent checkpoints for the current workspace. Completed/failed rows may
 * remain briefly as recent context; stale waiting-confirmation rows disappear
 * as soon as their Pending Action is no longer pending. This is not a log and
 * never becomes a conversation message.
 */
export function JarvisActivityStrip({ activities, workspaceId, pendingActions }: Props) {
  const visible = stripActivities(activities, workspaceId, pendingActions);
  if (visible.length === 0) return null;
  return (
    <div className="mb-3 space-y-1.5">
      {visible.map((event) => (
        <div
          key={`${event.requestId}:${event.phase}:${event.targetSessionId ?? ""}`}
          className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-[11px] text-neutral-text-muted"
        >
          {event.status === "running" && <Loader2 size={12} className="shrink-0 animate-spin text-primary" />}
          {event.status === "waiting_confirmation" && <TimerReset size={12} className="shrink-0 text-signal" />}
          {event.status === "done" && <CheckCircle2 size={12} className="shrink-0 text-signal" />}
          {event.status === "failed" && <XCircle size={12} className="shrink-0 text-danger" />}
          <span className="truncate">{event.label}</span>
          <Activity size={11} className="ml-auto shrink-0 opacity-40" />
        </div>
      ))}
    </div>
  );
}
