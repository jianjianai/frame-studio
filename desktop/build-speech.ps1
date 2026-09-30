param([Parameter(Mandatory=$true)][string]$Bundle, [string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$versions = Get-Content -Raw (Join-Path $PSScriptRoot 'runtime-versions.json') | ConvertFrom-Json
$pythonHome = & $Python -c 'import sys; print(sys.base_prefix)'
$pythonVersion = & $Python -c 'import sys; print("%d.%d" % sys.version_info[:2])'
if ($LASTEXITCODE -ne 0 -or $pythonVersion -ne '3.11') { throw 'Python 3.11 is required.' }
$target = Join-Path ([IO.Path]::GetFullPath($Bundle)) 'python'
if (Test-Path -LiteralPath $target) { throw "Python destination already exists: $target" }
Copy-Item -LiteralPath $pythonHome -Destination $target -Recurse
$bundledPython = Join-Path $target 'python.exe'
& $bundledPython -m pip install --break-system-packages --disable-pip-version-check --no-cache-dir "torch==$($versions.torch)" --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE -ne 0) { throw 'CPU PyTorch installation failed.' }
& $bundledPython -m pip install --break-system-packages --disable-pip-version-check --no-cache-dir -r (Join-Path $repo 'speech\requirements-win.txt')
if ($LASTEXITCODE -ne 0) { throw 'Speech dependency installation failed.' }
& $bundledPython -c 'import kokoro, misaki.zh, sherpa_onnx, fastapi, soundfile; print("Speech dependencies OK; no model weights installed")'
if ($LASTEXITCODE -ne 0) { throw 'Speech dependencies could not import.' }
