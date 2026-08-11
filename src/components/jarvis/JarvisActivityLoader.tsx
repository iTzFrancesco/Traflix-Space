import { useEffect, useState } from "react";
import { currentCodexTool } from "../../lib/jarvis/chatState";
import { useJarvisStore } from "../../stores/jarvisStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";

/**
 * Per-step pixel loader for the Jarvis pill: a 3×3 chevron wavefront
 * (each pixel lights up on a staggered delay) next to the current step
 * label and a monospace elapsed timer.
 *
 * The visible label is not a unique step identity: two consecutive
 * `markdown.read` calls both say "Leggo la documentazione". Derive the
 * active Codex tool item id here so the timer still restarts for repeated
 * same-label steps without coupling the caller to timing internals.
 */
export function JarvisActivityLoader({ label }: { label: string }) {
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const streamingTurns = useJarvisStore((state) => state.codexStreamingTurns);
  const activeToolId = currentCodexTool(streamingTurns, workspaceId)?.itemId ?? "";
  const elapsed = useStepElapsed(`${label}:${activeToolId}`);

  return (
    <div className="jarvis-activity-loader flex min-w-0 items-center gap-2">
      <span
        aria-hidden
        className="grid shrink-0 grid-cols-3 gap-[2px]"
      >
        {PIXEL_DELAYS.map((delay, index) => (
          <span
            key={index}
            className="jarvis-activity-loader__pixel size-[4px] rounded-[1px] bg-current"
            style={{
              opacity: 0.15,
              animation: `pixel-on 650ms ease-in-out ${delay}ms infinite`,
            }}
          />
        ))}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold leading-none tracking-[0.01em] text-neutral-text">
        {label}
      </span>
      <span className="shrink-0 font-mono text-[10px] leading-none tabular-nums text-neutral-text-dim">
        {elapsed}
      </span>
    </div>
  );
}

/** Wavefront delays (ms) for the 3×3 chevron: middle column first, then
 * the two outer columns — a left-to-right sweep. */
const PIXEL_DELAYS = [90, 0, 90, 180, 90, 180, 270, 180, 270];

function useStepElapsed(stepIdentity: string): string {
  const [deciseconds, setDeciseconds] = useState(0);

  useEffect(() => {
    setDeciseconds(0);
    const timer = window.setInterval(
      () => setDeciseconds((value) => value + 1),
      100,
    );
    return () => window.clearInterval(timer);
  }, [stepIdentity]);

  const total = deciseconds / 10;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}