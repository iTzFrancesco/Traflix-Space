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

## Workspace project tree

The hierarchical view of files and directories rooted at a workspace's
`rootPath`. It is independent of any terminal's current working directory: a
terminal may `cd` into a subdirectory without changing the project tree root.

## Git repository

The Git working tree discovered from a workspace root. Its repository root may
be the workspace root or an ancestor, so the UI must keep workspace-relative
paths distinct from repository-relative Git paths.

## File change status

The Git state associated with a file, keeping the index (staged) state and the
working-tree (unstaged) state separate. A file can have both at the same time;
the UI may aggregate them visually but must not discard that distinction.

## Agent turn

One cycle in which an agent processes a user submission and returns a response
or an actionable waiting state. An agent session may contain many turns.

## Agent session

The lifetime of an agent process and its conversation context. It can remain
alive after an agent turn completes and wait for another user submission.

## Agent completion notification

A signal that an agent turn has reached a stable waiting boundary and Traflix
Space can mark that terminal as needing the user's attention. It is distinct
from closing the shell or PTY, and it must be correlated to the owning
terminal rather than inferred from terminal output alone.
