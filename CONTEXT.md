# Ubiquitous Language

## Terminal scroll position

The per-terminal viewport position in xterm's scrollback buffer. It is either
following the live bottom or reviewing history. Switching panes, changing the
grid layout, rehydrating a kept-alive PTY, and receiving streamed output must
not turn a reviewing viewport into either the live bottom or the oldest line.
The exception is an active terminal command: its viewport always follows live
output until the shell renders the next prompt.

## Follow mode

The terminal state in which the viewport follows new output at the live bottom.
It ends as soon as the user scrolls away from the bottom and resumes only when
the user explicitly returns to the bottom, unless a terminal command is active.
