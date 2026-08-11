$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$sidecarScript = Join-Path $PSScriptRoot "build-jarvis-edge-tts-sidecar.ps1"
$sidecar = Join-Path $repo "src-tauri\binaries\jarvis-edge-tts-x86_64-pc-windows-msvc.exe"

# Prefer the real Windows Python launcher so a Microsoft Store `python.exe`
# execution alias cannot mask an installed interpreter.
$python = if (Get-Command py -ErrorAction SilentlyContinue) {
  "py"
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
  "python"
} else {
  throw "Python 3 is required to build the Jarvis Edge TTS sidecar."
}

# Rebuild before every Windows bundle so the embedded helper always matches
# scripts/jarvis-edge-tts.py. The resulting tracked-binary diff must still be
# reviewed explicitly before committing a release update.
Write-Host "Building Jarvis Edge TTS sidecar with $python..."
& $sidecarScript -Python $python
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$artifact = Get-Item -LiteralPath $sidecar
if ($artifact.Length -lt 1MB) {
  throw "Jarvis Edge TTS sidecar is missing a valid x64 Windows PE artifact: $sidecar"
}
$bytes = [System.IO.File]::ReadAllBytes($sidecar)
$peOffset = [System.BitConverter]::ToInt32($bytes, 0x3C)
$machine = [System.BitConverter]::ToUInt16($bytes, $peOffset + 4)
if (
  $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A -or
  $bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or
  $machine -ne 0x8664
) {
  throw "Jarvis Edge TTS sidecar is not an x86_64 Windows PE artifact: $sidecar"
}
Write-Host "Verified Jarvis Edge TTS x86_64 sidecar ($($artifact.Length) bytes)."

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
