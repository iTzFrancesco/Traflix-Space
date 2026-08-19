export const VOICE_METER_BAR_COUNT = 14;

const MIN_BAR_SCALE = 0.12;

/**
 * Make the calibrated microphone level feel responsive without saturating the
 * meter. This is the same sub-linear presentation curve used by Traflix Voice.
 */
export function responsiveVoiceLevel(level: number): number {
  const normalized = Number.isFinite(level)
    ? Math.min(1, Math.max(0, level))
    : 0;
  if (normalized === 0) return 0;
  return Math.min(1, Math.pow(normalized, 0.68) * 1.12);
}

/** Return the animated scale for one bar in the voice meter. */
export function voiceMeterBarScale(
  level: number,
  index: number,
  phase: number,
): number {
  const safeIndex = Math.min(
    VOICE_METER_BAR_COUNT - 1,
    Math.max(0, Math.floor(index)),
  );
  const center = (VOICE_METER_BAR_COUNT - 1) / 2;
  const distance = Math.abs(safeIndex - center) / center;
  const bellFactor = 1 - distance * 0.5;
  const motion = 0.6 + 0.4 * ((Math.sin(phase + safeIndex * 0.73) + 1) / 2);
  const scale =
    MIN_BAR_SCALE +
    responsiveVoiceLevel(level) * (1 - MIN_BAR_SCALE) * bellFactor * motion;

  return Math.min(1, Math.max(MIN_BAR_SCALE, scale));
}
