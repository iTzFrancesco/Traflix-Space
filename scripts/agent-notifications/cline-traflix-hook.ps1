[CmdletBinding()]
param()

# Cline file hooks receive one JSON object on stdin and require one JSON object
# on stdout. Notification delivery is deliberately best-effort: this hook must
# never cancel or alter a Cline task because Traflix is closed or unavailable.
$ErrorActionPreference = "SilentlyContinue"
$logPath = Join-Path $env:USERPROFILE ".cline\traflix-notify.log"

function Write-ClineLog {
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
    # stdout is reserved for Cline's hook protocol. Never write diagnostics here.
    Write-Output '{"contextModification":"","cancel":false,"errorMessage":""}'
    exit 0
}

$raw = ""
try { $raw = [Console]::In.ReadToEnd() } catch { }
if ([string]::IsNullOrWhiteSpace($raw)) {
    Write-ClineLog "notification skipped reason=missing-hook-payload"
    Reply-And-Exit
}

try {
    $source = $raw | ConvertFrom-Json
} catch {
    Write-ClineLog "notification skipped reason=invalid-hook-json"
    Reply-And-Exit
}

$hookName = Get-Value $source @("hookName", "hook_event_name")
if (-not [string]::IsNullOrWhiteSpace($hookName) -and $hookName -notin @("TaskComplete", "agent_end")) {
    Write-ClineLog ("notification skipped reason=unexpected-hook hook={0}" -f $hookName)
    Reply-And-Exit
}

$taskId = Get-Value $source @("taskId", "task_id", "conversationId", "conversation_id")
if ([string]::IsNullOrWhiteSpace($taskId)) {
    $taskId = Get-Value $source.taskComplete.taskMetadata @("taskId", "task_id")
}
if ([string]::IsNullOrWhiteSpace($taskId)) { $taskId = "unknown-task" }

$workspaceRoot = $null
try {
    if ($source.workspaceRoots -is [array] -and $source.workspaceRoots.Count -gt 0) {
        $workspaceRoot = [string]$source.workspaceRoots[0]
    }
} catch { }
if ([string]::IsNullOrWhiteSpace($workspaceRoot)) {
    $workspaceRoot = Get-Value $source.workspaceInfo @("rootPath", "root_path")
}

$timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssfffZ")
$eventId = "cline/{0}/{1}-{2}" -f $taskId, $timestamp, ([guid]::NewGuid().ToString("N"))
$payload = [ordered]@{
    type = "agent-turn-complete"
    eventId = $eventId
    providerSessionId = $taskId
    providerTurnId = $eventId
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
Write-ClineLog ("notification start provider=cline eventId={0} bridge={1} terminal={2} pipe={3}" -f $eventId, $bridgeState, $terminalState, $pipeState)

if (-not $bridge -or [string]::IsNullOrWhiteSpace($pipe) -or [string]::IsNullOrWhiteSpace($terminalId)) {
    Write-ClineLog "notification skipped reason=missing-bridge-or-terminal-context"
    Reply-And-Exit
}

try {
    $json = $payload | ConvertTo-Json -Compress
    $escapedBridge = $bridge.Replace("'", "''")
    $escapedPipe = $pipe.Replace("'", "''")
    $escapedTerminalId = $terminalId.Replace("'", "''")
    $escapedJson = $json.Replace("'", "''")
    $bridgeCommand = "& '$escapedBridge' -Provider 'cline' -Kind 'turn_completed' -PipeName '$escapedPipe' -TerminalId '$escapedTerminalId' -Payload '$escapedJson'"
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bridgeCommand))
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand $encodedCommand
    Write-ClineLog ("notification bridge process exited provider=cline eventId={0} code={1}" -f $eventId, $LASTEXITCODE)
} catch {
    Write-ClineLog ("notification bridge spawn failed provider=cline eventId={0} message={1}" -f $eventId, $_.Exception.Message)
}

Reply-And-Exit
