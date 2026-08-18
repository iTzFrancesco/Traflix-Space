export function JarvisOrb({
  active = false,
  engaged = false,
  listening = false,
  processing = false,
  speaking = false,
  muted = false,
}: {
  active?: boolean;
  engaged?: boolean;
  listening?: boolean;
  processing?: boolean;
  speaking?: boolean;
  muted?: boolean;
}) {
  return (
    <span
      className={`jarvis-orb ${engaged ? "jarvis-orb--engaged" : ""} ${listening ? "jarvis-orb--listening" : ""} ${processing ? "jarvis-orb--processing" : ""} ${speaking ? "jarvis-orb--speaking" : ""} ${muted ? "jarvis-orb--muted" : ""}`}
      aria-hidden="true"
    >
      <img
        className="jarvis-orb__logo"
        src="/icon.png"
        alt=""
        draggable={false}
      />
      {active && <span className="jarvis-orb__status" />}
    </span>
  );
}
