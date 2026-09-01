# Traflix Space

Traflix Space is a Windows desktop workspace for running multiple software
projects and coding-agent sessions in one organized interface. Each workspace
binds a local project directory to one or more persistent terminal panes, so
users can switch projects without unnecessarily terminating their processes.

The application is designed for command-line tools such as OpenAI Codex, Claude
Code, Gemini, OpenCode, and other locally installed agents. It provides a
multi-pane terminal, workspace management, local state, file drag-and-drop,
clipboard integration, and optional Jarvis voice interaction.

## Features

- Multiple workspaces backed by local project directories.
- Up to eight terminal sessions per workspace, with resizable layouts and
  kept-alive PTY processes during workspace changes.
- Configurable agent launchers and provider-specific completion notifications.
- Scrollback restoration, bounded output handling, and explicit terminal
  lifecycle controls.
- Text, image, and file-path paste support through the Windows clipboard.
- Native Windows system-tray integration in release builds.
- Jarvis integration through Codex App Server, with workspace-scoped context,
  read-only dynamic tools, explicit conversational plans, streaming events, and
  optional voice input/output.

## Technology

Traflix Space is built with:

- React 19 and TypeScript for the user interface;
- Tauri 2 and Rust for the native desktop runtime and IPC commands;
- xterm.js and Windows ConPTY for terminal sessions;
- Zustand for local application state;
- Tailwind CSS for styling;
- CPAL, Groq Speech-to-Text, and Edge TTS for the optional voice pipeline.

Rust owns process supervision, filesystem boundaries, terminal lifecycle,
workspace persistence, and security-sensitive policy. React is a presentation
and IPC client layer.

## Requirements

- Windows 10 or Windows 11;
- Node.js 24 and npm;
- a stable Rust toolchain with Cargo;
- Microsoft Edge WebView2 Runtime;
- Python 3.12 when developing or packaging the optional Edge TTS helper;
- an installed and authenticated Codex CLI when using Jarvis through Codex App
  Server.

## Installation and development

Clone the repository and install the JavaScript dependencies:

```powershell
git clone https://github.com/iTzFrancesco/Traflix-Space.git
cd Traflix-Space
npm ci
```

Start the Tauri development application with:

```powershell
npm run tauri dev
```

The optional Groq voice provider can be configured from the application
settings. For local development, `.env.example` documents the supported
placeholder without containing a credential. Do not commit `.env` or any
populated environment file.

## Build and test

The frontend typecheck and production bundle can be generated with
`npm run build`. A Windows MSI build is produced by:

```powershell
npm run tauri build
```

The Windows build hook creates the Edge TTS sidecar from
`scripts/jarvis-edge-tts.py`; the generated executable is intentionally not
stored in source control.

Useful verification commands include:

```powershell
npm run test:strict
npm run test:jarvis
npm run test:terminal
npm run test:agent-notifications
```

The Codex App Server integration has a portable test suite and an optional
Windows-only live handshake test. See the [Jarvis documentation](docs/README.md)
for the current scope and validation notes.

## Architecture

```text
User
  │
  ├── React + TypeScript UI
  │       │ typed Tauri IPC/events
  │       ▼
  └── Rust/Tauri runtime
          ├── workspace registry and policy
          ├── ConPTY terminal manager
          ├── agent notification bridge
          ├── Jarvis context, tools, and Codex App Server adapter
          └── optional voice capture, Groq STT, and Edge TTS
```

The application stores workspace metadata and UI settings in the operating
system's application-data area rather than in the selected project directory.
Project files are accessed only as a result of an explicit user action or an
allow-listed Jarvis operation. Terminal processes run with the current user's
Windows permissions.

## Privacy and credentials

Local transcription and voice features are optional. When Groq Speech-to-Text
is enabled, recorded audio is sent to Groq and the provider's terms and privacy
policy apply. The Groq key is handled by the Rust backend and is not exposed to
the React state or written to the repository; provider credentials are removed
from ordinary terminal child-process environments.

Jarvis uses Codex App Server for its text model when enabled. Traflix Space does
not read, copy, or persist Codex OAuth tokens; the official Codex runtime owns
its authentication. Jarvis uses a dedicated runtime directory and exposes only
the tools and operations implemented by the host application.

Treat terminal output, project files, agent messages, and remote web content as
untrusted input. Do not paste credentials into prompts, commit secrets, or use
the application with a project whose contents you do not trust.

## Repository documentation

- [`AGENTS.md`](AGENTS.md) — public contributor and agent-development guidance;
- [`docs/README.md`](docs/README.md) — maintained technical documentation;
- [`scripts/agent-notifications/README.md`](scripts/agent-notifications/README.md)
  — provider notification adapters.

## Related projects

- [Traflix](https://traflix.it);
- [Traflix Voice](https://github.com/iTzFrancesco/Traflix-Voice), a Windows
  voice-dictation application with local-first Whisper support.

## License

Traflix Space is distributed under the [MIT License](LICENSE). The license
covers this project's original code and documentation. Third-party libraries,
models, services, trademarks, and bundled or generated dependencies remain
subject to their own licenses and terms.
