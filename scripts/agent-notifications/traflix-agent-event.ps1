[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Payload,
    [string]$Provider,
    [string]$Kind = "turn_completed",
    [string]$PipeName = $env:TRAFLIX_AGENT_EVENT_PIPE,
    [string]$TerminalId = $env:TRAFLIX_TERMINAL_ID
)

# This bridge is intentionally best-effort. A missing Traflix window or pipe
# must never block an agent hook or change the agent's execution result.
$ErrorActionPreference = "SilentlyContinue"

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
    if (-not [string]::IsNullOrWhiteSpace($sessionId) -or
        -not [string]::IsNullOrWhiteSpace($turnId)) {
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

$pipeLeaf = $PipeName
if (-not [string]::IsNullOrWhiteSpace($pipeLeaf) -and $pipeLeaf.Contains("\")) {
    $pipeLeaf = $pipeLeaf.Substring($pipeLeaf.LastIndexOf("\") + 1)
}
if ([string]::IsNullOrWhiteSpace($pipeLeaf)) { exit 0 }

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
    if (-not $client.IsConnected) { exit 0 }

    $writer = [System.IO.StreamWriter]::new(
        $client,
        [System.Text.UTF8Encoding]::new($false)
    )
    $writer.WriteLine($json)
    $writer.Flush()
} catch {
    # Notification delivery is deliberately invisible to the agent.
} finally {
    if ($null -ne $writer) { $writer.Dispose() }
    if ($null -ne $client) { $client.Dispose() }
}

exit 0
