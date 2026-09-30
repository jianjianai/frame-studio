param(
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$DataRoot
)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
. (Join-Path $PSScriptRoot 'progress.ps1')
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
Start-Transcript -Path (Join-Path $DataRoot 'installer.log') -Append | Out-Null
try {
$selection = Join-Path $SourceRoot 'prepared-runtime.json'
Write-Output '检查运行环境及应用依赖'
& (Join-Path $PSScriptRoot 'bootstrap.ps1') -AppRoot $SourceRoot -DataRoot $DataRoot -Selection $selection -PrepareOnly
$runtime = Get-Content -Raw -LiteralPath $selection | ConvertFrom-Json
function Test-NativeCommand([string]$Executable, [string]$Arguments) {
  $process = New-Object Diagnostics.Process
  try {
    $process.StartInfo = New-Object Diagnostics.ProcessStartInfo
    $process.StartInfo.FileName = $Executable
    $process.StartInfo.Arguments = $Arguments
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    if (-not $process.Start()) { return $false }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      [Console]::WriteLine($stdout.Result + $stderr.Result)
      return $false
    }
    return $true
  } catch { [Console]::WriteLine($_.Exception.Message); return $false }
  finally { $process.Dispose() }
}
function Test-Tools {
try { foreach ($tool in @('node.exe','git\cmd\git.exe','ffmpeg\bin\ffmpeg.exe','ffmpeg\bin\ffprobe.exe','tools\pnpm\pnpm.exe')) {
  $argument = if ($tool.StartsWith('ffmpeg')) { '-version' } else { '--version' }
  if (-not (Test-NativeCommand (Join-Path $runtime.tools $tool) $argument)) { return $false }
}
return $true } catch { return $false }
}
function Test-Speech {
  return Test-NativeCommand (Join-Path $runtime.speech 'python\python.exe') '-c "import kokoro, misaki.zh, sherpa_onnx, fastapi, soundfile"'
}
Write-Output '检查 Python 语音运行环境（不下载语音模型）'
$refresh = @()
if (-not (Test-Tools)) { $refresh += 'tools' }
if (-not (Test-Speech)) { $refresh += 'speech' }
if ($refresh.Count -gt 0) {
  Write-Output ('修复不能正常运行的依赖组件：' + ($refresh -join ', '))
  & (Join-Path $PSScriptRoot 'bootstrap.ps1') -AppRoot $SourceRoot -DataRoot $DataRoot -Selection $selection -PrepareOnly -RefreshComponents $refresh
  $runtime = Get-Content -Raw -LiteralPath $selection | ConvertFrom-Json
  if (-not (Test-Tools) -or -not (Test-Speech)) { throw '重新安装后依赖组件仍无法运行，请查看 installer.log。' }
}
$browsers = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
if (-not ($browsers | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1)) {
  Write-FrameProgress 'browser' 'installing' '正在下载预览浏览器'
  Write-Output '未找到系统浏览器，安装工作台专用 Chromium'
  $previousBrowserPath = $env:PLAYWRIGHT_BROWSERS_PATH
  try {
    $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $DataRoot 'browsers'
    & (Join-Path $runtime.tools 'node.exe') (Join-Path $runtime.dependencies 'node_modules\playwright\cli.js') install chromium
    if ($LASTEXITCODE -ne 0) { throw 'Chromium 安装失败，请检查网络后重试。' }
  } finally { $env:PLAYWRIGHT_BROWSERS_PATH = $previousBrowserPath }
}
Write-FrameProgress 'browser' 'done' '预览浏览器已就绪'
$github=& (Join-Path $PSScriptRoot 'github-cli.ps1') -DataRoot $DataRoot -Node (Join-Path $runtime.tools 'node.exe')
Write-Output '运行环境检查通过，准备安装应用'
& (Join-Path $PSScriptRoot 'bootstrap.ps1') -AppRoot $SourceRoot -DataRoot $DataRoot -Selection (Join-Path $DataRoot 'runtime-selection.json') -LinkRoot $InstallRoot
$selected=Get-Content -Raw (Join-Path $DataRoot 'runtime-selection.json') | ConvertFrom-Json
$selected | Add-Member -NotePropertyName github -NotePropertyValue ([string]$github) -Force
$selected | ConvertTo-Json | Set-Content (Join-Path $DataRoot 'runtime-selection.json') -Encoding utf8

} finally { Stop-Transcript | Out-Null }
