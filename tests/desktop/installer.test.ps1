param([string]$DataRoot, [string]$BundleDirectory)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$version = (Get-Content -Raw (Join-Path $repo 'package.json') | ConvertFrom-Json).version
$fixture = Join-Path $repo '.cache\installer-smoke'
$application = Join-Path $fixture 'Application'
if (-not $DataRoot) { $DataRoot = Join-Path $fixture 'Data' }
$bundle = if ($BundleDirectory) { [IO.Path]::GetFullPath($BundleDirectory) } else { Join-Path $repo ".cache\release\FrameStudio-v$version-win-x64" }
$installer = "$bundle-Setup.exe"
$registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FRAMEStudio'
$shortcuts = Join-Path ([Environment]::GetFolderPath('Programs')) 'FRAME Studio'
if ((Test-Path $registry) -or (Test-Path -LiteralPath $shortcuts)) { throw 'Refusing installer smoke over an existing user installation.' }
New-Item -ItemType Directory -Force -Path $fixture,$DataRoot | Out-Null
$previousData = $env:FRAME_LOCAL_DATA
$previousPath = $env:PATH
$env:FRAME_LOCAL_DATA = $DataRoot
function Run-Setup([string]$File) {
  $process = Start-Process -FilePath $File -ArgumentList @('/S',('/D=' + $application)) -WindowStyle Hidden -Wait -PassThru
  return $process.ExitCode
}
function Remove-SmokeInstallation {
  if ((Test-Path $registry) -and (Get-ItemProperty $registry).InstallLocation -eq $application) {
    $process = Start-Process -FilePath (Join-Path $application 'Uninstall.exe') -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw 'Uninstaller failed.' }
  }
}
try {
  # Build a deliberately unavailable dependency variant from the same installer code.
  $brokenOutput = Join-Path $fixture 'broken'
  New-Item -ItemType Directory -Force -Path $brokenOutput | Out-Null
  $manifestFile = Join-Path $bundle 'desktop\runtime-manifest.json'
  $originalManifest = [IO.File]::ReadAllText($manifestFile)
  try {
    $manifest = $originalManifest | ConvertFrom-Json
    $manifest.components.tools.id = 'tools-installer-failure'
    $manifest.components.tools.url = 'https://127.0.0.1:1/unavailable.zip'
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestFile -Encoding utf8
    & (& (Join-Path $repo 'desktop\get-compiler.ps1')) /V2 "/DAppVersion=$version" "/DBundleDir=$bundle" "/DOutputDir=$brokenOutput" (Join-Path $repo 'desktop\installer.nsi')
    if ($LASTEXITCODE -ne 0) { throw 'Failure fixture compilation failed.' }
  } finally { [IO.File]::WriteAllText($manifestFile,$originalManifest,(New-Object Text.UTF8Encoding $false)) }
  $broken = Join-Path $brokenOutput "FrameStudio-v$version-win-x64-Setup.exe"
  if ((Run-Setup $broken) -eq 0 -or (Test-Path $registry)) { throw 'Failed prerequisites were marked installed.' }
  Copy-Item (Join-Path $DataRoot 'installer.log') (Join-Path $fixture 'failure.log') -Force
  if ((Run-Setup $installer) -ne 0) { throw 'Real installer failed; see installer.log.' }
  $installed = Join-Path $application "versions\$version"
  if ((Get-ItemProperty $registry).DisplayVersion -ne $version -or -not (Test-Path (Join-Path $shortcuts 'FRAME Studio.lnk'))) { throw 'Installer registration or shortcut missing.' }
  $selection = Get-Content -Raw (Join-Path $DataRoot 'runtime-selection.json') | ConvertFrom-Json
  $marker = Join-Path $selection.dependencies 'FRAME-RUNTIME.json'
  $before = (Get-Item $marker).LastWriteTimeUtc
  if (-not (Test-Path (Join-Path $installed 'node_modules\.modules.yaml'))) { throw 'Installed app does not resolve pnpm dependencies.' }
  $env:PATH = @($selection.tools,(Join-Path $selection.tools 'git\cmd'),(Join-Path $selection.tools 'ffmpeg\bin'),$previousPath) -join ';'
  Push-Location $installed
  try {
    & (Join-Path $selection.tools 'node.exe') --test tests/server/local-mode.test.mjs tests/server/model-downloads.test.mjs *> (Join-Path $fixture 'native-workbench.log')
    if ($LASTEXITCODE -ne 0) { throw 'Installed native workbench verification failed.' }
  } finally { Pop-Location }
  $appHash = (Get-FileHash (Join-Path $installed 'FrameStudio.exe')).Hash
  if ((Run-Setup $broken) -eq 0) { throw 'Broken repair unexpectedly succeeded.' }
  if ((Get-ItemProperty $registry).DisplayVersion -ne $version -or (Get-FileHash (Join-Path $installed 'FrameStudio.exe')).Hash -ne $appHash) { throw 'Failed dependency update changed the previous installation.' }
  $logStart = (Get-Content -Raw (Join-Path $DataRoot 'installer.log')).Length
  if ((Run-Setup $installer) -ne 0) { throw 'Repair installation failed.' }
  $repairLog = (Get-Content -Raw (Join-Path $DataRoot 'installer.log')).Substring($logStart)
  if ($repairLog -match '正在下载运行环境' -or (Get-Item $marker).LastWriteTimeUtc -ne $before) { throw 'Repair unnecessarily downloaded or reinstalled dependencies.' }
  $sentinel = Join-Path $DataRoot ('installer-test-preserve-' + [Guid]::NewGuid().ToString('N'))
  Set-Content -LiteralPath $sentinel 'User data must survive uninstall.'
  Remove-SmokeInstallation
  if ((Test-Path $registry) -or (Test-Path (Join-Path $installed 'FrameStudio.exe')) -or -not (Test-Path $marker) -or -not (Test-Path $sentinel)) { throw 'Uninstall did not preserve data and caches or remove registration.' }
  Remove-Item -LiteralPath $sentinel
  Write-Output 'PASS: actual EXE install, installed workbench, failed repair, cache reuse, shortcuts, registration and data-preserving uninstall.'
} finally {
  if (Test-Path (Join-Path $DataRoot 'installer.log')) { Copy-Item (Join-Path $DataRoot 'installer.log') (Join-Path $fixture 'install.log') -Force }
  Remove-SmokeInstallation
  $env:FRAME_LOCAL_DATA = $previousData
  $env:PATH = $previousPath
}
