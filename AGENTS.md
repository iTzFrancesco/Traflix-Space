# Traflix Space — Agent guide

Windows-only Tauri 2.0 desktop app (React 19 + Rust). Agentic Development Environment with workspaces, terminals (ConPTY), and AI agent integration.

## Commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Vite dev server on port **1420** (HMR: 1421 if `TAURI_DEV_HOST` set) |
| `npm run build` | `tsc && vite build` — **typecheck before build** |
| `npm run tauri` | `tauri` CLI (pass subcommands: `dev`, `build`, etc.) |
| `npm run preview` | Vite preview of built frontend |

Tauri's own `beforeDevCommand` / `beforeBuildCommand` run these automatically.

## Architecture

- **Frontend** (`src/`): React 19, Zustand 5 with `persist` (localStorage), xterm.js 5.3 (WebGL + Fit), Tailwind CSS v4 (CSS-first `@theme` in `globals.css` — **no** `tailwind.config.ts`)
- **Backend** (`src-tauri/src/`): Rust, Tauri 2, `windows` crate (direct Win32/ConPTY — not `portable-pty`)
- **IPC**: Tauri `invoke` commands + `pty-output` event (base64 terminal output)
- **Styling**: Tailwind v4 `@theme` tokens in `src/styles/globals.css` (orange primary `#e85d04`, dark surfaces). Fonts loaded from **Google Fonts CDN** in `index.html` (Syne, Poppins, JetBrains Mono); `public/fonts/` is empty.
- **Window**: 1400×900, min 900×600, no decorations, dark theme, centered
- **Bundle**: MSI + NSIS targets, `embedBootstrapper` webview

## IPC commands (registered in `main.rs`)

| Module | Commands |
|--------|----------|
| Workspace | `create_workspace`, `get_workspaces`, `get_workspace`, `update_workspace`, `delete_workspace`, `select_folder` |
| PTY | `create_pty`, `write_pty`, `resize_pty`, `kill_pty`, `get_terminal_info` |
| Agent | `list_agents`, `launch_agent`, `kill_agent`, `get_agent_status` |
| Settings | `get_settings`, `set_settings`, `get_api_keys`, `set_api_key`, `remove_api_key` |

## State management

- `workspaceStore` (Zustand + persist): workspace CRUD, grid layout
- `terminalStore` (Zustand): terminal lifecycle, active terminal
- `uiStore` (Zustand): sidebar state, modals, wizard step

## Conventions & quirks

- **TypeScript strict**: `noUnusedLocals`, `noUnusedParameters` — fix or prefix with `_`
- **No linting configured**: no ESLint, no Prettier config
- **No testing configured**: no test runner, no test files — don't run tests
- **No CI/CD**: no GitHub workflows
- **Vite watch** ignores `src-tauri/**` — restart Tauri after Rust changes
- **Tailwind v4**: use `@theme` in CSS files, not `tailwind.config.ts`. Import `globals.css` at entrypoint (`main.tsx`).

## Notable files

- `TRAFLIX_SPACE_PROGETTO.md` — full project spec (Italian, 1232 lines)
- `src/lib/agents.ts` — frontend agent definitions (Aider, OpenCode, Claude Code, Custom)
- `src/lib/presets.ts` — 6 workspace presets
- `src-tauri/src/pty/windows.rs` — ConPTY native bindings
- `src-tauri/src/agent/launcher.rs` — agent launcher (writes command + API keys to PTY)
- `src-tauri/src/settings/store.rs` — settings persistence (JSON file) + API key storage
- `src/components/layout/SettingsModal.tsx` — API key management UI
