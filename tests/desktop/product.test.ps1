param([string]$CacheData, [string]$BundleDirectory)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$version=(Get-Content -Raw (Join-Path $repo 'package.json') | ConvertFrom-Json).version
$fixture=Join-Path $repo ('.cache\desktop-product-smoke-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
$application=Join-Path $fixture 'Application'
$data=Join-Path $fixture 'Data'
$screens=Join-Path $fixture 'screens'
$bundle=if($BundleDirectory){[IO.Path]::GetFullPath($BundleDirectory)}else{Join-Path $repo ".cache\release\FrameStudio-v$version-win-x64"}
$registry='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FRAMEStudioTest'
if(Test-Path $registry){throw 'A test installation already exists; preserve it until its owner finishes.'}
$previousData=$env:FRAME_LOCAL_DATA
$previousTest=$env:FRAME_DESKTOP_TEST
$env:FRAME_LOCAL_DATA=$data
$env:FRAME_DESKTOP_TEST='1'
$client=$null
$reservation=$null
New-Item -ItemType Directory -Force -Path $fixture,$data,$screens | Out-Null
try {
  if($CacheData -and -not(Test-Path (Join-Path $data 'runtimes'))){New-Item -ItemType Junction -Path (Join-Path $data 'runtimes') -Target (Join-Path ([IO.Path]::GetFullPath($CacheData)) 'runtimes') | Out-Null}
  $setup=Start-Process -FilePath "$bundle-Setup.exe" -ArgumentList @('/S',('/D='+$application)) -WindowStyle Hidden -Wait -PassThru
  if($setup.ExitCode -ne 0){throw 'Product installation failed; see Data/installer.log.'}
  $uninstaller=Join-Path $fixture 'uninstall-source.exe'
  Copy-Item (Join-Path $application 'Uninstall.exe') $uninstaller -Force
  $helper=Start-Process (Join-Path $bundle 'FrameSetup.exe') -ArgumentList @('--test-ui','--source',('"'+$bundle+'"'),'--root',('"'+$application+'"'),'--version',$version,'--uninstaller',('"'+$uninstaller+'"'),'--test-output',('"'+$screens+'"')) -WindowStyle Hidden -PassThru
  if(-not $helper.WaitForExit(120000)){ $helper.Kill();throw 'Installer UI did not finish.' }
  $installResult=Get-Content -Raw (Join-Path $screens 'installer-result.json') | ConvertFrom-Json
  if(-not $installResult.done){throw ('Installer UI failed: '+$installResult.status)}
  Write-Output 'PASS: branded installer controls complete a real installation and expose progress.'
  # The old fixed port is occupied: the new client must choose its own endpoint.
  $reservation=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,43173)
  try{$reservation.Start()}catch{$reservation=$null}
  $executable=Join-Path $application "versions\$version\FrameStudio.exe"
  $client=Start-Process $executable -ArgumentList @('--control-center','--test-ui','--test-output',('"'+$screens+'"')) -WindowStyle Hidden -PassThru
  $ready=Join-Path $data 'desktop-test-ready.json'
  for($i=0;$i -lt 600 -and -not(Test-Path $ready);$i++){if($client.HasExited){throw 'Windows center exited before its service was ready.'};Start-Sleep -Milliseconds 200}
  $state=Get-Content -Raw $ready | ConvertFrom-Json
  $duplicate=Start-Process $executable -WindowStyle Hidden -PassThru
  if(-not $duplicate.WaitForExit(5000)){ $duplicate.Kill();throw 'Duplicate launch created another running desktop.' }
  for($i=0;$i -lt 50 -and -not(Test-Path (Join-Path $data 'desktop-test-browser.json'));$i++){Start-Sleep -Milliseconds 100}
  if(-not(Test-Path (Join-Path $data 'desktop-test-browser.json'))){throw 'Duplicate launch did not open the browser workbench.'}
  node (Join-Path $PSScriptRoot 'browser.test.mjs') $state.origin $screens $data
  if($LASTEXITCODE -ne 0){throw 'Browser workbench acceptance failed; see screenshots and browser-result.json.'}
  if(-not $client.WaitForExit(360000)){ $client.Kill();throw 'Desktop UI test did not complete.' }
  $result=Get-Content -Raw (Join-Path $screens 'control-center-result.json') | ConvertFrom-Json
  if($result.state -ne 'done'){throw ('Desktop UI failed: '+$result.error)}
  Write-Output ('UI evidence: '+$screens)
  Write-Output 'PASS: port collision, duplicate activation, desktop lifecycle and data-preserving uninstall.'
} finally {
  if($client -and -not $client.HasExited){$client.Kill();$client.WaitForExit()}
  if($reservation){$reservation.Stop()}
  if((Test-Path $registry) -and (Get-ItemProperty $registry).InstallLocation -eq $application){
    $remove=Start-Process (Join-Path $application 'Uninstall.exe') -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    if($remove.ExitCode -ne 0){throw 'Product test uninstall failed.'}
  }
  $env:FRAME_LOCAL_DATA=$previousData
  $env:FRAME_DESKTOP_TEST=$previousTest
}
