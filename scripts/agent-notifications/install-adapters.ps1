[CmdletBinding()]
param(
    [string]$BridgePath
)

# Installs only the provider adapters. It never reads .env files and keeps
# existing provider configuration unless it can add the Traflix hook safely.
$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceRoot = Resolve-Path (Join-Path $scriptRoot "..\..")
$sourceBridge = Join-Path $scriptRoot "traflix-agent-event.ps1"

function Resolve-BridgePath {
    param([string]$ExplicitPath)

    $candidates = @(
        $ExplicitPath,
        $env:TRAFLIX_AGENT_EVENT_BRIDGE,
        "C:\Program Files\Traflix Space\agent-notifications\traflix-agent-event.ps1",
        (Join-Path $env:LOCALAPPDATA "Programs\Traflix Space\agent-notifications\traflix-agent-event.ps1"),
        $sourceBridge
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw "Bridge Traflix non trovato. Specificare -BridgePath con il percorso di traflix-agent-event.ps1."
}

function Install-AdapterFile {
    param(
        [string]$Source,
        [string]$Target,
        [string]$Name
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
        throw "Adapter $Name non trovato: $Source"
    }

    $parent = Split-Path -Parent $Target
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Target -Force
    Write-Host "[$Name] installato: $Target" -ForegroundColor Green
}

function Install-ClaudeAdapter {
    param([string]$Bridge)

    $settingsPath = Join-Path $env:USERPROFILE ".claude\settings.json"
    $settingsParent = Split-Path -Parent $settingsPath
    New-Item -ItemType Directory -Force -Path $settingsParent | Out-Null

    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        $raw = Get-Content -Raw -LiteralPath $settingsPath
        $settings = if ([string]::IsNullOrWhiteSpace($raw)) { [pscustomobject]@{} } else { $raw | ConvertFrom-Json }
    } else {
        $settings = [pscustomobject]@{}
    }

    if ($null -eq $settings.PSObject.Properties["hooks"]) {
        $settings | Add-Member -MemberType NoteProperty -Name "hooks" -Value ([pscustomobject]@{})
    }

    $notificationProperty = $settings.hooks.PSObject.Properties["Notification"]
    $notifications = if ($null -eq $notificationProperty) { @() } else { @($settings.hooks.Notification) }
    $alreadyInstalled = $false
    foreach ($notification in $notifications) {
        foreach ($hook in @($notification.hooks)) {
            if ([string]$hook.command -like "*traflix-agent-event.ps1*") {
                $alreadyInstalled = $true
            }
        }
    }

    if ($alreadyInstalled) {
        Write-Host "[Claude] hook già presente: $settingsPath" -ForegroundColor DarkGray
        return
    }

    $backupPath = "$settingsPath.traflix.bak"
    if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
        Copy-Item -LiteralPath $settingsPath -Destination $backupPath -Force
    }

    $command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$Bridge`" -Provider claude -Kind turn_completed"
    $entry = [pscustomobject]@{
        matcher = "idle_prompt"
        hooks = @(
            [pscustomobject]@{
                type = "command"
                command = $command
            }
        )
    }

    $nextNotifications = @($notifications + $entry)
    if ($null -eq $notificationProperty) {
        $settings.hooks | Add-Member -MemberType NoteProperty -Name "Notification" -Value $nextNotifications
    } else {
        $settings.hooks.Notification = $nextNotifications
    }

    $settings | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    Write-Host "[Claude] hook installato: $settingsPath" -ForegroundColor Green
    if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
        Write-Host "[Claude] backup: $backupPath" -ForegroundColor DarkGray
    }
}

function Install-CodexAdapter {
    param([string]$Bridge)

    $configPath = Join-Path $env:USERPROFILE ".codex\config.toml"
    $configParent = Split-Path -Parent $configPath
    New-Item -ItemType Directory -Force -Path $configParent | Out-Null

    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        $existing = Get-Content -Raw -LiteralPath $configPath
        if ($existing -match "traflix-agent-event\.ps1") {
            Write-Host "[Codex] notify già configurato: $configPath" -ForegroundColor DarkGray
            return
        }

        Write-Host "[Codex] notify esistente non modificato: aggiungere manualmente codex-config.toml.example" -ForegroundColor Yellow
        return
    }

    $tomlBridge = $Bridge.Replace("\", "\\")
    $content = @"
notify = [
  "powershell.exe",
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  "$tomlBridge",
  "-Provider",
  "codex"
]
"@
    Set-Content -LiteralPath $configPath -Value $content.Trim() -Encoding UTF8
    Write-Host "[Codex] notify installato: $configPath" -ForegroundColor Green
}

$bridge = Resolve-BridgePath $BridgePath
Write-Host "Traflix notification adapters: bridge=$bridge"

Install-CodexAdapter $bridge
Install-ClaudeAdapter $bridge
Install-AdapterFile (Join-Path $sourceRoot "scripts\agent-notifications\opencode-traflix-plugin.ts") (Join-Path $env:USERPROFILE ".config\opencode\plugin\opencode-traflix-plugin.ts") "OpenCode"
Install-AdapterFile (Join-Path $sourceRoot "scripts\agent-notifications\pi-traflix-extension.ts") (Join-Path $env:USERPROFILE ".pi\agent\extensions\traflix-notify.ts") "Pi"

Write-Host "Riavvia gli agenti già aperti per caricare gli adapter aggiornati." -ForegroundColor Yellow
