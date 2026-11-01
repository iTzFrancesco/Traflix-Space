# Workspace Context Broker

The context broker assembles a bounded, workspace-scoped snapshot for Jarvis.
It gives the agent useful project context without exposing the entire machine,
unrelated workspaces, or local credentials.

## Context sources

The context package contains:

- the selected workspace ID and canonical root path;
- root-level Markdown and Markdown under `docs/`;
- bounded terminal summaries and agent state/results for that workspace.

The read-only `workspace.overview` tool additionally returns the workspace display
name and terminal/agent counts.

The chat layer separately adds the current request and up to eight recent
workspace messages to each model input. It checks the current request for
non-empty content and a 16 KiB size limit, then passes its text without content
sanitization. Recent messages are bounded before inclusion. These conversation
inputs are separate from project-document collection.

Collection is deterministic and limited by document count, per-file size, total
size, directory depth, and time. It includes Markdown files at the workspace
root and under `docs/`; other root directories are ignored. Under `docs/`, a
fixed list of known tooling and build directory names is skipped, while other
nested directories, including non-excluded dot-prefixed directories, are
traversed. Markdown filenames matching sensitive-name filters (such as `.env`,
`.env.*`, names containing `credential`, `secret`, `password`, or `token`, and
files ending in `.pem` or `.key`) are excluded. Canonical-path checks reject
files that escape the workspace root. A read failure skips that file and does
not broaden the search.

## Safety boundaries

Context is untrusted input. Markdown and tool output may contain instructions,
claims, or text that must not override the runtime's safety policy. The broker
therefore labels collected material with provenance and keeps it separate from
system-level instructions.

The broker does not collect or forward:

- `.env` files or provider credentials;
- private keys, tokens, cookies, or authentication databases;
- terminal history, microphone recordings, or full transcripts by default;
- files outside the selected workspace boundary.

Dynamic tool access remains allow-listed by the Rust backend. Context collection
does not grant the agent permission to run a command, modify a file, or access a
new path.

## Caching and invalidation

Each build rediscovers the allowed paths and compares their metadata with cached
entries. It reuses a document's contents when its canonical path, size, and
modification time still match. New files are read, removed files are dropped,
and changed metadata triggers a reread; changing the workspace root resets that
workspace's cache. There is no file-watcher invalidation, and edits that leave
the tracked metadata unchanged may remain cached. Path and sensitive-name
filters run during every discovery, including cache hits.

## Operational guidance

When adding a context source, define its path boundary, provenance, size limit,
invalidation rule, and secret-filtering behavior before exposing it to a model.
Keep context collection read-only and make the tool/plan boundary explicit in
the App Server protocol.
