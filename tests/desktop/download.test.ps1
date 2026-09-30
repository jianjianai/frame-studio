$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$fixture = Join-Path $repo ('.cache\download-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$server = $null
$previousTest = $env:FRAME_DESKTOP_TEST
$env:FRAME_DESKTOP_TEST = '1'
try {
  $ready = Join-Path $fixture 'server.json'
  $server = Start-Process (Get-Command node.exe).Source -ArgumentList @(('"'+(Join-Path $PSScriptRoot 'download-server.mjs')+'"'),('"'+$ready+'"')) -WindowStyle Hidden -PassThru
  for ($i=0; $i -lt 100 -and -not (Test-Path $ready); $i++) { Start-Sleep -Milliseconds 100 }
  $info = Get-Content -Raw $ready | ConvertFrom-Json
  . (Join-Path $repo 'desktop\progress.ps1')
  $seed = New-Object byte[] 65536
  for ($i=0; $i -lt $seed.Length; $i++) { $seed[$i]=37 }
  foreach ($route in @('resume','ignore')) {
    $target = Join-Path $fixture "$route.zip"
    [IO.File]::WriteAllBytes($target+'.part',$seed)
    Get-FrameDownload ($info.origin+'/'+$route) $target 'tools' $info.bytes
    if ((Get-FileHash $target).Hash.ToLowerInvariant() -ne $info.digest) { throw "PowerShell resumed download failed: $route" }
  }
  $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  $executable = Join-Path $fixture 'updates-test.exe'
  & $compiler /nologo /target:exe "/out:$executable" /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll (Join-Path $repo 'desktop\DesktopUi.cs') (Join-Path $repo 'desktop\DesktopUpdates.cs') (Join-Path $PSScriptRoot 'UpdatesTest.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Update tests did not compile.' }
  & $executable (Join-Path $fixture 'updates') $info.origin $info.digest
  if ($LASTEXITCODE -ne 0) { throw 'Update verification failed.' }
  $requests = Invoke-RestMethod ($info.origin+'/stats')
  if (-not ($requests | Where-Object { $_.url -eq '/resume' -and $_.range -eq 'bytes=65536-' })) { throw 'Resume test did not actually use HTTP Range.' }
  Write-Output 'PASS: dependency downloads and app updates resume, retry, verify and reject unsafe releases.'
} finally {
  if ($server -and -not $server.HasExited) { $server.Kill(); $server.WaitForExit() }
  $env:FRAME_DESKTOP_TEST=$previousTest
  if (-not ([IO.Path]::GetFullPath($fixture)).StartsWith((Join-Path $repo '.cache\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected test cleanup path.' }
  Remove-Item -LiteralPath $fixture -Recurse -Force
}
