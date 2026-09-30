param(
  [Parameter(Mandatory=$true)][string]$AppRoot,
  [Parameter(Mandatory=$true)][string]$DataRoot,
  [Parameter(Mandatory=$true)][string]$Selection,
  [string]$LinkRoot,
  [switch]$PrepareOnly,
  [ValidateSet('tools','speech')][string[]]$RefreshComponents = @(),
  [switch]$LocalAssets
)
$ErrorActionPreference = 'Stop'
# A caller using PowerShell 7 can pass its incompatible module search path to 5.1.
# Provisioning needs only the modules shipped with the PowerShell running this file.
$env:PSModulePath = Join-Path $PSHOME 'Modules'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem
$app = [IO.Path]::GetFullPath($AppRoot)
$cache = Join-Path ([IO.Path]::GetFullPath($DataRoot)) 'runtimes'
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$manifest = Get-Content -Raw -LiteralPath (Join-Path $app 'desktop\runtime-manifest.json') | ConvertFrom-Json
if ($manifest.schema -ne 2) { throw 'Unsupported runtime manifest.' }
$lock = [IO.File]::Open((Join-Path $cache 'install.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$selected = @{}
try {
  foreach ($abandoned in Get-ChildItem -LiteralPath $cache -Directory) {
    if ($abandoned.Name -match '^(?:[a-z0-9-]+\.install-[a-f0-9]{32}|\.i-[a-f0-9]{16})$' -and ($abandoned.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
      if (-not $abandoned.FullName.StartsWith($cache + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected abandoned installer path.' }
      $cleanupNode = Join-Path $abandoned.FullName 'node.exe'
      if (-not (Test-Path -LiteralPath $cleanupNode)) { $cleanupNode = Join-Path (Join-Path $cache $manifest.components.tools.id) 'node.exe' }
      $abandonedStage = Join-Path $abandoned.FullName 'files'
      if ((Test-Path -LiteralPath $abandonedStage) -and (Test-Path -LiteralPath $cleanupNode)) {
        & $cleanupNode (Join-Path $app 'desktop\extract.mjs') --cleanup-stage $abandonedStage
        if ($LASTEXITCODE -ne 0) { throw 'Interrupted runtime cleanup failed.' }
      }
      Remove-Item -LiteralPath $abandoned.FullName -Recurse -Force
    }
  }
  foreach ($kind in @('tools','speech')) {
    $entry = $manifest.components.$kind
    if ($entry.id -notmatch '^[a-z0-9-]{1,120}$' -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid runtime identity or checksum.' }
    $uri = [Uri]$entry.url
    if ($uri.Scheme -ne 'https' -and -not $LocalAssets) { throw 'Runtime downloads require HTTPS.' }
    $destination = Join-Path $cache $entry.id
    $marker = Join-Path $destination 'FRAME-RUNTIME.json'
    if (Test-Path -LiteralPath $marker) {
      $installed = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
      if ($installed.sha256 -ne $entry.sha256) { throw 'Published runtime checksum changed; refusing to replace an immutable component.' }
      $requiredExecutable = if ($kind -eq 'tools') { 'node.exe' } else { 'python\python.exe' }
      if ($RefreshComponents -notcontains $kind -and (Test-Path -LiteralPath (Join-Path $destination $requiredExecutable))) {
        Write-Output "复用已安装运行环境：$kind"
        $selected[$kind] = $destination
        continue
      }
    }
    $temporary = Join-Path $cache ('.i-' + [Guid]::NewGuid().ToString('N').Substring(0,16))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    $extractNode = $null
    $stage = $null
    try {
      $archivePath = Join-Path $temporary 'runtime.zip'
      Write-Output "正在下载运行环境：$kind"
      if ($uri.Scheme -eq 'file' -and $LocalAssets) {
        Copy-Item -LiteralPath $uri.LocalPath -Destination $archivePath
      } else {
        $request = [Net.HttpWebRequest]::Create($uri)
        $request.UserAgent = 'FRAME-Studio-Windows-Installer'
        $request.Timeout = 60000
        $response = $request.GetResponse()
        $inputStream = $response.GetResponseStream()
        $outputStream = [IO.File]::Create($archivePath)
        try {
          $buffer = New-Object byte[] 1048576
          $received = 0L
          $reported = 0L
          while (($count = $inputStream.Read($buffer,0,$buffer.Length)) -gt 0) {
            $outputStream.Write($buffer,0,$count)
            $received += $count
            if ($received - $reported -ge 16777216) {
              Write-Output "正在下载 $kind：$([Math]::Round($received/1MB)) MiB"
              $reported = $received
            }
          }
        } finally { $outputStream.Dispose(); $inputStream.Dispose(); $response.Dispose() }
      }
      $digest = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($digest -ne $entry.sha256) { throw "运行环境校验失败：$kind，请重新启动以重试。" }
      $stage = Join-Path $temporary 'files'
      New-Item -ItemType Directory -Path $stage | Out-Null
      if ($kind -eq 'tools') {
        $extractNode = Join-Path $temporary 'node.exe'
        $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
        try {
          $nodeEntry = $archive.GetEntry('node.exe')
          if (-not $nodeEntry) { throw 'Tools archive is missing Node.' }
          [IO.Compression.ZipFileExtensions]::ExtractToFile($nodeEntry,$extractNode)
        } finally { $archive.Dispose() }
      } else { $extractNode = Join-Path $selected.tools 'node.exe' }
      Write-Output "正在安装运行环境：$kind"
      & $extractNode (Join-Path $app 'desktop\extract.mjs') $archivePath $stage
      if ($LASTEXITCODE -ne 0) { throw "Runtime extraction failed: $kind" }
      $entry | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stage 'FRAME-RUNTIME.json') -Encoding utf8
      if (Test-Path -LiteralPath $destination) { Move-Item -LiteralPath $destination -Destination ($destination + '.incomplete-' + [Guid]::NewGuid().ToString('N')) }
      Move-Item -LiteralPath $stage -Destination $destination
      $selected[$kind] = $destination
    } finally {
      if (-not ([IO.Path]::GetFullPath($temporary)).StartsWith($cache + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected installer cleanup path.' }
      if ($stage -and (Test-Path -LiteralPath $stage) -and $extractNode -and (Test-Path -LiteralPath $extractNode)) {
        & $extractNode (Join-Path $app 'desktop\extract.mjs') --cleanup-stage $stage
      }
      Remove-Item -LiteralPath $temporary -Recurse -Force
    }
  }
  & (Join-Path $selected.tools 'node.exe') (Join-Path $app 'desktop\dependencies.mjs') install $app $cache $selected.tools
  if ($LASTEXITCODE -ne 0) { throw 'Node 依赖安装失败，请查看 pnpm 日志；重新启动可继续安装。' }
  $selected.dependencies = Join-Path $cache $manifest.dependencies.id
  if ($PrepareOnly) {
    $selected | ConvertTo-Json | Set-Content -LiteralPath $Selection -Encoding utf8
    Write-Output '依赖缓存已就绪'
    return
  }
  $linkDirectory = if ($LinkRoot) { [IO.Path]::GetFullPath($LinkRoot) } else { $app }
  New-Item -ItemType Directory -Path $linkDirectory -Force | Out-Null
  $link = Join-Path $linkDirectory 'node_modules'
  $dependencyModules = Join-Path $selected.dependencies 'node_modules'
  if (Test-Path -LiteralPath $link) {
    $current = Get-Item -LiteralPath $link -Force
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw '程序目录已有非安装器管理的 node_modules，请选择新的安装目录。' }
    $currentTarget = [string]@($current.Target)[0]
    if (-not ([IO.Path]::GetFullPath($currentTarget)).StartsWith($cache + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Existing dependency junction is not managed by this installer.' }
    if ($currentTarget -ne $dependencyModules) { [IO.Directory]::Delete($link) }
  }
  if (-not (Test-Path -LiteralPath $link)) { New-Item -ItemType Junction -Path $link -Target $dependencyModules | Out-Null }
  $selected | ConvertTo-Json | Set-Content -LiteralPath $Selection -Encoding utf8
  Write-Output '运行环境已就绪'
} finally { $lock.Dispose() }
