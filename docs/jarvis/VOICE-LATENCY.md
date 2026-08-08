# Jarvis voice latency

## Scope

This document records latency work in Traflix Space's Jarvis voice path. It is
informed by the measured optimization cycle in the private Traflix Voice
project, but it does **not** copy Traflix Voice benchmark numbers as Traflix
Space results. Space uses a different capture/runtime stack (Rust + CPAL +
Tauri + reqwest + Edge TTS), so final measurements must be collected on the
real Windows app.

Critical path:

`user stops speaking -> CPAL capture closes -> audio preparation -> Groq STT -> Jarvis -> Edge TTS -> Rodio playback`

The product goal is perceptual immediacy while preserving the Phase 6/7/8
safety and workspace/session semantics.

## Traflix Voice findings used as evidence

Traflix Voice's documented latency cycle showed that the largest repeatable
local wins came from removing work from the stop path rather than changing the
Whisper model itself. The relevant ideas were:

- wake/stop capture immediately instead of waiting for polling;
- avoid recording-sized copies during shutdown;
- keep audio mono/float32 and use small/lightweight capture work;
- trim only leading/trailing silence before cloud upload;
- never send fully silent audio to Groq;
- encode PCM/WAV directly with fewer intermediate allocations;
- reuse the cloud HTTP client/keep-alive connection;
- construct the stable multipart envelope directly;
- use Groq's plain-text success response when only text is needed;
- keep workers/processes warm instead of paying startup per turn;
- move UI/persistence/non-essential work away from the latency-critical path;
- keep visual metering throttled and independent from submitted audio.

Traflix Voice also tested and rejected several micro-optimizations when they
did not improve repeatable measurements. Space should follow the same rule:
prefer measured wins over complexity.

## Implemented in Traflix Space

### Capture stop path

`src-tauri/src/jarvis/voice/capture.rs`

- CPAL already stops through a direct channel; there is no 50 ms polling loop
  to remove.
- After the stream is stopped and the capture thread is joined, the captured
  `Vec<f32>` is moved out with `mem::take` instead of cloned.
- VAD pre-roll is moved into the recording without an intermediate collected
  vector.

### Audio preparation

`src-tauri/src/jarvis/voice/audio.rs`

- Mono input does not allocate another mono copy.
- 16 kHz input does not allocate another resample copy.
- Leading/trailing silence is trimmed with a quiet-speech-safe edge threshold
  (`0.003`) and 160 ms padding.
- Completely silent input becomes `AudioTooShort` and never reaches Groq.
- PCM16 bytes are written directly into the final WAV allocation instead of an
  intermediate PCM byte vector followed by another copy.

The generic stereo and sample-rate conversion paths remain intact for hardware
that needs them.

### Groq STT transport

`src-tauri/src/jarvis/voice/stt.rs`

- One runtime provider/client is cached per current API key.
- reqwest's connection pool can therefore reuse an idle Groq connection across
  turns.
- Multipart is built directly into one bounded allocation.
- Language is bounded before entering the multipart body.
- `response_format=text` avoids JSON parsing on the success path.
- The response body remains bounded and cancellation-aware.

No network warm-up request is fired at startup: prewarming must not consume API
calls just to establish DNS/TLS. The first real Groq request can therefore
still include network cold-start cost.

### Edge TTS synthesis

`scripts/jarvis-edge-tts.py`
`src-tauri/src/jarvis/voice/tts.rs`

- The helper protocol is persistent: one JSON request per line, one JSON result
  per line.
- The Python/PyInstaller process stays alive between spoken replies.
- `edge_tts` is imported once and cached in the helper.
- Rust owns one shared, serialized helper worker and retries once after a broken
  worker.
- Cancellation terminates an in-flight helper; the next request can recreate
  it cleanly.
- A background `ping` prewarms the helper at Traflix Space startup.
- The helper is stopped on real app exit.

The checked-in release sidecar executable must be rebuilt from the updated
Python helper before release/MSI latency testing. `tauri dev` uses the Python
helper source directly.

### Windows playback

`src-tauri/src/jarvis/voice/playback.rs`

- A dedicated playback thread keeps Rodio's Windows `OutputStream` open between
  replies.
- Each reply gets a fresh `Sink`, but the output device is not reopened for
  every short Jarvis sentence.
- Cancellation remains polled while playback is active.

## Deliberately not copied blindly

- Traflix Voice's fixed 512-sample PortAudio block size is not forced onto
  Space's CPAL configuration. Windows devices expose different native sample
  rates/buffer capabilities; a hard-coded CPAL buffer can regress compatibility
  without measured device-specific evidence.
- HTTP/2 and other transport flags that did not produce repeatable gains in
  Traflix Voice are not added merely for appearance.
- Space keeps its domain prompt for agent/tool vocabulary. Removing it may save
  tiny multipart bytes but can reduce recognition quality for `Codex`,
  `OpenCode`, `ConPTY`, etc.
- TTS is not changed to a streaming audio architecture in this pass. Persistent
  synthesis + warm playback removes the obvious local cold starts while
  keeping the existing bounded temp-file validation and cancellation model.

## Required Windows measurements

Do not mark this section PASS without real output from the Windows machine.
Measure at minimum:

1. click/voice end -> backend enters `Transcribing`;
2. capture stop -> Groq request dispatch;
3. Groq request -> transcript ready;
4. Jarvis response ready -> TTS synthesis begins;
5. TTS synthesis begins -> first audible playback;
6. first TTS reply after app startup vs subsequent replies;
7. short command, quiet command, long command, fully silent capture;
8. repeated 10-turn conversation to verify worker/client reuse;
9. cancellation/barge-in during synthesis and playback;
10. microphone/device variants used on the actual Windows machine.

Until those measurements are run, the correct status is: **low-latency paths
implemented and statically reviewed; real Windows latency validation pending**.
