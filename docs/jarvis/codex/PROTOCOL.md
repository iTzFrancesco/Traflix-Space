# Codex App Server Protocol

This document records the protocol contract implemented by the current Jarvis
adapter. The adapter parses defensively because some payload details vary
between Codex CLI releases.

## Runtime handshake

The process starts `codex app-server` over standard input and output. The
backend sends `initialize`, waits for the response, and then sends
`initialized`. Runtime failures are mapped to stable application error classes:

- executable not found;
- process start or handshake failure;
- runtime crash or unavailable state;
- JSON-RPC failure;
- runtime environment failure.

The executable version is diagnostic metadata. Compatibility is established by
the live handshake and the RPC methods that are actually available.

## Threads and turns

- `thread/start` uses a workspace-isolated working directory, a read-only
  sandbox, no automatic approval, and an ephemeral thread.
- One thread is created lazily for each workspace and application session.
- `turn/start` receives an array such as:

  ```json
  {"input":[{"type":"text","text":"Inspect the current workspace"}]}
  ```

- Turn parameters are always sent in the request, including the configured
  reasoning effort.
- `turn/steer` is accepted only while the referenced turn is active and its
  text is bounded.
- `turn/interrupt` is idempotent; interrupting an already completed turn is a
  no-op.

## Notifications

The adapter handles runtime, item, message-delta, and turn notifications. Item
types include dynamic tool calls, agent messages, and reasoning. The UI receives
completed agent messages and normalized lifecycle events; reasoning is always
discarded and is never spoken.

The final response is the last completed agent message before
`turn/completed`. The protocol does not rely on a `phase` field in a message
delta.

## Dynamic tool requests

Server requests carry separate namespace and tool fields. A representative
request is:

```json
{
  "callId": "call-1",
  "namespace": "terminal",
  "tool": "list",
  "arguments": {},
  "threadId": "thread-1",
  "turnId": "turn-1"
}
```

The response uses the App Server input-text content shape:

```json
{"content":[{"type":"inputText","text":"..."}]}
```

Unknown tools are answered with JSON-RPC `-32601` rather than leaving the
server waiting. Decode failures use `-32602`. Host validation errors use a
stable application error code and include no secret material.

Read-only tools are:

- `workspace.overview`;
- `terminal.list`;
- `agent.list`;
- `agent.status`;
- `agent.last_result`;
- `agent.activity`;
- `agent.tail`;
- `markdown.read`;
- `ui.open_terminal`.

`conversational.plan` is separately validated. It supports only the operations
defined by the host schema, is limited to one accepted plan per turn, and
returns a receipt in the same turn.

## Stream normalization

The backend converts raw notifications to `jarvis://chat-stream` events for
the React client. The normalized stream distinguishes commentary, tool start,
tool completion, final text, turn completion, failure, and interruption. Event
payloads are bounded and do not include OAuth tokens, API keys, or raw model
reasoning.
