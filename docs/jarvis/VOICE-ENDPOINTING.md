# Voice Endpointing

Voice endpointing determines when a captured utterance is ready for
transcription. The implementation keeps the capture contract explicit and
retains bounded settings for compatibility with previously persisted
configuration.

## Current interaction

The default flow is click-to-toggle:

1. The user starts capture deliberately.
2. Audio remains local to the active capture session until the user stops it.
3. The resulting recording is sent to the configured transcription provider.
4. The transcript is presented for review and is not submitted automatically.

Wake-word activation, automatic VAD submission, and automatic transcript
submission are disabled by default. This makes the network boundary visible to
the user and avoids accidental turns.

## Bounded timing values

The settings layer normalizes persisted values before use:

| Setting | Default | Allowed behavior |
| --- | ---: | --- |
| Maximum recording duration | 600 s | Clamped to a positive value up to 600 s |
| VAD candidate window | 650 ms | Never less than 650 ms |
| Post-speech VAD window | up to 5,000 ms | Clamped to the supported range |
| Endpoint grace period | 900 ms | Clamped between 500 ms and 5,000 ms |

Legacy values are migrated at the settings boundary so they cannot silently
restore an excessively long or unexpectedly short interaction. The values above
describe the normalization contract, not a guarantee of equal recognition
quality across microphones or providers.

## Implementation notes

Endpointing state belongs to the voice session. Start, stop, cancel, and discard
must be idempotent from the user's perspective, and a late provider response
must not create a new turn after cancellation. UI indicators should reflect the
backend state rather than infer completion from a timer alone.

For protocol details, see the [Codex App Server protocol](codex/PROTOCOL.md).
