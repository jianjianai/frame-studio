param([Parameter(Mandatory=$true)][string]$DataRoot,[Parameter(Mandatory=$true)][string]$Node)
$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
. (Join-Path $PSScriptRoot 'progress.ps1')
$entry=Get-Content -Raw (Join-Path $PSScriptRoot 'github-cli.json') | ConvertFrom-Json
$target=Join-Path $DataRoot ('runtimes\'+$entry.id)
$binary=Join-Path $target 'bin\gh.exe'
$marker=Join-Path $target 'FRAME-RUNTIME.json'
function Test-GitHubCli([string]$Executable){
  if(-not(Test-Path -LiteralPath $Executable)){return $false}
  $process=New-Object Diagnostics.Process
  try{
    $process.StartInfo=New-Object Diagnostics.ProcessStartInfo
    $process.StartInfo.FileName=$Executable
    $process.StartInfo.Arguments='--version'
    $process.StartInfo.UseShellExecute=$false
    $process.StartInfo.CreateNoWindow=$true
    $process.StartInfo.RedirectStandardOutput=$true
    $process.StartInfo.RedirectStandardError=$true
    if(-not $process.Start()){return $false}
    $stdout=$process.StandardOutput.ReadToEndAsync()
    $stderr=$process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit(15000)){$process.Kill();return $false}
    return $process.ExitCode -eq 0
  }catch{return $false}finally{$process.Dispose()}
}
$installed=Get-Command gh.exe -ErrorAction SilentlyContinue
if($installed -and (Test-GitHubCli $installed.Source)){Write-FrameProgress 'github' 'cached' '已检测到电脑上的 GitHub CLI';return ''}
if((Test-Path $marker) -and ((Get-Content -Raw $marker | ConvertFrom-Json).sha256 -eq $entry.sha256) -and (Test-GitHubCli $binary)){Write-FrameProgress 'github' 'cached' '复用 GitHub 授权工具';return (Split-Path -Parent $binary)}
$archive=Join-Path $DataRoot ('downloads\'+$entry.id+'.zip')
if(-not(Test-Path $archive)){Get-FrameDownload $entry.url $archive 'github' $entry.bytes}
Write-FrameProgress 'github' 'verifying' '正在校验 GitHub 授权工具'
if((Get-FileHash $archive).Hash.ToLowerInvariant() -ne $entry.sha256){Remove-Item -LiteralPath $archive;throw 'GitHub CLI checksum failed; retry to download again.'}
$stage=Join-Path $DataRoot ('runtimes\.github-install-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try{
  & $Node (Join-Path $PSScriptRoot 'extract.mjs') $archive $stage | ForEach-Object { [Console]::WriteLine($_) }
  if($LASTEXITCODE -ne 0){throw 'GitHub CLI extraction failed.'}
  $executables=@(Get-ChildItem -LiteralPath $stage -Filter 'gh.exe' -Recurse -File)
  if($executables.Length -ne 1 -or -not(Test-GitHubCli $executables[0].FullName)){throw 'GitHub CLI health check failed.'}
  $payload=Split-Path -Parent $executables[0].DirectoryName
  $entry | ConvertTo-Json | Set-Content (Join-Path $payload 'FRAME-RUNTIME.json') -Encoding utf8
  if(Test-Path $target){Move-Item -LiteralPath $target -Destination ($target+'.incomplete-'+[Guid]::NewGuid().ToString('N'))}
  Move-Item -LiteralPath $payload -Destination $target
  Write-FrameProgress 'github' 'done' 'GitHub 授权工具已就绪'
  return (Split-Path -Parent $binary)
}finally{
  if(-not([IO.Path]::GetFullPath($stage)).StartsWith(([IO.Path]::GetFullPath((Join-Path $DataRoot 'runtimes')))+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected GitHub CLI cleanup path.'}
  if(Test-Path $stage){Remove-Item -LiteralPath $stage -Recurse -Force}
}
