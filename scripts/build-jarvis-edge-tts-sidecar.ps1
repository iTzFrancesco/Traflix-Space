param(
  [string]$Python = "python",
  [string]$TargetTriple = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$script = Join-Path $repo "scripts\jarvis-edge-tts.py"
$binaries = Join-Path $repo "src-tauri\binaries"
$build = Join-Path $repo "src-tauri\edge-tts-build"

New-Item -ItemType Directory -Force -Path $binaries | Out-Null
& $Python -m pip install pyinstaller edge-tts
& $Python -m PyInstaller --noconfirm --clean --onefile --name jarvis-edge-tts --distpath $build --workpath (Join-Path $build "work") --specpath $build $script
$output = Join-Path $build "jarvis-edge-tts.exe"
if (-not (Test-Path -LiteralPath $output)) {
  throw "PyInstaller did not produce $output"
}
Copy-Item -LiteralPath $output -Destination (Join-Path $binaries "jarvis-edge-tts-$TargetTriple.exe") -Force
Write-Host "Created src-tauri\binaries\jarvis-edge-tts-$TargetTriple.exe"
