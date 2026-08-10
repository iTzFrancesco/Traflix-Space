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
| `npm run build:clean` | `tauri build` + `cargo sweep --stale` |
| `npm run version:patch` | Bump versione **patch** (`1.x.x` → `1.x.++`) |
| `npm run version:minor` | Bump versione **minor** (`1.x.x` → `1.++.0`) |
| `npm run version:major` | Bump versione **major** (`1.x.x` → `++.0.0`) |
| `npm run version:set <ver>` | Bump a versione esplicita (`npm run version:set 2.1.3`) |

Tauri's own `beforeDevCommand` / `beforeBuildCommand` run these automatically.

### Rust build cache

Cargo is configured by [`.cargo/config.toml`](.cargo/config.toml) to write build
artifacts to `D:\rust\target`. Do not override `CARGO_TARGET_DIR` to a path on
the system drive. The project-local `src-tauri\target` is legacy cache and can
be safely removed when not building.

To clean Rust artifacts, run `cargo clean` from `src-tauri`; the configured
target directory on `D:` is used automatically.

#### Cache policy (mandatory)

- **Keep `D:\rust` caches.** Do not delete, sweep, or recreate `D:\rust\target`,
  `D:\rust\cargo`, `D:\rust\rustup`, or `D:\rust\tauri-cache` during routine
  maintenance. They intentionally live on the secondary disk so future builds
  can reuse downloaded dependencies and compiled artifacts.
- **Keep the system disk clean.** When cleanup is explicitly requested, remove
  only project-local/generated caches on `C:` (for example
  `src-tauri\target`, `dist`, and temporary Vite output), after verifying the
  path. Never remove the active Rust toolchain or shared registries blindly.
- **Do not read `.env`.** This rule also applies while inspecting or cleaning
  the repository.

## Architecture

- **Frontend** (`src/`): React 19, Zustand 5 with `persist` (localStorage), xterm.js 5.3 (per-pane instances), Tailwind CSS v4 via PostCSS (`@tailwindcss/postcss` plugin), `@dnd-kit` for drag-and-drop, `framer-motion` for animations, `lucide-react` for icons
- **Backend** (`src-tauri/src/`): Rust modules — `workspace/`, `terminal_engine/`, `agent/`, `settings/`, `skills/`. Tauri 2 with `portable-pty` v0.8, `notify` for file watching, `tauri-plugin-clipboard-manager` for paste
- **Tailwind v4**: `@theme` tokens in `src/styles/globals.css`. No `tailwind.config.ts`. Plugins configured via `postcss.config.js`
- **Window**: 1400×900, min 900×600, no decorations, dark theme, centered, `dragDropEnabled: false`
- **Bundle**: MSI only (`["msi"]`), `embedBootstrapper` webview, `custom-protocol` feature
- **CSP**: `default-src 'self'; script-src 'self'; connect-src 'self' ipc://localhost; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; worker-src 'self' blob:; frame-src 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*`

## IPC commands (from `src-tauri/src/`)

| Module | Commands |
|--------|----------|
| workspace | `create_workspace`, `get_workspaces`, `get_workspace`, `update_workspace`, `delete_workspace`, `select_folder`, `navigate_folder`, `get_default_workspace_path` |
| terminal_engine | `terminal_spawn`, `terminal_write`, `terminal_resize`, `terminal_kill`, `terminal_reopen`, `terminal_set_active`, `terminal_get_snapshot`, `terminal_get_scrollback` |
| agent | `list_agents` |
| skills | `list_skills` |
| settings | `get_settings`, `set_settings` |

## State management (Zustand stores)

- `workspaceStore` (Zustand + persist): workspace CRUD, grid layout. `partialize` persists only `workspaces` + `activeWorkspaceId`.
- `terminalStore` (Zustand): terminal lifecycle using `Record<string, TerminalState>`. `setActiveTerminal` optimized — no full state rebuild.
- `uiStore` (Zustand): sidebar, modals, `wizardOpen`.
- `presetStore` (Zustand + persist): workspace presets. `partialize` persists only `presets`.
- `skillStore` (Zustand + persist): skills from disk scan, favorites, custom order, pending drag-drop accumulator with 500ms debounce flush to PTY.
- `toastStore` (Zustand): ephemeral toasts with auto-dismiss (default 4s).

## App behavior quirks

- **Single-instance + tray**: In release mode, closing the window hides to tray instead of quitting. Double-click tray icon or tray menu "Mostra Traflix Space" restores window. Debug mode does NOT register single-instance plugin (avoids conflict with installed app).
- **Dev mode**: Window title = "Traflix Space [DEV]", tray tooltip = "Traflix Space [DEV]".
- **Confirm-close**: Terminal close requires two clicks (first shows "Chiudere?" confirmation, auto-cancels after 3s). Exited terminals show "Riapri terminale" button using `terminal_reopen`.
- **Workspace close queue**: `WorkspaceView` serializes terminal close/add through a `Promise` chain (`closeQueueRef`) to prevent race conditions on the workspace config.
- **Agent launch queue**: `AgentLaunchQueue` enqueues agent commands with max 2 concurrent, 1s initial delay, 2s between launches.

## Clipboard & drag-drop

