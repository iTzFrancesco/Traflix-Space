# Workspace Context Broker

The context broker assembles a bounded, workspace-scoped snapshot for Jarvis.
It gives the agent useful project context without exposing the entire machine,
unrelated workspaces, or local credentials.

## Context sources

The public context surface is intentionally small:

- the selected workspace root and its display name;
- shallow Markdown and documentation files within that workspace;
- bounded metadata needed to explain the current workspace state;
- the active conversation's sanitized task and relevant tool results.

File collection is deterministic and size-limited. Hidden directories,
dependency trees, build output, generated files, environment files, credential
stores, and unrelated parent directories are excluded. A file that cannot be
read safely is skipped rather than elevated into a broader search.

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

Snapshots may be cached for the active workspace to avoid repeated disk scans.
The cache is bounded and invalidated when the workspace changes, when a new
turn requires fresher context, or when the relevant file watcher reports a
change. A cache hit must never bypass path validation or secret filtering.

## Operational guidance

When adding a context source, define its path boundary, provenance, size limit,
invalidation rule, and secret-filtering behavior before exposing it to a model.
Keep context collection read-only and make the tool/plan boundary explicit in
the App Server protocol.
