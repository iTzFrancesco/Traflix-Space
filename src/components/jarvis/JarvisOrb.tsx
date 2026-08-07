import { Sparkles } from "lucide-react";

export function JarvisOrb({
  active = false,
  listening = false,
  speaking = false,
}: {
  active?: boolean;
  listening?: boolean;
  speaking?: boolean;
}) {
  return (
    <span
      className={`jarvis-orb ${listening ? "jarvis-orb--listening" : ""} ${speaking ? "jarvis-orb--speaking" : ""}`}
      aria-hidden="true"
    >
      <Sparkles size={15} strokeWidth={1.8} />
      {active && <span className="jarvis-orb__status" />}
    </span>
  );
}
