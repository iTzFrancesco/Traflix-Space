$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sidecarScript = Join-Path $PSScriptRoot "build-jarvis-edge-tts-sidecar.ps1"

$python = if (Get-Command python -ErrorAction SilentlyContinue) {
  "python"
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  "py"
} else {
  throw "Python 3 is required to build the Jarvis Edge TTS sidecar."
}

Write-Host "Preparing Jarvis Edge TTS sidecar with $python..."
& $sidecarScript -Python $python
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
