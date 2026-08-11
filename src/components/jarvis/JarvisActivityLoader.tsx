/**
 * Pixel loader for the Jarvis pill: a 3×3 chevron wavefront next to the
 * current step label. Timing stays in diagnostics/logs; the pill only shows
 * what Jarvis is doing right now.
 */
export function JarvisActivityLoader({ label }: { label: string }) {
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
    </div>
  );
}

/** Wavefront delays (ms) for the 3×3 chevron. */
const PIXEL_DELAYS = [90, 0, 90, 180, 90, 180, 270, 180, 270];
