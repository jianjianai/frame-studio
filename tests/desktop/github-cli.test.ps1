param([string]$CacheDownloadDirectory, [switch]$Worker, [string]$DataRoot, [string]$Node)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$entry = Get-Content -Raw (Join-Path $repo 'desktop\github-cli.json') | ConvertFrom-Json
if ($Worker) {
  $env:PSModulePath = Join-Path $PSHOME 'Modules'
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
  $previousPath = $env:PATH
  $env:PATH = Join-Path $env:SystemRoot 'System32'
  try {
    $expected = Join-Path $DataRoot ('runtimes\'+$entry.id+'\bin')
    $first = @(& (Join-Path $repo 'desktop\github-cli.ps1') -DataRoot $DataRoot -Node $Node)
    if ($first.Count -ne 1 -or $first[0] -ne $expected -or -not (Test-Path (Join-Path $first[0] 'gh.exe'))) {
      throw 'First-time provisioning returned logs instead of a single usable PATH directory.'
    }
    & (Join-Path $first[0] 'gh.exe') --version
    if ($LASTEXITCODE -ne 0) { throw 'The downloaded GitHub CLI did not run.' }
    $marker = Join-Path $DataRoot ('runtimes\'+$entry.id+'\FRAME-RUNTIME.json')
    $timestamp = (Get-Item $marker).LastWriteTimeUtc
    $archive = Join-Path $DataRoot ('downloads\'+$entry.id+'.zip')
    Move-Item -LiteralPath $archive -Destination ($archive+'.retained')
    $second = @(& (Join-Path $repo 'desktop\github-cli.ps1') -DataRoot $DataRoot -Node $Node)
    if ($second.Count -ne 1 -or $second[0] -ne $expected -or (Get-Item $marker).LastWriteTimeUtc -ne $timestamp -or (Test-Path $archive)) {
      throw 'An installed GitHub CLI was not reused without downloading or replacing it.'
    }
    Write-Output 'PASS: missing GitHub CLI is verified and installed under PowerShell 5; its PATH is valid and updates reuse it.'
  } finally { $env:PATH = $previousPath }
  exit 0
}
$fixture = Join-Path $repo ('.cache\github-cli-test-'+[Guid]::NewGuid().ToString('N'))
$data = Join-Path $fixture 'Data'
New-Item -ItemType Directory -Path (Join-Path $data 'downloads') -Force | Out-Null
try {
  if ($CacheDownloadDirectory) {
    Copy-Item -LiteralPath (Join-Path $CacheDownloadDirectory ($entry.id+'.zip')) -Destination (Join-Path $data 'downloads')
  }
  $nodeBinary = (Get-Command node.exe).Source
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath -Worker -DataRoot $data -Node $nodeBinary
  if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI provisioning test failed.' }
} finally {
  if (-not ([IO.Path]::GetFullPath($fixture)).StartsWith((Join-Path $repo '.cache\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected test cleanup path.' }
  Remove-Item -LiteralPath $fixture -Recurse -Force
}
