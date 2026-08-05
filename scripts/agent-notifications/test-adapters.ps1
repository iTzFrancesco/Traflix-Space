[CmdletBinding()]
param()

# Adapter contract suite. It does not launch any real agent or read secrets:
# it verifies the provider-specific lifecycle seams and exercises the shared
# bridge over a real Windows named pipe for every agent configured by Traflix.
$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgePath = Join-Path $scriptRoot "traflix-agent-event.ps1"
$failures = [System.Collections.Generic.List[string]]::new()

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { $failures.Add($Message) }
}

function Assert-Contains {
    param([string]$Text, [string]$Needle, [string]$Name)
    Assert-True ($Text.Contains($Needle)) "$Name must contain '$Needle'"
}

function Assert-NotContains {
    param([string]$Text, [string]$Needle, [string]$Name)
    Assert-True (-not $Text.Contains($Needle)) "$Name must not contain '$Needle'"
}

Write-Host "== Traflix agent notification adapter suite =="

$adapterContracts = @(
    @{
        Name = "Codex"
        Path = Join-Path $scriptRoot "codex-config.toml.example"
        Required = @("notify", "traflix-agent-event.ps1", "-Provider", "codex")
    }
    @{
        Name = "Claude"
        Path = Join-Path $scriptRoot "claude-hooks.json"
        Required = @('"Notification"', "idle_prompt", "-Provider claude")
    }
    @{
        Name = "OpenCode"
        Path = Join-Path $scriptRoot "opencode-traflix-plugin.ts"
        Required = @("session.status", 'status === "busy" || status === "retry"', 'status !== "idle"', 'eventId:', 'PipeAlternates', '"-PipeName"', '"-TerminalId"', '"opencode"', '{ detached: false', 'notification start provider=opencode', 'bridge process started', 'bridge process exited', 'bridge spawn failed')
        Forbidden = @('{ detached: true', 'child.unref()')
    }
    @{
        Name = "Pi"
        Path = Join-Path $scriptRoot "pi-traflix-extension.ts"
        Required = @("agent_settled", '"pi"', "TRAFLIX_TERMINAL_ID", 'PipeAlternates', '"-PipeName"', '"-TerminalId"', '{ detached: false', 'notification start provider=', 'bridge process started', 'bridge process exited', 'bridge spawn failed')
        Forbidden = @('{ detached: true', 'child.unref()')
    }
    @{
        Name = "Cline"
        Path = Join-Path $scriptRoot "cline-traflix-hook.ps1"
        Required = @("TaskComplete", "hookName", "-Provider 'cline'", "-Kind 'turn_completed'", "TRAFLIX_AGENT_EVENT_PIPE", "EncodedCommand", "notification start", "notification bridge process exited", "notification bridge spawn failed")
    }
    @{
        Name = "Anti-Gravity"
        Path = Join-Path $scriptRoot "anti-gravity-traflix-hook.ps1"
        Required = @("terminationReason", "fullyIdle", "-Provider 'anti-gravity'", "-Kind 'turn_completed'", "TRAFLIX_AGENT_EVENT_PIPE", "EncodedCommand", "notification start", "notification bridge process exited", "notification bridge spawn failed")
    }
)

foreach ($contract in $adapterContracts) {
    $content = if (Test-Path -LiteralPath $contract.Path) {
        Get-Content -Raw -LiteralPath $contract.Path
    } else { "" }
    Assert-True (Test-Path -LiteralPath $contract.Path) "$($contract.Name) adapter file is missing"
    foreach ($required in $contract.Required) {
        Assert-Contains $content $required $contract.Name
    }
    if ($null -ne $contract.Forbidden) {
        foreach ($forbidden in $contract.Forbidden) {
            Assert-NotContains $content $forbidden $contract.Name
        }
    }
    Write-Host "[contract] $($contract.Name)"
}

