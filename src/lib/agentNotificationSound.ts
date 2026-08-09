import { reportFrontendDiagnosticCode } from "./crashDiagnostics";

export interface AgentCompletionChimeContext {
  eventId?: string | null;
  terminalId: string;
  workspaceId?: string | null;
  generation?: number | null;
}

export type AgentCompletionChimeStatus =
  | "scheduled"
  | "throttled"
  | "unsupported"
  | "resume_failed"
  | "context_not_running"
  | "scheduling_failed";

export interface AgentCompletionChimeResult {
  status: AgentCompletionChimeStatus;
}

let audioContext: AudioContext | null = null;
let lastPlayedAt = 0;

function audioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
}

/** Prime Web Audio from a real user gesture before an asynchronous completion. */
export async function primeAgentCompletionChime(): Promise<void> {
  try {
    const AudioContextConstructor = audioContextConstructor();
    if (!AudioContextConstructor) return;
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContextConstructor();
    }
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    console.info("[agent-notification] audio context primed", {
      audioContextState: audioContext.state,
    });
  } catch (error) {
    console.warn("[agent-notification] audio context prime failed", {
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }
}

function diagnosticContext(context: AgentCompletionChimeContext) {
  return {
    eventId: context.eventId ?? "-",
    terminalId: context.terminalId,
    workspaceId: context.workspaceId ?? null,
    generation: context.generation ?? null,
  };
}

function scheduleChime(context: AudioContext) {
  const start = context.currentTime + 0.015;
  const master = context.createGain();
  master.gain.setValueAtTime(0.0001, start);
  master.gain.exponentialRampToValueAtTime(0.72, start + 0.025);
  master.gain.exponentialRampToValueAtTime(0.0001, start + 0.58);
  master.connect(context.destination);

  const notes = [
    [523.25, 0, 0.2],
    [659.25, 0.09, 0.22],
    [783.99, 0.18, 0.34],
  ] as const;
  let remainingNotes = notes.length;
  for (const [frequency, offset, duration] of notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start + offset);
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(1.0, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      start + offset + duration,
    );
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.addEventListener(
      "ended",
      () => {
        oscillator.disconnect();
        gain.disconnect();
        remainingNotes -= 1;
        if (remainingNotes === 0) master.disconnect();
      },
      { once: true },
    );
    oscillator.start(start + offset);
    oscillator.stop(start + offset + duration + 0.02);
  }
}

function reportChimeFailure(
  status: AgentCompletionChimeStatus,
  event: AgentCompletionChimeContext,
) {
  reportFrontendDiagnosticCode("agent-chime-error", status, {
    terminalId: event.terminalId,
    workspaceId: event.workspaceId ?? undefined,
    generation: event.generation ?? undefined,
    requestId: event.eventId ?? undefined,
    state: status,
  });
}

/**
 * Schedules the completion chime and reports whether Web Audio accepted it.
 * This cannot prove that a physical speaker was audible, so callers retain a
 * visual attention path and show a toast whenever audio could not be scheduled.
 */
export async function playAgentCompletionChime(
  event: AgentCompletionChimeContext,
): Promise<AgentCompletionChimeResult> {
  const details = diagnosticContext(event);
  if (typeof window === "undefined") {
    console.warn("[agent-notification] chime unsupported", details);
    return { status: "unsupported" };
  }

  const now = performance.now();
  if (lastPlayedAt > 0 && now - lastPlayedAt < 180) {
    console.info("[agent-notification] chime throttled", details);
    return { status: "throttled" };
  }
  try {
    const AudioContextConstructor = audioContextConstructor();
    if (!AudioContextConstructor) {
      console.warn("[agent-notification] Web Audio API unavailable", details);
      reportChimeFailure("unsupported", event);
      return { status: "unsupported" };
    }

    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContextConstructor();
      console.info("[agent-notification] audio context created", {
        ...details,
        audioContextState: audioContext.state,
      });
    }

    const context = audioContext;
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch (error) {
        console.warn("[agent-notification] audio context resume failed", {
          ...details,
          errorName: error instanceof Error ? error.name : "unknown",
        });
        reportChimeFailure("resume_failed", event);
        return { status: "resume_failed" };
      }
    }
    if (context.state !== "running") {
      console.warn("[agent-notification] audio context is not running", {
        ...details,
        audioContextState: context.state,
      });
      reportChimeFailure("context_not_running", event);
      return { status: "context_not_running" };
    }

    scheduleChime(context);
    lastPlayedAt = performance.now();
    console.info("[agent-notification] chime scheduled", details);
    return { status: "scheduled" };
  } catch (error) {
    console.warn("[agent-notification] chime scheduling failed", {
      ...details,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    reportChimeFailure("scheduling_failed", event);
    return { status: "scheduling_failed" };
  }
}

export function chimeNeedsVisualFallback(
  result: AgentCompletionChimeResult,
): boolean {
  return !["scheduled", "throttled"].includes(result.status);
}
