[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Payload,
    [string]$Provider,
    [string]$Kind = "turn_completed",
    [string]$PipeName = $env:TRAFLIX_AGENT_EVENT_PIPE,
    [string]$PipeAlternates = $env:TRAFLIX_AGENT_EVENT_PIPE_ALTERNATES,
    [string]$TerminalId = $env:TRAFLIX_TERMINAL_ID
)

# This bridge is intentionally best-effort. A missing Traflix window or pipe
# must never block an agent hook or change the agent's execution result.
$ErrorActionPreference = "SilentlyContinue"
$bridgeLog = Join-Path ([IO.Path]::GetTempPath()) "traflix-agent-event-bridge.log"
function Write-BridgeLog {
    param([string]$Message)
    try {
        Add-Content -LiteralPath $bridgeLog -Value ("[{0}] {1}" -f [DateTime]::UtcNow.ToString("o"), $Message)
    } catch { }
}

Write-BridgeLog ("notification start provider={0} kind={1} terminal={2} pipe={3}" -f $Provider, $Kind, $TerminalId, $PipeName)

if ([string]::IsNullOrWhiteSpace($Payload) -and [Console]::IsInputRedirected) {
    try { $Payload = [Console]::In.ReadToEnd() } catch { $Payload = "" }
}

if ([string]::IsNullOrWhiteSpace($Payload)) {
    Write-BridgeLog "notification skipped reason=missing-payload"
    exit 0
}

if ([string]::IsNullOrWhiteSpace($TerminalId)) {
    Write-BridgeLog "notification skipped reason=missing-terminal-id"
    exit 0
}

try {
    $source = $Payload | ConvertFrom-Json
} catch {
    Write-BridgeLog "notification skipped reason=invalid-json"
    exit 0
}

function Get-SourceValue {
    param(
        [object]$Object,
        [string[]]$Names
    )

    foreach ($name in $Names) {
        $property = $Object.PSObject.Properties[$name]
        if ($null -ne $property -and $null -ne $property.Value) {
            return [string]$property.Value
        }
    }
    return $null
}

$sourceType = Get-SourceValue $source @("type", "hook_event_name", "hookEventName")
if ([string]::IsNullOrWhiteSpace($Provider)) {
    $Provider = switch ($sourceType) {
        "agent-turn-complete" { "codex"; break }
        "session.idle" { "opencode"; break }
        "session.status" { "opencode"; break }
        "agent_settled" { "pi"; break }
        "Stop" { "claude"; break }
        "Notification" { "claude"; break }
        default { "agent" }
    }
}

$Provider = $Provider.Trim().ToLowerInvariant()
# Claudex is a local wrapper around Claude Code that routes through the
# Traflix Codex proxy. It reuses Claude's native hook file, so derive the
# provider from its process-local markers instead of emitting a Claude event
# that cannot match a Claudex terminal binding.
if (
    $Provider -eq "claude" -and
    -not [string]::IsNullOrWhiteSpace($env:CCP_CONFIG_DIR) -and
    $env:ANTHROPIC_BASE_URL -like "http://127.0.0.1:18765*"
) {
    $Provider = "claudex"
}
$sessionId = Get-SourceValue $source @(
    "providerSessionId", "sessionId", "sessionID", "session_id", "thread-id", "threadId"
)
$turnId = Get-SourceValue $source @(
    "providerTurnId", "turnId", "turnID", "turn_id", "turn-id"
)
$eventId = Get-SourceValue $source @("eventId", "event_id")
if ([string]::IsNullOrWhiteSpace($eventId)) {
    # A provider session can contain many turns. Only a real provider turn id
    # is stable enough for deduplication; session-only events (OpenCode idle,
    # for example) must receive a fresh id on every completion.
    if (-not [string]::IsNullOrWhiteSpace($turnId)) {
        $eventId = "$Provider/$sessionId/$turnId/$Kind"
    } else {
        $eventId = [guid]::NewGuid().ToString("N")
    }
}

$cwd = Get-SourceValue $source @("cwd", "workingDirectory", "directory")
if ([string]::IsNullOrWhiteSpace($cwd)) {
    try { $cwd = (Get-Location).Path } catch { $cwd = $null }
}

