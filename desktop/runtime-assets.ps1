param(
  [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$AssetDirectory
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $RepositoryRoot).Path
if (-not $AssetDirectory) { $AssetDirectory = Join-Path $repo '.cache\runtime-assets' }
New-Item -ItemType Directory -Force -Path $AssetDirectory | Out-Null
$versions = Get-Content -Raw (Join-Path $repo 'desktop\runtime-versions.json') | ConvertFrom-Json
$speechDigest = (Get-FileHash (Join-Path $repo 'speech\requirements-win.txt') -Algorithm SHA256).Hash.ToLowerInvariant().Substring(0,12)
$ids = @{tools=$versions.tools;speech="$($versions.speech)-$speechDigest"}
$components = @{}
$missing = @()
$remoteAssets = $null
foreach ($kind in @('tools','speech')) {
  $id = $ids[$kind]
  $descriptor = Join-Path $AssetDirectory "$id.json"
  if (-not (Test-Path -LiteralPath $descriptor)) {
    if ($null -eq $remoteAssets) {
      $remoteText = & gh release view windows-runtimes --repo jianjianai/frame-studio --json assets 2>&1
      if ($LASTEXITCODE -eq 0) { $remoteAssets = @(($remoteText | ConvertFrom-Json).assets) }
      elseif (($remoteText | Out-String) -match 'release not found') { $remoteAssets = @() }
      else { throw 'Cannot resolve published runtime components; check GitHub access and retry.' }
    }
    $asset = $remoteAssets | Where-Object { $_.name -eq "$id.zip" -and $_.state -eq 'uploaded' } | Select-Object -First 1
    if ($asset) {
      if ($asset.digest -notmatch '^sha256:([a-f0-9]{64})$') { throw "Published runtime lacks a verifiable digest: $id" }
      @{id=$id;url="https://github.com/jianjianai/frame-studio/releases/download/windows-runtimes/$id.zip";sha256=$Matches[1];bytes=$asset.size} | ConvertTo-Json | Set-Content -LiteralPath $descriptor -Encoding utf8
    }
  }
  if (Test-Path -LiteralPath $descriptor) {
    $entry = Get-Content -Raw $descriptor | ConvertFrom-Json
    $expectedUrl = "https://github.com/jianjianai/frame-studio/releases/download/windows-runtimes/$id.zip"
    if ($entry.id -ne $id -or $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or $entry.bytes -le 0 -or $entry.url -ne $expectedUrl) { throw "Invalid runtime descriptor: $descriptor" }
    $components[$kind] = $entry
  } else { $missing += $kind }
}
[pscustomobject]@{Ids=$ids;Components=$components;Missing=$missing}
