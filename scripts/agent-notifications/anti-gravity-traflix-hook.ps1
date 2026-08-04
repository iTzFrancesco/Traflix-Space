[CmdletBinding()]
param()

# Anti-Gravity Stop hooks receive JSON on stdin and must return JSON on stdout.
# Only a successful/idle stop is forwarded; cancellation and error stops are
# ignored so the Traflix completion UI is not shown for failed turns.
$ErrorActionPreference = "SilentlyContinue"
$logPath = Join-Path $env:USERPROFILE ".gemini\antigravity-cli\traflix-notify.log"

function Write-AgyLog {
    param([string]$Message)
    try {
        $parent = Split-Path -Parent $logPath
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
        Add-Content -LiteralPath $logPath -Value ("[{0}] {1}" -f [DateTime]::UtcNow.ToString("o"), $Message)
    } catch { }
}

function Get-Value {
    param(
        [object]$Object,
        [string[]]$Names
    )

    if ($null -eq $Object) { return $null }
    foreach ($name in $Names) {
        $property = $Object.PSObject.Properties[$name]
        if ($null -ne $property -and $null -ne $property.Value) {
            return [string]$property.Value
        }
    }
    return $null
}

function Reply-And-Exit {
    Write-Output '{}'
    exit 0
}

$raw = ""
try { $raw = [Console]::In.ReadToEnd() } catch { }
if ([string]::IsNullOrWhiteSpace($raw)) {
    Write-AgyLog "notification skipped reason=missing-hook-payload"
    Reply-And-Exit
}

try {
    $source = $raw | ConvertFrom-Json
} catch {
    Write-AgyLog "notification skipped reason=invalid-hook-json"
    Reply-And-Exit
}

$reason = Get-Value $source @("terminationReason", "termination_reason")
$fullyIdle = $source.PSObject.Properties["fullyIdle"]
if ($null -ne $fullyIdle -and $fullyIdle.Value -eq $false) {
    Write-AgyLog "notification skipped reason=background-work-not-idle"
    Reply-And-Exit
}
if ($reason -match "(?i)cancel|abort|interrupt|error|fail") {
    Write-AgyLog ("notification skipped reason=non-success-stop termination={0}" -f $reason)
    Reply-And-Exit
}

$conversationId = Get-Value $source @("conversationId", "conversation_id", "sessionId", "session_id")
if ([string]::IsNullOrWhiteSpace($conversationId)) { $conversationId = "unknown-conversation" }
$workspaceRoot = $null
try {
    if ($source.workspacePaths -is [array] -and $source.workspacePaths.Count -gt 0) {
        $workspaceRoot = [string]$source.workspacePaths[0]
    }
} catch { }
if ([string]::IsNullOrWhiteSpace($workspaceRoot)) {
    $workspaceRoot = Get-Value $source @("workspacePath", "cwd", "workingDirectory")
}

$execution = Get-Value $source @("executionNum", "execution_num", "stepIdx", "step_idx")
if ([string]::IsNullOrWhiteSpace($execution)) { $execution = "turn" }
$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
$eventId = "anti-gravity/{0}/{1}-{2}-{3}" -f $conversationId, $execution, $timestamp, ([guid]::NewGuid().ToString("N"))
$payload = [ordered]@{
    type = "agent-turn-complete"
    eventId = $eventId
    providerSessionId = $conversationId
    providerTurnId = "$conversationId/$execution"
    cwd = $workspaceRoot
}

$bridgeCandidates = @(
    $env:TRAFLIX_AGENT_EVENT_BRIDGE,
    "C:\Program Files\Traflix Space\agent-notifications\traflix-agent-event.ps1",
    (Join-Path $env:LOCALAPPDATA "Programs\Traflix Space\agent-notifications\traflix-agent-event.ps1")
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
$bridge = $null
foreach ($candidate in $bridgeCandidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $bridge = (Resolve-Path -LiteralPath $candidate).Path
        break
    }
}

$pipe = $env:TRAFLIX_AGENT_EVENT_PIPE
$terminalId = $env:TRAFLIX_TERMINAL_ID
$bridgeState = if ($bridge) { "yes" } else { "NO" }
$terminalState = if ($terminalId) { "yes" } else { "NO" }
$pipeState = if ($pipe) { "yes" } else { "NO" }
Write-AgyLog ("notification start provider=anti-gravity eventId={0} termination={1} bridge={2} terminal={3} pipe={4}" -f $eventId, $reason, $bridgeState, $terminalState, $pipeState)

if (-not $bridge -or [string]::IsNullOrWhiteSpace($pipe) -or [string]::IsNullOrWhiteSpace($terminalId)) {
    Write-AgyLog "notification skipped reason=missing-bridge-or-terminal-context"
    Reply-And-Exit
}

try {
    $json = $payload | ConvertTo-Json -Compress
    $escapedBridge = $bridge.Replace("'", "''")
    $escapedPipe = $pipe.Replace("'", "''")
    $escapedTerminalId = $terminalId.Replace("'", "''")
    $escapedJson = $json.Replace("'", "''")
    $bridgeCommand = "& '$escapedBridge' -Provider 'anti-gravity' -Kind 'turn_completed' -PipeName '$escapedPipe' -TerminalId '$escapedTerminalId' -Payload '$escapedJson'"
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bridgeCommand))
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedCommand
    Write-AgyLog ("notification bridge process exited provider=anti-gravity eventId={0} code={1}" -f $eventId, $LASTEXITCODE)
} catch {
    Write-AgyLog ("notification bridge spawn failed provider=anti-gravity eventId={0} message={1}" -f $eventId, $_.Exception.Message)
}

Reply-And-Exit
