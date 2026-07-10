> **⚠️ IMPORTANTE:** Non leggere mai il file `.env` di questo progetto. Contiene chiavi API e segreti. **Don't read .env**  
> **⚠️ IMPORTANTE:** Non fare **push su GitHub** senza che l'utente abbia esplicitamente approvato. Mai push automatici. **No push without user approval**

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

- **Frontend** (`src/`): React 19, Zustand 5 with `persist` (localStorage), xterm.js 5.3 (per-pane instances — each `TerminalPane` creates its own `Terminal` + `FitAddon`), Tailwind CSS v4
- **Backend** (`src-tauri/src/`): Rust, Tauri 2, `portable-pty` v0.8 for PTY management, `tauri-plugin-clipboard-manager` v2
- **IPC**: Tauri `invoke` commands for terminal lifecycle (`terminal_spawn`, `terminal_write`, `terminal_resize`, `terminal_kill`, `terminal_set_active`, `terminal_get_snapshot`, `terminal_get_scrollback`) + `tauri-plugin-clipboard-manager` (`readText`, `readImage`). PTY output streamed via `terminal-output` events (filtered by terminalId in frontend).
- **PTY Architecture**: Each terminal gets its own PTY session in Rust (saved in `DashMap<String, Arc<RwLock<TerminalSession>>>`). Each session runs a `spawn_blocking` reader thread that parses output through `vt100` parser and emits `terminal-output` events. FrameScheduler (per-terminal via `CancellationToken`) emits `terminal-frame` diffs for inactive terminals.
- **Styling**: Tailwind v4 `@theme` tokens in `src/styles/globals.css` (orange primary `#e85d04`, dark surfaces). Fonts loaded from **Google Fonts CDN** in `index.html` (Syne, Poppins, JetBrains Mono); `public/fonts/` is empty.
- **Window**: 1400×900, min 900×600, no decorations, dark theme, centered
- **Bundle**: MSI + NSIS targets, `embedBootstrapper` webview

## IPC commands (registered in `main.rs`)

| Module | Commands |
|--------|----------|
| Workspace | `create_workspace`, `get_workspaces`, `get_workspace`, `update_workspace`, `delete_workspace`, `select_folder` |
| Terminal | `terminal_spawn`, `terminal_write`, `terminal_resize`, `terminal_kill`, `terminal_set_active`, `terminal_get_snapshot`, `terminal_get_scrollback` |

## State management

- `workspaceStore` (Zustand + persist): workspace CRUD, grid layout. Uses `partialize` to persist only `workspaces` + `activeWorkspaceId`.
- `terminalStore` (Zustand): terminal lifecycle using `Record<string, TerminalState>` (not `Map`). Active terminal tracking. Output goes PTY → `terminal-output` event → frontend listener.
- `uiStore` (Zustand): sidebar state, modals, wizard open state (`wizardOpen`/`setWizardOpen`)
- `presetStore` (Zustand + persist): workspace presets. Uses `partialize` to persist only `presets`.

## Performance patterns

- **Zustand selectors**: Always use individual selectors (`useStore((s) => s.field)`) — never destructure entire stores
- **`useTerminalStore.getState()`**: Use for imperative actions in callbacks (avoids subscription)
- **Per-pane xterm.js**: Each `TerminalPane` creates its own `Terminal` + `FitAddon` on mount. No shared pool, no attach/detach cycle. Xterm is disposed on unmount.
- **`React.memo`**: `TerminalPane` is memoized. Snapshots are cached — inactive panes show `<canvas>` via `TerminalSnapshot`.
- **Inline styles**: Extracted as module-level constants (`ACTIVE_STYLE`, `INACTIVE_STYLE`, `CONTAINER_STYLE`) to avoid defeating memo
- **`useKeyboardShortcuts`**: Uses refs + subscribe pattern — handler registered once, reads fresh state from refs
- **`invokeWithTimeout`**: Wraps all Tauri `invoke` calls with configurable timeouts (see `src/lib/timeout.ts`)
- **PTY keep-alive**: Workspace switch does NOT kill PTY sessions. Only `loadedMap` cache is updated — Rust sessions stay alive.
- **Scheduler cancellation**: `FrameScheduler` uses `CancellationToken` per terminal — no task leaks on terminal switch.

## Conventions & quirks

- **TypeScript strict**: `noUnusedLocals`, `noUnusedParameters` — fix or prefix with `_`
- **No linting configured**: no ESLint, no Prettier config
- **No testing configured**: no test runner, no test files — don't run tests
- **No CI/CD**: no GitHub workflows
- **Vite watch** ignores `src-tauri/**` — restart Tauri after Rust changes
- **Tailwind v4**: use `@theme` in CSS files, not `tailwind.config.ts`. Import `globals.css` at entrypoint (`main.tsx`).
- **No auto prod build**: Agents must NOT run `npm run build`, `npm run tauri build`, or any production build automatically. Only the user can request a build.

## Notable files

- `TRAFLIX_SPACE_PROGETTO.md` — full project spec (Italian, 1232 lines)
- `src/lib/agents.ts` — frontend agent definitions (OpenCode, Claude Code, Gemini, Codex, Anti-Gravity)
- `src/lib/presets.ts` — workspace presets + `computeLayout` (max 2x4 grid)
- `src/lib/timeout.ts` — `invokeWithTimeout` utility for Tauri IPC calls
- `src-tauri/capabilities/default.json` — permissions including `"pty:default"`, `"clipboard-manager:allow-read-text"`, `"clipboard-manager:allow-read-image"`
- `src/components/terminal/XTermWrapper.tsx` — terminal component with batch init, retry, React.memo, clipboard paste via Tauri API (text + image), drag-and-drop handlers
- `src/main.tsx` — entry point, contextmenu filter, global drag/drop prevention for WebView2
- `src/components/workspace/TerminalPane.tsx` — terminal pane with memo, agent launch via `pty.write()`
- `src/stores/terminalStore.ts` — terminal state (no outputBuffer, optimized setActiveTerminal)
- `src/stores/workspaceStore.ts` — workspace state with partialize persist
- `src/lib/presets.ts` — `computeLayout` (max 2x4 grid) + `QUICK_COUNTS`
- `src/lib/agents.ts` — agent definitions (Gemini, OpenCode, Claude, etc.)
- `src/lib/timeout.ts` — `invokeWithTimeout` utility
- `src/lib/agentLauncher.ts` — `AgentLaunchQueue` for batch agent command writes
