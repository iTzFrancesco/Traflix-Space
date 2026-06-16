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
- **Backend** (`src-tauri/src/`): Rust, Tauri 2, `tauri-plugin-pty` v0.3.0 (based on `portable-pty`)
- **IPC**: Tauri `invoke` commands + `tauri-pty` plugin (`spawn`, `onData`, `onExit`, `resize`, `kill`)
- **Styling**: Tailwind v4 `@theme` tokens in `src/styles/globals.css` (orange primary `#e85d04`, dark surfaces). Fonts loaded from **Google Fonts CDN** in `index.html` (Syne, Poppins, JetBrains Mono); `public/fonts/` is empty.
- **Window**: 1400×900, min 900×600, no decorations, dark theme, centered
- **Bundle**: MSI + NSIS targets, `embedBootstrapper` webview

## IPC commands (registered in `main.rs`)

| Module | Commands |
|--------|----------|
| Workspace | `create_workspace`, `get_workspaces`, `get_workspace`, `update_workspace`, `delete_workspace`, `select_folder` |

PTY is managed via `tauri-plugin-pty` — no custom IPC commands.

## State management

- `workspaceStore` (Zustand + persist): workspace CRUD, grid layout. Uses `partialize` to persist only `workspaces` + `activeWorkspaceId`.
- `terminalStore` (Zustand): terminal lifecycle, active terminal. No `outputBuffer` — terminal output goes directly PTY → xterm.js via `tauri-pty`.
- `uiStore` (Zustand): sidebar state, modals, wizard open state (`wizardOpen`/`setWizardOpen`)
- `presetStore` (Zustand + persist): workspace presets. Uses `partialize` to persist only `presets`.

## Performance patterns

- **Zustand selectors**: Always use individual selectors (`useStore((s) => s.field)`) — never destructure entire stores
- **`useTerminalStore.getState()`**: Use for imperative actions in callbacks (avoids subscription)
- **`React.memo`**: `TerminalPane` and `XTermWrapper` are memoized to prevent cascading re-renders
- **Inline styles**: Extracted as module-level constants (`ACTIVE_STYLE`, `INACTIVE_STYLE`, `CONTAINER_STYLE`) to avoid defeating memo
- **`useKeyboardShortcuts`**: Uses refs + subscribe pattern — handler registered once, reads fresh state from refs
- **`invokeWithTimeout`**: Wraps all Tauri `invoke` calls with configurable timeouts (see `src/lib/timeout.ts`)
- **Batch terminal init**: `XTermWrapper` uses configurable batch timing per terminal count (4/6/8 terminals)

## Conventions & quirks

- **TypeScript strict**: `noUnusedLocals`, `noUnusedParameters` — fix or prefix with `_`
- **No linting configured**: no ESLint, no Prettier config
- **No testing configured**: no test runner, no test files — don't run tests
- **No CI/CD**: no GitHub workflows
- **Vite watch** ignores `src-tauri/**` — restart Tauri after Rust changes
- **Tailwind v4**: use `@theme` in CSS files, not `tailwind.config.ts`. Import `globals.css` at entrypoint (`main.tsx`).

## Notable files

- `TRAFLIX_SPACE_PROGETTO.md` — full project spec (Italian, 1232 lines)
- `src/lib/agents.ts` — frontend agent definitions (OpenCode, Claude Code, Gemini, Codex, Anti-Gravity)
- `src/lib/presets.ts` — workspace presets + `computeLayout` (max 2x4 grid)
- `src/lib/timeout.ts` — `invokeWithTimeout` utility for Tauri IPC calls
- `src-tauri/capabilities/default.json` — permissions including `"pty:default"`
- `src/components/terminal/XTermWrapper.tsx` — terminal component with batch init, retry, React.memo
- `src/components/workspace/TerminalPane.tsx` — terminal pane with memo, agent launch via `pty.write()`
- `src/stores/terminalStore.ts` — terminal state (no outputBuffer, optimized setActiveTerminal)
- `src/stores/workspaceStore.ts` — workspace state with partialize persist