$uiContracts = @(
    @{ Name = "focus-aware bridge"; Path = $bridgePath; Required = @("Get-FocusedTraflixPipe", "GetForegroundWindow", "route=focused-pipe", "route=owner-pipe") },
    @{ Name = "Traflix overlay"; Path = Join-Path $scriptRoot "..\..\src\components\agent\AgentNotificationOverlay.tsx"; Required = @("AGENT_NOTIFICATION_SHOW_EVENT", "WebviewWindow.getCurrent", "projectName", "Apri", "Continua") },
    @{ Name = "overlay open error path"; Path = Join-Path $scriptRoot "..\..\src\components\agent\AgentNotificationOverlay.tsx"; Required = @('WebviewWindow.getByLabel("main")', "mainWindow?.show()", "mainWindow?.setFocus()", "if (!currentNotification?.canOpenTerminal) return;", 'await emitTo("main", AGENT_NOTIFICATION_OPEN_EVENT', "workspaceId: currentNotification.workspaceId", "terminalId: currentNotification.terminalId", "catch (error)", 'console.warn("Traflix terminal notification could not open main window:", error)'); Forbidden = @("terminal_write", "terminal_kill", "create_workspace", "update_workspace", "delete_workspace") },
    @{ Name = "focus gate"; Path = Join-Path $scriptRoot "..\..\src\components\agent\AgentCompletionListener.tsx"; Required = @("document.hasFocus()", "getCurrentWebviewWindow().isFocused()", "appHasFocus", "terminalStore.terminalTitles", "attentionRequired = true", "playAgentCompletionChime", "showAgentNotificationOverlay", "[agent-notification] handling completion", "[agent-notification] focus resolved", "[agent-notification] showing in-app toast", "[agent-notification] showing external overlay") },
    @{ Name = "main notification receiver"; Path = Join-Path $scriptRoot "..\..\src\components\agent\AgentCompletionListener.tsx"; Required = @("[agent-notification] open requested", "const mainWindow = getCurrentWebviewWindow()", "await mainWindow.show()", "await mainWindow.setFocus()"); Forbidden = @('WebviewWindow.getByLabel("main")', "terminal_write", "terminal_kill", "create_workspace", "update_workspace", "delete_workspace") },
    @{ Name = "Space event log"; Path = Join-Path $scriptRoot "..\..\src\lib\terminalEvents.ts"; Required = @("[agent-notification] received from Space") },
    @{ Name = "overlay event log"; Path = Join-Path $scriptRoot "..\..\src\lib\agentNotificationOverlay.ts"; Required = @("[agent-notification] overlay start", "[agent-notification] overlay event dispatched") },
    @{ Name = "Rust event log"; Path = Join-Path $scriptRoot "..\..\src-tauri\src\agent_events.rs"; Required = @("Agent event received from named pipe", "Agent notification parsed", "Agent notification ignored as duplicate", "Agent notification forwarded to frontend") },
    @{ Name = "overlay window"; Path = Join-Path $scriptRoot "..\..\src-tauri\tauri.conf.json"; Required = @('"label": "agent-notification"', '"alwaysOnTop": true', '"visible": false') }
)
foreach ($contract in $uiContracts) {
    $content = if (Test-Path -LiteralPath $contract.Path) { Get-Content -Raw -LiteralPath $contract.Path } else { "" }
    Assert-True (Test-Path -LiteralPath $contract.Path) "$($contract.Name) file is missing"
    foreach ($required in $contract.Required) {
        Assert-Contains $content $required $contract.Name
    }
    if ($null -ne $contract.Forbidden) {
        foreach ($forbidden in $contract.Forbidden) {
            Assert-NotContains $content $forbidden $contract.Name
        }
    }
    Write-Host "[ui] $($contract.Name)"
}

