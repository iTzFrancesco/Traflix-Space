# Ubiquitous Language

## Terminal scroll position

The per-terminal viewport position in xterm's scrollback buffer. It is either
following the live bottom or reviewing history. Switching panes, changing the
grid layout, rehydrating a kept-alive PTY, and receiving streamed output must
not turn a reviewing viewport into either the live bottom or the oldest line.
An active terminal command may keep following live output, but the user can
pause follow mode at any time by scrolling into history.

## Follow mode

The terminal state in which the viewport follows new output at the live bottom.
It ends as soon as the user scrolls away from the bottom and resumes only when
the user explicitly returns to the bottom, including while a terminal command
is active.
