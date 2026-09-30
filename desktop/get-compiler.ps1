$ErrorActionPreference = 'Stop'
$root = Join-Path (Split-Path -Parent $PSScriptRoot) '.cache\build-tools\nsis'
$compiler = Join-Path $root 'nsis-3.12\makensis.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  $archive = Join-Path $root 'nsis-3.12.zip'
  $url = 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.12/nsis-3.12.zip'
  Invoke-WebRequest -Uri $url -OutFile $archive -TimeoutSec 180
  $expected = '56581f90db321581c5381193d796fffcf2d24b2f8fed2160a6c6a3baa67f2c4f'
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    # Some SourceForge regions return the public download landing page first.
    $landing = Get-Content -Raw -LiteralPath $archive
    $download = [Net.WebUtility]::HtmlDecode([regex]::Match($landing,'https://downloads\.sourceforge\.net/project/nsis/NSIS%203/3\.12/nsis-3\.12\.zip\?ts=[^"<> ]+').Value)
    if (-not $download) { throw 'NSIS compiler checksum mismatch.' }
    Invoke-WebRequest -Uri $download -OutFile $archive -TimeoutSec 180
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'NSIS compiler checksum mismatch.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($archive,$root)
}
Write-Output $compiler
