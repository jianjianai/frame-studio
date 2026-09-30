param(
  [string]$OutputDirectory,
  [switch]$IncludeSpeech,
  [string]$SpeechBundle
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifest = Get-Content -Raw -LiteralPath (Join-Path $repo 'package.json') | ConvertFrom-Json
$version = $manifest.version
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo ".cache\release\FrameStudio-v$version-win-x64" }
$bundle = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $bundle.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The release bundle must be created inside this checkout.'
}
if (Test-Path -LiteralPath $bundle) { throw "Release bundle already exists: $bundle" }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$gitSource = (Get-Command git.exe -ErrorAction Stop).Source
$gitRoot = Split-Path -Parent (Split-Path -Parent $gitSource)
if (-not (Test-Path -LiteralPath (Join-Path $gitRoot 'mingw64\bin\git.exe'))) { throw "Unsupported Git layout: $gitSource" }
$ffmpegSource = (Get-Command ffmpeg.exe -ErrorAction Stop).Source
$ffmpegRoot = Split-Path -Parent (Split-Path -Parent $ffmpegSource)
if ((Split-Path -Leaf $ffmpegRoot) -eq 'chocolatey') {
  $real = Get-ChildItem -LiteralPath (Join-Path $ffmpegRoot 'lib\ffmpeg') -Recurse -Filter ffmpeg.exe -File |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'ffprobe.exe') } | Select-Object -First 1
  if (-not $real) { throw 'Could not find the FFmpeg files behind the Chocolatey shim.' }
  $ffmpegRoot = Split-Path -Parent $real.DirectoryName
}
if (-not (Test-Path -LiteralPath (Join-Path $ffmpegRoot 'bin\ffprobe.exe'))) { throw 'FFmpeg and FFprobe are both required.' }
$pnpmRoot = Join-Path (& npm root -g) 'pnpm'
if (-not (Test-Path -LiteralPath (Join-Path $pnpmRoot 'pnpm.exe'))) { throw 'Global pnpm installation is required for packaging.' }
& pnpm build:studio
if ($LASTEXITCODE -ne 0) { throw 'Studio build failed.' }
& (Join-Path $PSScriptRoot 'build.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Tray build failed.' }
& pnpm deploy $bundle --node-linker=hoisted --trust-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Standalone dependency deployment failed.' }
Copy-Item -LiteralPath (Join-Path $repo 'studio-dist') -Destination (Join-Path $bundle 'studio-dist') -Recurse
Copy-Item -LiteralPath (Join-Path $repo '.cache\desktop\FrameStudio.exe') -Destination (Join-Path $bundle 'FrameStudio.exe')
Copy-Item -LiteralPath $node -Destination (Join-Path $bundle 'node.exe')
Copy-Item -LiteralPath $gitRoot -Destination (Join-Path $bundle 'git') -Recurse
Copy-Item -LiteralPath $ffmpegRoot -Destination (Join-Path $bundle 'ffmpeg') -Recurse
New-Item -ItemType Directory -Path (Join-Path $bundle 'tools') | Out-Null
Copy-Item -LiteralPath $pnpmRoot -Destination (Join-Path $bundle 'tools\pnpm') -Recurse
if ($IncludeSpeech -and $SpeechBundle) { throw 'Choose IncludeSpeech or SpeechBundle.' }
if ($IncludeSpeech) { & (Join-Path $PSScriptRoot 'build-speech.ps1') -Bundle $bundle }
if ($SpeechBundle) {
  $speechSource = [IO.Path]::GetFullPath($SpeechBundle)
  foreach ($directory in @('python', 'speech-models')) {
    $source = Join-Path $speechSource $directory
    if (-not (Test-Path -LiteralPath $source)) { throw "Missing reusable speech directory: $source" }
    Copy-Item -LiteralPath $source -Destination (Join-Path $bundle $directory) -Recurse
  }
  & node (Join-Path $repo 'desktop\smoke-speech.mjs') $bundle
  if ($LASTEXITCODE -ne 0) { throw 'Reusable speech bundle failed its synthesis check.' }
}
Push-Location $bundle
try {
  & '.\node.exe' --input-type=module -e 'await import("./server/local-app.mjs"); console.log("Desktop imports OK")'
  if ($LASTEXITCODE -ne 0) { throw 'Bundled application import failed.' }
  & '.\git\cmd\git.exe' --version
  if ($LASTEXITCODE -ne 0) { throw 'Bundled Git failed.' }
  & '.\ffmpeg\bin\ffmpeg.exe' -version | Select-Object -First 1
  if ($LASTEXITCODE -ne 0) { throw 'Bundled FFmpeg failed.' }
  & '.\tools\pnpm\pnpm.exe' --version
  if ($LASTEXITCODE -ne 0) { throw 'Bundled pnpm failed.' }
} finally { Pop-Location }
$zip = "$bundle.zip"
if (Test-Path -LiteralPath $zip) { throw "Release archive already exists: $zip" }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($bundle, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
$digest = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$zip.sha256" -Value "$digest  $(Split-Path -Leaf $zip)" -Encoding ascii
Write-Output $zip
Write-Output $digest
