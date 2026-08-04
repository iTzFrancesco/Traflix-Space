[CmdletBinding()]
param(
    [string]$Provider = 'smoke',
    [string]$PipeName = $env:TRAFLIX_AGENT_EVENT_PIPE,
    [string]$TerminalId = $env:TRAFLIX_TERMINAL_ID
)
$ErrorActionPreference = 'Stop'

Write-Host '== Traflix agent notification smoke test =='

if ([string]::IsNullOrWhiteSpace($TerminalId)) {
    Write-Host 'ERRORE: TRAFLIX_TERMINAL_ID non impostato.' -ForegroundColor Red
    Write-Host 'Questo script DEVE essere eseguito da un terminale aperto in Traflix Space' -ForegroundColor Yellow
    Write-Host '(altrimenti Traflix non riconosce il terminale e scarta l''evento).' -ForegroundColor Yellow
    exit 1
}
if ([string]::IsNullOrWhiteSpace($PipeName)) {
    Write-Host 'ERRORE: TRAFLIX_AGENT_EVENT_PIPE non impostato.' -ForegroundColor Red
    exit 1
}

$pipeLeaf = $PipeName
if ($pipeLeaf.Contains('\')) { $pipeLeaf = $pipeLeaf.Substring($pipeLeaf.LastIndexOf('\') + 1) }

$event = [ordered]@{
    protocol        = 1
    provider        = $Provider
    kind            = 'turn_completed'
    terminalId      = $TerminalId
    eventId         = ('smoke-' + [guid]::NewGuid().ToString('N'))
    workspaceId     = $env:TRAFLIX_WORKSPACE_ID
    providerSessionId = 'smoke-session'
    providerTurnId  = 'smoke-turn'
    cwd             = (Get-Location).Path
    occurredAt      = [DateTime]::UtcNow.ToString('o')
}
$json = $event | ConvertTo-Json -Compress

Write-Host "Pipe:   $PipeName"
Write-Host "Term:   $TerminalId"
Write-Host "Event:  $json"

$client = $null
$writer = $null
try {
    $client = [System.IO.Pipes.NamedPipeClientStream]::new(
        '.', $pipeLeaf,
        [System.IO.Pipes.PipeDirection]::Out,
        [System.IO.Pipes.PipeOptions]::Asynchronous)
    $client.Connect(750)
    if (-not $client.IsConnected) { Write-Host 'ERRORE: connessione pipe fallita.' -ForegroundColor Red; exit 1 }
    $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false))
    $writer.WriteLine($json)
    $writer.Flush()
    Write-Host 'Evento scritto. Se Traflix è aperto su questo terminale dovresti vedere il toast.' -ForegroundColor Green
} catch {
    Write-Host "ERRORE: $_" -ForegroundColor Red
    exit 1
} finally {
    if ($null -ne $writer) { $writer.Dispose() }
    if ($null -ne $client) { $client.Dispose() }
}