- **Paste**: Ctrl+V / Shift+Insert triggers `clipboard-manager:readText`. If no text, falls back to `readImage` → saves PNG to Downloads → writes path to PTY. Paste uses bracketed paste mode (`\x1b[200~...\x1b[201~`).
- **Copy**: Ctrl+C with xterm selection copies to clipboard via `clipboard-manager:writeText`. Without selection, `\x03` passes through to PTY (SIGINT).
- **File drag-drop**: Handled via Tauri native `onDragDropEvent` (not DOM). File paths written directly to target terminal PTY.
- **Skill drag-drop**: Skills dragged from sidebar → `skillStore.addPendingDrop` with 500ms debounce → `buildSkillMessage("usa la skill, ...")` → `terminal_write`.

## Performance patterns

- **Zustand selectors**: Always individual selectors (`useStore((s) => s.field)`). Never destructure entire stores.
- **`useTerminalStore.getState()`**: Use for imperative actions in callbacks (avoids subscription).
- **`invokeWithTimeout`**: Wraps all Tauri `invoke` with configurable timeouts (5-15s, see `src/lib/timeout.ts`).
- **Per-pane xterm.js**: Each `TerminalPane` creates its own `Terminal` + `FitAddon` on mount. Disposed on unmount. No shared pool.
- **Terminal auto-scroll**: Tracks `autoScrollRef` — only scrolls to bottom on output if user was already at bottom. Programmatic scrolls (resize, fit) temporarily suppress via `programmaticScrollRef`.
- **Resize throttle**: ResizeObserver → rAF → 100ms time throttle to avoid scrollback corruption during rapid drags.
- **PTY keep-alive**: Workspace switch does NOT kill PTY sessions. Only `loadedMap` cache is updated.
- **Canvas cache**: Inactive panes show `<canvas>` via `TerminalSnapshot`.

## Version bumping

Usa sempre `npm run version:patch` / `:minor` / `:major` / `:set` (script `scripts/bump-version.js`) che aggiorna automaticamente `package.json`, `Cargo.toml` e `tauri.conf.json`.

| Richiesta utente | Azione agente |
|-----------------|---------------|
| *"fai un bump"* / *"bump versione"* | `npm run version:patch` (default) |
| *"bump patch"* | `npm run version:patch` |
| *"bump minor"* | `npm run version:minor` |
| *"bump major"* | `npm run version:major` |
| *"versione 2.1.3"* / *"bump a 2.1.3"* | `npm run version:set 2.1.3` |

Se l'utente chiede anche **build + push**: `npm run build`, `git add -A`, `git commit -m "chore: bump version to X.Y.Z"`, `git push origin main`.

## Conventions & quirks

- **TypeScript strict**: `noUnusedLocals`, `noUnusedParameters` — fix or prefix with `_`
- **No linting, no testing, no CI/CD**: no ESLint, no test runner, no test files, no GitHub workflows
- **Vite watch** ignores `src-tauri/**` — restart Tauri after Rust changes
- **No auto prod build**: Agents must NOT run `npm run build`, `npm run tauri build`, or any production build automatically
- **Windows path normalization**: Rust commands normalize `\\?\` prefix from `std::fs::canonicalize` before persisting paths
- **Scrollback 1000**: xterm.js + vt100 parser both keep 1000 lines; workspace remount rehydrates via `terminal_get_screen_text` (PTY stays alive)
- **Max limits**: 8 open workspaces (LRU eviction), 8 terminals per workspace
- **Context menu**: Globally suppressed via `contextmenu` listener (except inside `.xterm` elements for right-click paste)
- **Global drag prevention**: `dragover`/`drop` blocked at document level in `main.tsx` — native Tauri events handle file drops instead

## Jarvis ↔ Codex App Server

- Jarvis usa **Codex App Server** come unico LLM (`src-tauri/src/jarvis/model.rs`
  `CodexAppServerProvider`): ogni chat è un `turn/start` sul thread della
  workspace (C4), tool dinamici (C5), `conversational.plan` (C6), streaming
  `jarvis://chat-stream` (C7), TTS progressivo (C8), steer/interrupt (C9).
  Il provider HTTP legacy OpenCode Zen è stato rimosso (C10).
- Docs: `docs/jarvis/codex/` (architettura, protocollo, collaudo Windows).
- Test reale su Windows: `cargo test -- --ignored spawns_real_app_server_and_handshakes`.

## Notable files

- `src/main.tsx` — entry point, global event listeners
- `src/App.tsx` — root component: TitleBar + Sidebar + WorkspaceView
- `src/styles/globals.css` — Tailwind v4 `@theme` tokens (orange primary `#e85d04`, dark surfaces)
- `src/stores/terminalStore.ts` — terminal state management
- `src/stores/workspaceStore.ts` — workspace state with partialize persist
- `src/stores/skillStore.ts` — skills with persist, drag-drop pending accumulator
- `src/components/workspace/TerminalPane.tsx` — terminal pane with memo, all xterm.js lifecycle
- `src/components/workspace/WorkspaceView.tsx` — workspace loading, serialized close queue, LRU eviction
- `src/components/terminal/useTerminalInput.ts` — clipboard paste (text + image), native drag-drop, bracketed paste
- `src/lib/agents.ts` — agent definitions (Gemini, OpenCode, Claude Code, Codex, Anti-Gravity)- `src/lib/agentLauncher.ts` — `AgentLaunchQueue` for batch agent command writes
- `src/lib/presets.ts` — workspace presets + `computeLayout` (max 2x4 grid) + `QUICK_COUNTS`
- `src/lib/timeout.ts` — `invokeWithTimeout` utility
- `scripts/bump-version.js` — version bump script (updates package.json, Cargo.toml, tauri.conf.json)
- `src-tauri/capabilities/default.json` — permissions including `pty:default`, clipboard-manager, shell, fs, store, dialog
