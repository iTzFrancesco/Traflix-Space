let audioContext: AudioContext | null = null;
let lastPlayedAt = 0;

/** Plays a short, unobtrusive two-note chime for an unfocused agent turn. */
export function playAgentCompletionChime() {
  if (typeof window === "undefined") return;

  const now = performance.now();
  if (now - lastPlayedAt < 180) return;
  lastPlayedAt = now;

  try {
    const AudioContextConstructor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextConstructor) return;

    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContextConstructor();
    }

    const context = audioContext;
    const play = () => {
      const start = context.currentTime + 0.015;
      const master = context.createGain();
      master.gain.setValueAtTime(0.0001, start);
      master.gain.exponentialRampToValueAtTime(0.16, start + 0.025);
      master.gain.exponentialRampToValueAtTime(0.0001, start + 0.42);
      master.connect(context.destination);

      for (const [frequency, offset, duration] of [
        [659.25, 0, 0.18],
        [783.99, 0.08, 0.28],
      ] as const) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, start + offset);
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(0.5, start + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(
          0.0001,
          start + offset + duration,
        );
        oscillator.connect(gain);
        gain.connect(master);
        oscillator.start(start + offset);
        oscillator.stop(start + offset + duration + 0.02);
      }
    };

    if (context.state === "suspended") {
      void context.resume().then(play).catch(() => {});
    } else {
      play();
    }
  } catch {
    // Audio is an optional attention aid; notification state remains reliable.
  }
}
