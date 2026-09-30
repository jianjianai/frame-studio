param([Parameter(Mandatory=$true)][string]$Bundle, [string]$Python = 'python', [switch]$ReusePython)
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$bundlePath = [IO.Path]::GetFullPath($Bundle)
$pythonHome = & $Python -c 'import sys; print(sys.base_prefix)'
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $pythonHome)) { throw 'Python 3.11 is required to build the Windows speech bundle.' }
$pythonVersion = & $Python -c 'import sys; print("%d.%d" % sys.version_info[:2])'
if ($pythonVersion -ne '3.11') { throw "Expected Python 3.11, got $pythonVersion" }
$target = Join-Path $bundlePath 'python'
if ($ReusePython) {
  if (-not (Test-Path -LiteralPath (Join-Path $target 'python.exe'))) { throw "Speech runtime is missing: $target" }
} else {
  if (Test-Path -LiteralPath $target) { throw "Speech runtime already exists: $target" }
  Copy-Item -LiteralPath $pythonHome -Destination $target -Recurse
}
$bundledPython = Join-Path $target 'python.exe'
if (-not $ReusePython) {
  & $bundledPython -m pip install --break-system-packages --disable-pip-version-check --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu
  if ($LASTEXITCODE -ne 0) { throw 'CPU PyTorch installation failed.' }
}
& $bundledPython -m pip install --break-system-packages --disable-pip-version-check --no-cache-dir 'kokoro==0.9.4' 'misaki[zh]==0.9.4' fastapi uvicorn soundfile numpy 'sherpa-onnx==1.13.8' huggingface_hub
if ($LASTEXITCODE -ne 0) { throw 'Speech dependency installation failed.' }
$env:FRAME_SPEECH_BUILTIN = Join-Path $bundlePath 'speech-models\builtin'
$env:FRAME_SPEECH_ONNX = Join-Path $bundlePath 'speech-models\builtin-onnx'
& (Join-Path $target 'python.exe') (Join-Path $repo 'speech\download.py')
if ($LASTEXITCODE -ne 0) { throw 'Pinned speech model download failed.' }
$env:FRAME_SPEECH_MODELS = Join-Path $bundlePath 'speech-models\smoke-custom'
Push-Location (Join-Path $bundlePath 'speech')
try {
  & (Join-Path $target 'python.exe') -c 'import server; assert len(server.CATALOG) == 3; print("Speech import OK")'
  if ($LASTEXITCODE -ne 0) { throw 'Bundled speech server could not import.' }
} finally { Pop-Location }
Remove-Item Env:FRAME_SPEECH_MODELS -ErrorAction SilentlyContinue
& node (Join-Path $repo 'desktop\smoke-speech.mjs') $bundlePath
if ($LASTEXITCODE -ne 0) { throw 'Bundled speech model synthesis failed.' }