$normalized = [ordered]@{
    protocol = 1
    provider = $Provider
    kind = $Kind
    terminalId = $TerminalId
    generation = if ($env:TRAFLIX_TERMINAL_GENERATION) { [UInt64]$env:TRAFLIX_TERMINAL_GENERATION } else { $null }
    eventId = $eventId
    workspaceId = $env:TRAFLIX_WORKSPACE_ID
    providerSessionId = $sessionId
    providerTurnId = $turnId
    cwd = $cwd
    occurredAt = [DateTime]::UtcNow.ToString("o")
}
$json = $normalized | ConvertTo-Json -Compress

# The environment variables are stamped onto each Traflix-managed PTY. The
# configured pipe is therefore the source of truth for the instance that owns
# the terminal. Always route real desktop events to that owner: routing by the
# currently focused DEV/release window can deliver the notification to an
# instance that has no real PTY to reopen.
$pipeLeaves = [System.Collections.Generic.List[string]]::new()
function Get-PipeLeaf {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $leaf = $Value
    if ($leaf.Contains("\")) {
        $leaf = $leaf.Substring($leaf.LastIndexOf("\") + 1)
    }
    return $leaf
}

function Add-PipeLeaf {
    param([string]$Value)
    $leaf = Get-PipeLeaf $Value
    if ([string]::IsNullOrWhiteSpace($leaf)) { return }
    if (-not [string]::IsNullOrWhiteSpace($leaf) -and -not $pipeLeaves.Contains($leaf)) {
        [void]$pipeLeaves.Add($leaf)
    }
}

$pipeLeafForOwner = Get-PipeLeaf $PipeName
$isRealTraflixPipe = $pipeLeafForOwner -in @(
    "traflix-space-agent-events",
    "traflix-space-agent-events-dev"
)

if ($isRealTraflixPipe) {
    Add-PipeLeaf $PipeName
    Write-BridgeLog ("notification route=owner-pipe pipe={0}" -f $pipeLeafForOwner)
} else {
    # Explicit custom pipes are used by the adapter tests and remain
    # multi-destination so the bridge contract can be verified safely.
    Add-PipeLeaf $PipeName
    $alternatePipes = @()
    if (-not [string]::IsNullOrWhiteSpace($PipeAlternates)) {
        $alternatePipes = $PipeAlternates -split '[,;]'
    }
    foreach ($alternatePipe in $alternatePipes) {
        Add-PipeLeaf $alternatePipe
    }
}
Write-BridgeLog ("notification normalized provider={0} kind={1} terminal={2} eventId={3} destinations={4}" -f $Provider, $Kind, $TerminalId, $eventId, ($pipeLeaves -join ","))
if ($pipeLeaves.Count -eq 0) {
    Write-BridgeLog "notification skipped reason=no-pipe-destination"
    exit 0
}

foreach ($pipeLeaf in $pipeLeaves) {
    $client = $null
    $writer = $null
    try {
        $client = [System.IO.Pipes.NamedPipeClientStream]::new(
            ".",
            $pipeLeaf,
            [System.IO.Pipes.PipeDirection]::Out,
            [System.IO.Pipes.PipeOptions]::Asynchronous
        )
        $client.Connect(750)
        if (-not $client.IsConnected) {
            Write-BridgeLog ("notification send failed provider={0} terminal={1} eventId={2} pipe={3} reason=not-connected" -f $Provider, $TerminalId, $eventId, $pipeLeaf)
            continue
        }

        $writer = [System.IO.StreamWriter]::new(
            $client,
            [System.Text.UTF8Encoding]::new($false)
        )
        $writer.WriteLine($json)
        $writer.Flush()
        Write-BridgeLog ("notification sent provider={0} terminal={1} eventId={2} pipe={3}" -f $Provider, $TerminalId, $eventId, $pipeLeaf)
    } catch {
        Write-BridgeLog ("notification send failed provider={0} terminal={1} eventId={2} pipe={3} message={4}" -f $Provider, $TerminalId, $eventId, $pipeLeaf, $_.Exception.Message)
        # Notification delivery is deliberately invisible to the agent.
    } finally {
        if ($null -ne $writer) { $writer.Dispose() }
        if ($null -ne $client) { $client.Dispose() }
    }
}

exit 0
