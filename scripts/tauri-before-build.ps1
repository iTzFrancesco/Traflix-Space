$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sidecarScript = Join-Path $PSScriptRoot "build-jarvis-edge-tts-sidecar.ps1"

Write-Host "Preparing Jarvis Edge TTS sidecar..."
& $sidecarScript
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

Push-Location $repo
try {
  Write-Host "Building Traflix Space frontend..."
  & npm run build
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}
finally {
  Pop-Location
}
