import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type VoiceState = "idle" | "recording" | "processing";

type VoiceBridgeEvent = {
  type?: string;
  state?: VoiceState;
  value?: number;
};

export function VoiceWidget() {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<VoiceState>("idle");
  const [volume, setVolume] = useState(0);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    listen<string>("voice-bridge-event", (event) => {
      if (disposed) return;

      try {
        const payload = JSON.parse(event.payload) as VoiceBridgeEvent;
        if (payload.type === "disconnected") {
          setConnected(false);
          return;
        }
        setConnected(true);

        if (payload.type === "state" && payload.state) {
          setState(payload.state);
          if (payload.state !== "recording") setVolume(0);
        }
        if (payload.type === "volume") {
          setVolume(Math.max(0, Math.min(100, payload.value ?? 0)));
        }
      } catch {
        // The bridge is best-effort and ignores malformed messages.
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const bars = useMemo(() => {
    const normalized = volume / 100;
    return Array.from({ length: 14 }, (_, index) => {
      const distance = Math.abs(index - 7) / 7;
      const height = state === "recording"
        ? 3 + normalized * 20 * (1 - distance * 0.5)
        : 3;
      return `${Math.max(3, Math.min(23, height))}px`;
    });
  }, [state, volume]);

  if (!connected) return null;

  const openVoice = () => {
    void invoke("voice_bridge_command", {
      command: JSON.stringify({ type: "show_main" }),
    }).catch(() => setConnected(false));
  };

  const isRecording = state === "recording";
  const isProcessing = state === "processing";

  return (
    <div
      className="absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={openVoice}
      title="Doppio clic per aprire Traflix Voice"
      role="button"
      tabIndex={0}
      aria-label="Traflix Voice. Doppio clic per aprire la console"
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openVoice();
        }
      }}
    >
      <div
        className={`flex h-[38px] items-center gap-1 rounded-xl border px-2 ${
          isRecording
            ? "border-primary shadow-[0_0_12px_rgba(255,140,0,.12)]"
            : "border-primary/40"
        } bg-[#121311]/95 transition-all`}
      >
        <img
          src="/icon.png"
          alt="Traflix Voice"
          draggable={false}
          className="h-[26px] w-[26px] rounded-md"
        />

        {isProcessing ? (
          <span className="mx-1 h-4 w-4 animate-spin rounded-full border-2 border-transparent border-r-primary border-t-primary" />
        ) : isRecording ? (
          <span className="flex h-6 w-[80px] items-center justify-center gap-[2px]">
            {bars.map((height, index) => (
              <span
                key={index}
                className="w-[2.5px] rounded-sm bg-primary shadow-[0_0_4px_rgba(255,140,0,.35)]"
                style={{ height }}
              />
            ))}
          </span>
        ) : (
          <span className="whitespace-nowrap px-1 text-[.82rem] font-extrabold tracking-[.3px] text-primary">
            Traflix Voice
          </span>
        )}
      </div>
    </div>
  );
}
