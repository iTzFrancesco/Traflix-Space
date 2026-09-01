# Voice Latency

This document describes the latency boundaries of the voice path. It is an
engineering guide, not a claim of a fixed end-to-end time: microphone devices,
network conditions, provider load, and Windows audio scheduling all affect the
observed result.

## Critical path

```text
capture -> stop/endpoint -> transcription -> transcript review
        -> App Server turn -> response stream -> TTS synthesis -> playback
```

The path is intentionally split at transcript review. A voice recording does
not become an agent turn until the user confirms submission.

## Implemented safeguards

- Capture and TTS sessions expose explicit start, stop, and cancellation states.
- Provider requests use bounded lifecycle handling and sanitized error messages.
- App Server events are normalized before they reach the React state layer.
- TTS can consume streamed response text while preserving cancellation.
- Voice settings are normalized to bounded duration and endpoint values.
- Generated TTS sidecars are built on demand instead of stored in source control.

## Measurement guidance

When investigating a regression, record timestamps for capture start, capture
stop, provider request, transcript arrival, turn start, first response token,
TTS start, and first audible output. Compare the individual segments before
optimizing the complete path. Do not include credentials, transcripts, or
personal filesystem paths in the report.

Use the static regression suite for repeatable lifecycle checks:

```powershell
npm run test:jarvis
```

Performance measurements should be collected on the target Windows machine and
reported with the provider, model, audio device class, and network conditions
without revealing account identifiers or secret values.
