# Voice Troubleshooting

Traflix Space uses a browser microphone for capture, a configurable speech-to-
text provider, and an Edge TTS-compatible local sidecar for speech output. The
application can operate without a configured transcription key, but provider-
backed transcription requires a valid Groq credential.

## Before testing

1. Confirm that Windows grants microphone access to the application.
2. Select the intended input device in Windows and close applications that may
   exclusively hold it.
3. Start a click-to-toggle voice session and stop it explicitly after speaking.
4. Check the in-app status and error message before changing settings.

## Groq transcription errors

The expected key format is a Groq Speech-to-Text key beginning with `gsk_`.
xAI/Grok keys are not interchangeable with Groq keys. Configure the credential
through the application settings or a local `.env` file; never place a real
credential in `.env.example`, documentation, logs, or source control.

- `401` or authentication errors usually indicate an invalid, expired, or
  provider-mismatched key.
- Empty or very short transcripts can result from microphone permission,
  selected-device, input-level, or clipping problems.
- A request that does not finish should be cancelled from the UI before starting
  another capture session.

## Capture timing

The default interaction is explicit click-to-toggle capture. Automatic VAD,
wake-word activation, and automatic transcript submission are disabled by
default so that audio is not submitted without a deliberate user action. See
[Voice endpointing](../VOICE-ENDPOINTING.md) for the bounded legacy settings
retained for compatibility.

## Text-to-speech diagnostics

The TTS runtime is prepared by the Rust backend. If output is unavailable,
verify that the generated sidecar is available through the documented build
workflow and that Windows audio output is not muted. Generated binaries belong
in `src-tauri/binaries/` only as build output and must not be committed.

## Useful checks

Run the static Jarvis regression suite from the repository root:

```powershell
npm run test:jarvis
```

Do not include provider keys, transcripts, microphone recordings, or personal
paths in bug reports. Replace them with a short description and the relevant
sanitized status message.