$setupContract = @{
    Name = "adapter installer"
    Path = Join-Path $scriptRoot "install-adapters.ps1"
    Required = @("Install-ClaudeAdapter", "Install-CodexAdapter", "opencode-traflix-plugin.ts", "pi-traflix-extension.ts", "cline-traflix-hook.ps1", '$backupPath = "$settingsPath.traflix.bak"')
}
$setupContent = if (Test-Path -LiteralPath $setupContract.Path) { Get-Content -Raw -LiteralPath $setupContract.Path } else { "" }
Assert-True (Test-Path -LiteralPath $setupContract.Path) "$($setupContract.Name) file is missing"
foreach ($required in $setupContract.Required) {
    Assert-Contains $setupContent $required $setupContract.Name
}
Write-Host "[setup] $($setupContract.Name)"

$agyContract = @{
    Name = "Anti-Gravity project hook"
    Path = Join-Path $scriptRoot "..\..\.agents\hooks.json"
    Required = @("traflix-notification", "Stop", "anti-gravity-traflix-hook.ps1")
}
$agyContent = if (Test-Path -LiteralPath $agyContract.Path) { Get-Content -Raw -LiteralPath $agyContract.Path } else { "" }
Assert-True (Test-Path -LiteralPath $agyContract.Path) "$($agyContract.Name) file is missing"
foreach ($required in $agyContract.Required) {
    Assert-Contains $agyContent $required $agyContract.Name
}
Write-Host "[setup] $($agyContract.Name)"

$bridgeContract = @{
    Name = "bridge logging"
    Path = $bridgePath
    Required = @("notification start", "notification normalized", "notification sent", "notification send failed", "notification skipped")
}
$bridgeContent = if (Test-Path -LiteralPath $bridgeContract.Path) { Get-Content -Raw -LiteralPath $bridgeContract.Path } else { "" }
Assert-True (Test-Path -LiteralPath $bridgeContract.Path) "$($bridgeContract.Name) file is missing"
foreach ($required in $bridgeContract.Required) {
    Assert-Contains $bridgeContent $required $bridgeContract.Name
}
Write-Host "[bridge-log] $($bridgeContract.Name)"

function Test-BridgeProvider {
    param([string]$Provider)

    $pipeLeaf = "traflix-agent-test-$([guid]::NewGuid().ToString('N'))"
    $terminalId = "adapter-test-$Provider"
    $pipeName = "\\.\pipe\$pipeLeaf"
    $payload = @{ type = "agent-turn-complete"; providerSessionId = "session-$Provider"; providerTurnId = "turn-$Provider" } |
        ConvertTo-Json -Compress
    $server = [System.IO.Pipes.NamedPipeServerStream]::new(
        $pipeLeaf,
        [System.IO.Pipes.PipeDirection]::In,
        1,
        [System.IO.Pipes.PipeTransmissionMode]::Byte,
        [System.IO.Pipes.PipeOptions]::Asynchronous
    )

    $escapedBridge = $bridgePath.Replace("'", "''")
    $escapedPayload = $payload.Replace("'", "''")
    $command = "& '$escapedBridge' -Provider '$Provider' -Kind 'turn_completed' -PipeName '$pipeName' -TerminalId '$terminalId' -Payload '$escapedPayload'"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $process = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded
    )

    try {
        if (-not $server.WaitForConnectionAsync().Wait(4000)) {
            throw "bridge did not connect to the named pipe"
        }
        $reader = [System.IO.StreamReader]::new($server, [Text.Encoding]::UTF8)
        $line = $reader.ReadLine()
        if (-not $process.WaitForExit(5000)) {
            throw "bridge process did not exit"
        }
        Assert-True ($process.ExitCode -eq 0) "$Provider bridge exited with $($process.ExitCode)"
        $event = $line | ConvertFrom-Json
        Assert-True ($event.protocol -eq 1) "$Provider protocol must be 1"
        Assert-True ($event.provider -eq $Provider) "$Provider must be preserved by bridge"
        Assert-True ($event.kind -eq "turn_completed") "$Provider kind must be turn_completed"
        Assert-True ($event.terminalId -eq $terminalId) "$Provider terminal id must be preserved"
        Assert-True (-not [string]::IsNullOrWhiteSpace($event.eventId)) "$Provider event id must be generated"
        Write-Host "[bridge] $Provider"
    } catch {
        $failures.Add("$Provider bridge: $($_.Exception.Message)")
    } finally {
        if ($process -and -not $process.HasExited) { $process.Kill() }
        $server.Dispose()
    }
}

