# Inline command-history suggestions in the terminal

Research note, 2026-10-07. This describes the dim text after the cursor in the supplied T3 Code screenshot.

## Finding

The hint is consistent with PowerShell's PSReadLine Predictive IntelliSense in `InlineView`: it renders a history-based continuation in light gray after the cursor, and `RightArrow` accepts it. This behavior belongs to the shell line editor. T3 Code's terminal path forwards input to its terminal session and renders session output through its Ghostty terminal surface; that path does not maintain a second command history or create a suggestion overlay. The attribution to PSReadLine is an inference from the screenshot and PowerShell's matching documented behavior, not a claim that T3 Code hard-codes PowerShell configuration.

T3 Code wires the terminal surface's `onData` callback to `handleData`, which calls `terminalEnvironment.write` with the same input string. Its Ghostty surface passes keyboard input into the terminal core and renders data written back from the terminal session. See [`ThreadTerminalDrawer.tsx`](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/ThreadTerminalDrawer.tsx) and [`surface.ts`](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/terminal/ghostty/surface.ts). Microsoft documents the matching inline appearance, history source, and `RightArrow` acceptance in [Using predictors in PSReadLine](https://learn.microsoft.com/en-us/powershell/scripting/learn/shell/using-predictors?view=powershell-7.6).

## Traflix Space today

- [`useTerminalPaneLifecycle.ts`](../../src/components/workspace/useTerminalPaneLifecycle.ts) creates one xterm instance per pane. `term.onData` forwards keystrokes to `terminal_write`; PTY output is rendered through `term.write`.
- [`commands.rs`](../../src-tauri/src/terminal_engine/commands.rs) validates the terminal runtime identity before writing input. [`session_process.rs`](../../src-tauri/src/terminal_engine/session_process.rs) starts the configured shell in the PTY and sets `TERM=xterm-256color`.
- The new-workspace wizard and add-terminal action default to `powershell.exe` in [`NewSpaceWizard.tsx`](../../src/components/workspace/NewSpaceWizard.tsx) and [`useWorkspaceTerminalActions.ts`](../../src/components/workspace/useWorkspaceTerminalActions.ts). [`useTerminalInput.ts`](../../src/components/terminal/useTerminalInput.ts) intercepts paste and copy shortcuts; ordinary editing keys remain with xterm and the shell.
- Rust's bounded [`CommandInputBuffer`](../../src-tauri/src/terminal_engine/session.rs) is used to recognize agent launch commands. It is not a persisted shell history or a suitable source for suggestions.

This means Traflix already has the right terminal data path for shell-native inline predictions. The shell can emit the ANSI/VT updates and xterm can render them; the frontend need not duplicate command-line editing.

## Quick validation

In a Traflix PowerShell terminal, check the installed module and current options:

```powershell
Get-Module PSReadLine -ListAvailable | Sort-Object Version -Descending | Select-Object -First 1 Name,Version
Get-PSReadLineOption | Select-Object PredictionSource,PredictionViewStyle
```

For a session-only check, execute a command that should be suggested later, then run:

```powershell
Set-PSReadLineOption -PredictionSource History -PredictionViewStyle InlineView
```

Type the start of the earlier command at the next prompt. The expected behavior is a gray continuation after the cursor; press `RightArrow` to accept it. To enable it for every PowerShell session manually, place that setting in the user's PowerShell profile.

Predictive IntelliSense was introduced in PSReadLine 2.1.0; `PredictionViewStyle` was added in 2.2.0. Windows PowerShell 5.1 can use a recent PSReadLine module, while predictor plugins require PowerShell 7.2 or later. The app's `powershell.exe` choice alone does not guarantee that the installed module supports or enables predictions. See Microsoft's [PSReadLine overview](https://learn.microsoft.com/en-us/powershell/module/psreadline/about/about_psreadline?view=powershell-7.6) and [predictor guide](https://learn.microsoft.com/en-us/powershell/scripting/learn/shell/using-predictors?view=powershell-7.6).

## Traflix Space implementation

The app now has an opt-in **Suggerimenti dalla cronologia** setting in
Impostazioni. It is off for existing and new installations by default. Rust
persists it with the other app settings and reads it centrally when a PTY is
spawned, so it covers both user-opened terminals and terminals created by
Jarvis. When enabled, only `powershell.exe`, `pwsh.exe`, `powershell`, and
`pwsh` receive a static `-NoExit -Command` initialization that sets
`PredictionSource=History` and `PredictionViewStyle=InlineView`. The normal
PowerShell profile still loads. Other shells and terminals already running are
left alone; a warning is shown in PowerShell when PSReadLine or the required
options are unavailable.

History remains owned by PSReadLine in the user's PowerShell profile area. The
app does not copy commands into React state, terminal settings, or workspace
metadata. `settings::store` tests cover migration and round-tripping of the
preference, and pure Rust tests cover shell gating and the interactive startup
arguments.
