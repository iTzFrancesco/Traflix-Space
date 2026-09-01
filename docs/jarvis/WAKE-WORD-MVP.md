# Wake-Word MVP

Wake-word activation is currently a reserved extension point rather than the
default capture mode. Traflix Space uses deliberate click-to-toggle capture so
that microphone use and transcript submission remain visible to the user.

## Current behavior

- The persisted settings shape retains a wake-word phrase and sensitivity for
  forward compatibility.
- The runtime default is wake-word disabled.
- No wake-word model, audio sample set, or generated detector asset is bundled
  with the repository.
- The voice session starts only after an explicit user action.

## Future adapter contract

A detector can be introduced behind a small adapter with the following
responsibilities:

1. Request microphone access only after an explicit consent flow.
2. Keep detection local unless a separate feature explicitly requires network
   processing.
3. Emit a debounced activation event with the configured phrase and sensitivity.
4. Stop monitoring when the window is hidden, the session is cancelled, or the
   user disables the feature.
5. Keep detector failures isolated from normal click-to-toggle capture.

The adapter must not submit audio, create an App Server turn, or invoke a
dynamic tool by itself. Those transitions remain owned by the voice session and
the Rust backend.

## Validation requirements

Before enabling a detector by default, validate false activations, missed
activations, background-window behavior, microphone indicators, cancellation,
and resource cleanup on supported Windows versions. The model and its license
must be documented separately before distribution.