function Test-BridgeFanout {
    $pipeA = "traflix-agent-fanout-a-$([guid]::NewGuid().ToString('N'))"
    $pipeB = "traflix-agent-fanout-b-$([guid]::NewGuid().ToString('N'))"
    $terminalId = "adapter-test-fanout"
    $payload = @{ type = "agent-turn-complete"; providerSessionId = "session-fanout"; providerTurnId = "turn-fanout" } |
        ConvertTo-Json -Compress
    $servers = @(
        [System.IO.Pipes.NamedPipeServerStream]::new($pipeA, [System.IO.Pipes.PipeDirection]::In, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::Asynchronous),
        [System.IO.Pipes.NamedPipeServerStream]::new($pipeB, [System.IO.Pipes.PipeDirection]::In, 1, [System.IO.Pipes.PipeTransmissionMode]::Byte, [System.IO.Pipes.PipeOptions]::Asynchronous)
    )
    $escapedBridge = $bridgePath.Replace("'", "''")
    $escapedPayload = $payload.Replace("'", "''")
    $pipeNameA = "\\.\pipe\$pipeA"
    $command = "& '$escapedBridge' -Provider 'codex' -Kind 'turn_completed' -PipeName '$pipeNameA' -PipeAlternates '$pipeB' -TerminalId '$terminalId' -Payload '$escapedPayload'"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $waitTasks = @($servers | ForEach-Object { $_.WaitForConnectionAsync() })
    $process = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded
    )

    try {
        $lines = [System.Collections.Generic.List[string]]::new()
        for ($index = 0; $index -lt $waitTasks.Count; $index++) {
            if (-not $waitTasks[$index].Wait(4000)) {
                $failedPipe = if ($index -eq 0) { $pipeA } else { $pipeB }
                throw "bridge did not connect to fanout pipe $index ($failedPipe)"
            }
            $reader = [System.IO.StreamReader]::new($servers[$index], [Text.Encoding]::UTF8)
            $lines.Add($reader.ReadLine())
        }
        if (-not $process.WaitForExit(5000)) { throw "fanout bridge process did not exit" }
        foreach ($line in $lines) {
            $event = $line | ConvertFrom-Json
            Assert-True ($event.provider -eq "codex") "fanout provider must be preserved"
            Assert-True ($event.terminalId -eq $terminalId) "fanout terminal id must be preserved"
        }
        Write-Host "[bridge-fanout] DEV + release destinations"
    } catch {
        $failures.Add("bridge fanout: $($_.Exception.Message)")
    } finally {
        if ($process -and -not $process.HasExited) { $process.Kill() }
        $servers | ForEach-Object { $_.Dispose() }
    }
}

# Includes providers without a checked-in adapter implementation: the common
# bridge contract is provider-agnostic, so these agents can be wired to it by
# their native hook/notification mechanism without changing Traflix itself.
foreach ($provider in @("anti-gravity", "claude", "codex", "opencode", "pi", "cmdc", "freebuff")) {
    Test-BridgeProvider $provider
}
Test-BridgeFanout

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
    $failures.Add("node is required for the adapter process integration test")
} else {
    $processTest = Join-Path $scriptRoot "test-adapter-process.mjs"
    & $node.Source $processTest
    if ($LASTEXITCODE -ne 0) {
        $failures.Add("adapter child process integration test failed")
    }
}

if ($failures.Count -gt 0) {
    Write-Host "`nFAILED ($($failures.Count))" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
    exit 1
}

Write-Host "`nPASS: all provider contracts and bridge paths verified." -ForegroundColor Green
