import { AudioWaveform } from "lucide-react";

export function JarvisOrb({
  active = false,
  listening = false,
  speaking = false,
  muted = false,
}: {
  active?: boolean;
  listening?: boolean;
  speaking?: boolean;
  muted?: boolean;
}) {
  return (
    <span
      className={`jarvis-orb ${muted ? "jarvis-orb--muted" : ""} ${listening ? "jarvis-orb--listening" : ""} ${speaking ? "jarvis-orb--speaking" : ""}`}
      aria-hidden="true"
    >
      <AudioWaveform size={15} strokeWidth={1.8} />
      {active && <span className="jarvis-orb__status" />}
    </span>
  );
}
