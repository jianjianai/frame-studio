param([string]$OutputDirectory, [string]$RuntimeBundle, [switch]$PublishRuntimes)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content -Raw (Join-Path $repo 'package.json') | ConvertFrom-Json
$versions = Get-Content -Raw (Join-Path $PSScriptRoot 'runtime-versions.json') | ConvertFrom-Json
$version = $manifest.version
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo ".cache\release\FrameStudio-v$version-win-x64" }
$bundle = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $bundle.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'The bundle must be created inside this checkout.' }
if (Test-Path -LiteralPath $bundle) { throw "Bundle already exists: $bundle" }
$assetDirectory = Join-Path $repo '.cache\runtime-assets'
New-Item -ItemType Directory -Force -Path $assetDirectory | Out-Null
$dependencies = (& node (Join-Path $PSScriptRoot 'dependencies.mjs') fingerprint $repo) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Dependency fingerprint failed.' }
$speechDigest = (Get-FileHash (Join-Path $repo 'speech\requirements-win.txt') -Algorithm SHA256).Hash.ToLowerInvariant().Substring(0,12)
$ids = @{tools=$versions.tools;speech="$($versions.speech)-$speechDigest"}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$components = @{}
foreach ($kind in @('tools','speech')) {
  $id = $ids[$kind]
  $descriptor = Join-Path $assetDirectory "$id.json"
  # Existing published components are immutable and are reused across app versions.
  if (-not (Test-Path -LiteralPath $descriptor)) {
    & gh release download windows-runtimes --repo jianjianai/frame-studio --pattern "$id.json" --dir $assetDirectory 2>$null
    if (-not (Test-Path -LiteralPath $descriptor)) {
      $publishedText = & gh release view windows-runtimes --repo jianjianai/frame-studio --json assets 2>$null
      if ($LASTEXITCODE -eq 0) {
        $published = ($publishedText | ConvertFrom-Json).assets | Where-Object { $_.name -eq "$id.zip" -and $_.state -eq 'uploaded' } | Select-Object -First 1
        if ($published) {
          if ($published.digest -notmatch '^sha256:([a-f0-9]{64})$') { throw 'Published runtime lacks a verifiable digest.' }
          @{id=$id;url="https://github.com/jianjianai/frame-studio/releases/download/windows-runtimes/$id.zip";sha256=$Matches[1];bytes=$published.size} | ConvertTo-Json | Set-Content -LiteralPath $descriptor -Encoding utf8
        }
      }
    }
  }
  if (Test-Path -LiteralPath $descriptor) {
    $entry = Get-Content -Raw $descriptor | ConvertFrom-Json
    if ($entry.id -ne $id -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw "Invalid runtime descriptor: $descriptor" }
    $components[$kind] = $entry
    continue
  }
  $stage = Join-Path $repo ".cache\runtime-build\$id"
  if (Test-Path -LiteralPath $stage) { throw "Runtime staging exists: $stage" }
  New-Item -ItemType Directory -Path $stage -Force | Out-Null
  if ($kind -eq 'tools') {
    $node = (Get-Command node.exe).Source
    if ((& $node --version) -ne "v$($versions.node)") { throw 'Node version differs from runtime-versions.json; update the component version intentionally.' }
    $gitSource = (Get-Command git.exe).Source
    $gitRoot = Split-Path -Parent (Split-Path -Parent $gitSource)
    if (-not (Test-Path (Join-Path $gitRoot 'mingw64\bin\git.exe'))) { throw 'Unsupported Git layout.' }
    $ffmpegSource = (Get-Command ffmpeg.exe).Source
    $ffmpegRoot = Split-Path -Parent (Split-Path -Parent $ffmpegSource)
    if ((Split-Path -Leaf $ffmpegRoot) -eq 'chocolatey') {
      $real = Get-ChildItem (Join-Path $ffmpegRoot 'lib\ffmpeg') -Recurse -Filter ffmpeg.exe -File | Where-Object { Test-Path (Join-Path $_.DirectoryName 'ffprobe.exe') } | Select-Object -First 1
      if (-not $real) { throw 'FFmpeg shim target not found.' }
      $ffmpegRoot = Split-Path -Parent $real.DirectoryName
    }
    $pnpmRoot = Join-Path (& npm root -g) 'pnpm'
    Copy-Item -LiteralPath $node -Destination (Join-Path $stage 'node.exe')
    Copy-Item -LiteralPath $gitRoot -Destination (Join-Path $stage 'git') -Recurse
    New-Item -ItemType Directory -Path (Join-Path $stage 'ffmpeg\bin'),(Join-Path $stage 'tools\pnpm') -Force | Out-Null
    foreach ($exe in @('ffmpeg.exe','ffprobe.exe')) { Copy-Item -LiteralPath (Join-Path $ffmpegRoot "bin\$exe") -Destination (Join-Path $stage "ffmpeg\bin\$exe") }
    foreach ($license in @('LICENSE','README.txt')) { if (Test-Path (Join-Path $ffmpegRoot $license)) { Copy-Item (Join-Path $ffmpegRoot $license) (Join-Path $stage 'ffmpeg') } }
    Copy-Item (Join-Path $pnpmRoot 'pnpm.exe') (Join-Path $stage 'tools\pnpm\pnpm.exe')
    foreach ($exe in @('node.exe','git\cmd\git.exe','ffmpeg\bin\ffmpeg.exe','ffmpeg\bin\ffprobe.exe','tools\pnpm\pnpm.exe')) {
      $argument = if ($exe.StartsWith('ffmpeg')) { '-version' } else { '--version' }
      & (Join-Path $stage $exe) $argument *> $null
      if ($LASTEXITCODE -ne 0) { throw "Runtime tool failed: $exe" }
    }
  } else {
    if ($RuntimeBundle) { Copy-Item -LiteralPath (Join-Path ([IO.Path]::GetFullPath($RuntimeBundle)) 'python') -Destination (Join-Path $stage 'python') -Recurse }
    else { & (Join-Path $PSScriptRoot 'build-speech.ps1') -Bundle $stage }
    & (Join-Path $stage 'python\python.exe') -c 'import kokoro, misaki.zh, sherpa_onnx, fastapi, soundfile; print("Speech runtime OK")'
    if ($LASTEXITCODE -ne 0) { throw 'Speech runtime check failed.' }
  }
  $archive = Join-Path $assetDirectory "$id.zip"
  [IO.Compression.ZipFile]::CreateFromDirectory($stage,$archive,[IO.Compression.CompressionLevel]::Optimal,$false)
  $entry = @{id=$id;url="https://github.com/jianjianai/frame-studio/releases/download/windows-runtimes/$id.zip";sha256=(Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant();bytes=(Get-Item $archive).Length}
  $entry | ConvertTo-Json | Set-Content -LiteralPath $descriptor -Encoding utf8
  $components[$kind] = $entry
}
if ($PublishRuntimes) {
  & gh release view windows-runtimes --repo jianjianai/frame-studio *> $null
  if ($LASTEXITCODE -ne 0) {
    & gh release create windows-runtimes --repo jianjianai/frame-studio --title 'Windows runtime components' --notes 'Immutable cached dependencies used by the Windows installer. Models are downloaded separately on demand.' --latest=false
    if ($LASTEXITCODE -ne 0) { throw 'Runtime release creation failed.' }
  }
  $remoteNames = & gh release view windows-runtimes --repo jianjianai/frame-studio --json assets --jq '.assets[].name'
  $remoteAssets = (& gh release view windows-runtimes --repo jianjianai/frame-studio --json assets | ConvertFrom-Json).assets
  foreach ($entry in $components.Values) {
    $existing = $remoteAssets | Where-Object { $_.name -eq "$($entry.id).zip" } | Select-Object -First 1
    if ($existing -and $existing.digest -ne "sha256:$($entry.sha256)") { throw 'An immutable runtime archive differs from its descriptor.' }
    foreach ($suffix in @('zip','json')) {
      $name = "$($entry.id).$suffix"
      if ($remoteNames -contains $name) { continue }
      & gh release upload windows-runtimes (Join-Path $assetDirectory $name) --repo jianjianai/frame-studio
      if ($LASTEXITCODE -ne 0) { throw "Runtime asset upload failed: $name" }
    }
  }
}
& pnpm build:studio
if ($LASTEXITCODE -ne 0) { throw 'Studio build failed.' }
& (Join-Path $PSScriptRoot 'build.ps1')
$pack = (& pnpm pack --dry-run --json --skip-manifest-obfuscation) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Application file listing failed.' }
foreach ($name in (@($pack.files.path) + @('pnpm-lock.yaml','pnpm-workspace.yaml','.npmrc') | Sort-Object -Unique)) {
  $target = [IO.Path]::GetFullPath((Join-Path $bundle $name))
  if (-not $target.StartsWith($bundle + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid application file path.' }
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repo $name) -Destination $target
}
Copy-Item -LiteralPath (Join-Path $repo 'studio-dist') -Destination (Join-Path $bundle 'studio-dist') -Recurse
Copy-Item -LiteralPath (Join-Path $repo '.cache\desktop\FrameStudio.exe') -Destination (Join-Path $bundle 'FrameStudio.exe')
@{schema=2;components=$components;dependencies=$dependencies} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $bundle 'desktop\runtime-manifest.json') -Encoding utf8
$zip = "$bundle.zip"
[IO.Compression.ZipFile]::CreateFromDirectory($bundle,$zip,[IO.Compression.CompressionLevel]::Optimal,$false)
$digest=(Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$zip.sha256" -Value "$digest  $(Split-Path -Leaf $zip)" -Encoding ascii
Write-Output "$zip ($((Get-Item $zip).Length) bytes)"
