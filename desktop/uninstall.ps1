param([Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$registered = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FRAMEStudio').InstallLocation
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($root -ne [IO.Path]::GetFullPath($registered).TrimEnd('\')) { throw 'Uninstall directory differs from registered installation.' }
$versions = Join-Path $root 'versions'
function Remove-ApplicationEntry([string]$Target) {
  $full = [IO.Path]::GetFullPath($Target)
  if ($full -ne $versions -and -not $full.StartsWith($versions + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Uninstall path escaped application versions.' }
  $entry = Get-Item -LiteralPath $full -Force
  if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    if ($entry.PSIsContainer) { [IO.Directory]::Delete($full) } else { [IO.File]::Delete($full) }
  } elseif ($entry.PSIsContainer) {
    foreach ($child in Get-ChildItem -LiteralPath $full -Force) { Remove-ApplicationEntry $child.FullName }
    [IO.Directory]::Delete($full)
  } else { [IO.File]::Delete($full) }
}
if (Test-Path -LiteralPath $versions) { Remove-ApplicationEntry $versions }
Write-Output 'Application removed. Projects, models and dependency caches have been preserved.'
