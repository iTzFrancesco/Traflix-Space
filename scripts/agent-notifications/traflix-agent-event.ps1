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

if ([string]::IsNullOrWhiteSpace($Payload) -and [Console]::IsInputRedirected) {
    try { $Payload = [Console]::In.ReadToEnd() } catch { $Payload = "" }
}

if ([string]::IsNullOrWhiteSpace($Payload) -or
    [string]::IsNullOrWhiteSpace($TerminalId)) {
    exit 0
}

try { $source = $Payload | ConvertFrom-Json } catch { exit 0 }

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
    eventId = $eventId
    workspaceId = $env:TRAFLIX_WORKSPACE_ID
    providerSessionId = $sessionId
    providerTurnId = $turnId
    cwd = $cwd
    occurredAt = [DateTime]::UtcNow.ToString("o")
}
$json = $normalized | ConvertTo-Json -Compress

# A terminal can belong to the installed release while the user is looking at
# the DEV instance (or the other way around). Fan out the same normalized event
# to both Traflix pipes. A missing pipe is expected and remains best-effort.
$pipeLeaves = [System.Collections.Generic.List[string]]::new()
function Add-PipeLeaf {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return }
    $leaf = $Value
    if ($leaf.Contains("\")) {
        $leaf = $leaf.Substring($leaf.LastIndexOf("\") + 1)
    }
    if (-not [string]::IsNullOrWhiteSpace($leaf) -and -not $pipeLeaves.Contains($leaf)) {
        [void]$pipeLeaves.Add($leaf)
    }
}

Add-PipeLeaf $PipeName
$alternatePipes = @()
if (-not [string]::IsNullOrWhiteSpace($PipeAlternates)) {
    $alternatePipes = $PipeAlternates -split '[,;]'
} else {
    $pipeLeafForFanout = $PipeName
    if ($pipeLeafForFanout.Contains("\")) {
        $pipeLeafForFanout = $pipeLeafForFanout.Substring($pipeLeafForFanout.LastIndexOf("\") + 1)
    }
    if ($pipeLeafForFanout -in @(
        "traflix-space-agent-events",
        "traflix-space-agent-events-dev"
    )) {
    # Only a real terminal event uses the configured Traflix pipe. Explicit
    # custom pipes remain single-destination so adapter tests never touch a
    # running desktop instance.
        $alternatePipes = @(
            "traflix-space-agent-events",
            "traflix-space-agent-events-dev"
        )
    }
}
foreach ($alternatePipe in $alternatePipes) {
    Add-PipeLeaf $alternatePipe
}
Write-BridgeLog ("provider={0} terminal={1} destinations={2}" -f $Provider, $TerminalId, ($pipeLeaves -join ","))
if ($pipeLeaves.Count -eq 0) { exit 0 }

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
            Write-BridgeLog ("not-connected pipe={0}" -f $pipeLeaf)
            continue
        }

        $writer = [System.IO.StreamWriter]::new(
            $client,
            [System.Text.UTF8Encoding]::new($false)
        )
        $writer.WriteLine($json)
        $writer.Flush()
        Write-BridgeLog ("connected pipe={0}" -f $pipeLeaf)
    } catch {
        Write-BridgeLog ("error pipe={0} message={1}" -f $pipeLeaf, $_.Exception.Message)
        # Notification delivery is deliberately invisible to the agent.
    } finally {
        if ($null -ne $writer) { $writer.Dispose() }
        if ($null -ne $client) { $client.Dispose() }
    }
}

exit 0
