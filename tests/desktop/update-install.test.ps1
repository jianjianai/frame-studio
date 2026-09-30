param([string]$CacheData, [string]$BundleDirectory)
$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$version=(Get-Content -Raw (Join-Path $repo 'package.json') | ConvertFrom-Json).version
$parts=$version.Split('.')
$next=$parts[0]+'.'+$parts[1]+'.'+([int]$parts[2]+1)
$failed=$parts[0]+'.'+$parts[1]+'.'+([int]$parts[2]+2)
$fixture=Join-Path $repo ('.cache\desktop-update-smoke-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
$application=Join-Path $fixture 'Application'
$data=Join-Path $fixture 'Data'
$bundle=if($BundleDirectory){[IO.Path]::GetFullPath($BundleDirectory)}else{Join-Path $repo ".cache\release\FrameStudio-v$version-win-x64"}
$registry='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FRAMEStudioTest'
if(Test-Path $registry){throw 'An owned test installation is already active; do not overwrite it.'}
$previousData=$env:FRAME_LOCAL_DATA
$previousTest=$env:FRAME_DESKTOP_TEST
$env:FRAME_LOCAL_DATA=$data
$env:FRAME_DESKTOP_TEST='1'
$client=$null
New-Item -ItemType Directory -Path $fixture,$data,(Join-Path $data 'updates') -Force | Out-Null
function Run-Setup([string]$file){$process=Start-Process $file -ArgumentList @('/S',('/D='+$application)) -WindowStyle Hidden -Wait -PassThru;if($process.ExitCode -ne 0){throw 'Fixture base installation failed.'}}
function Make-Update([string]$targetVersion,[bool]$broken){
  $source=Join-Path $fixture ('source-'+$targetVersion)
  Copy-Item -LiteralPath $bundle -Destination $source -Recurse
  $manifestFile=Join-Path $source 'package.json'
  $manifest=Get-Content -Raw $manifestFile | ConvertFrom-Json
  $manifest.version=$targetVersion
  $manifest | ConvertTo-Json -Depth 12 | Set-Content $manifestFile -Encoding utf8NoBOM
  $contract=Join-Path $source 'src\contracts\version.mjs'
  [IO.File]::WriteAllText($contract,([IO.File]::ReadAllText($contract)).Replace('"'+$version+'"','"'+$targetVersion+'"'),(New-Object Text.UTF8Encoding $false))
  if($broken){
    $runtimeFile=Join-Path $source 'desktop\runtime-manifest.json'
    $runtime=Get-Content -Raw $runtimeFile | ConvertFrom-Json
    $runtime.components.tools.id='tools-update-failure'
    $runtime.components.tools.url='https://127.0.0.1:1/unavailable.zip'
    $runtime | ConvertTo-Json -Depth 8 | Set-Content $runtimeFile -Encoding utf8NoBOM
  }
  & (& (Join-Path $repo 'desktop\get-compiler.ps1')) /V2 "/DAppVersion=$targetVersion" "/DBundleDir=$source" "/DOutputDir=$(Join-Path $data 'updates')" (Join-Path $repo 'desktop\installer.nsi')
  if($LASTEXITCODE -ne 0){throw 'Update fixture compilation failed.'}
  $file=Join-Path $data "updates\FrameStudio-v$targetVersion-win-x64-Setup.exe"
  @{version=$targetVersion;file=$file;sha256=(Get-FileHash $file).Hash.ToLowerInvariant();previous=$version} | ConvertTo-Json | Set-Content (Join-Path $data 'updates\ready.json') -Encoding utf8NoBOM
}
try {
  if($CacheData){New-Item -ItemType Junction -Path (Join-Path $data 'runtimes') -Target (Join-Path ([IO.Path]::GetFullPath($CacheData)) 'runtimes') | Out-Null}
  Run-Setup "$bundle-Setup.exe"
  $selection=Get-Content -Raw (Join-Path $data 'runtime-selection.json') | ConvertFrom-Json
  $dependencyMarker=Join-Path $selection.dependencies 'FRAME-RUNTIME.json'
  $before=(Get-Item $dependencyMarker).LastWriteTimeUtc
  $sentinel=Join-Path $data 'user-work-preserved.txt'
  Set-Content $sentinel 'Existing work and downloaded models must survive updates.'
  Make-Update $next $false
  $helper=Join-Path $application "versions\$version\FrameSetup.exe"
  $process=Start-Process $helper -ArgumentList @('--apply-update','--silent','--root',('"'+$application+'"')) -WindowStyle Hidden -Wait -PassThru
  if($process.ExitCode -ne 0){throw 'Verified update installation failed.'}
  $installation=Get-Content -Raw (Join-Path $application 'installation.json') | ConvertFrom-Json
  if($installation.version -ne $next -or $installation.previous -ne $version -or (Get-ItemProperty $registry).DisplayVersion -ne $next){throw 'Successful update did not switch the correct installed version.'}
  if((Test-Path (Join-Path $data 'updates\ready.json')) -or (Get-Item $dependencyMarker).LastWriteTimeUtc -ne $before -or -not(Test-Path $sentinel)){throw 'Update lost data, reinstalled dependencies, or retained its completed marker.'}
  $shell=New-Object -ComObject WScript.Shell
  try{$shortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'FRAME Studio Test\FRAME Studio Test.lnk'));if($shortcut.TargetPath -ne (Join-Path $application "versions\$next\FrameStudio.exe")){throw 'Updated shortcut still targets the old version.'}}finally{[Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null}
  Write-Output 'PASS: verified Setup switches versions atomically, retains the previous app and reuses dependencies.'
  Make-Update $failed $true
  $process=Start-Process (Join-Path $application "versions\$next\FrameSetup.exe") -ArgumentList @('--apply-update','--silent','--root',('"'+$application+'"')) -WindowStyle Hidden -Wait -PassThru
  if($process.ExitCode -eq 0 -or (Get-ItemProperty $registry).DisplayVersion -ne $next -or -not(Test-Path $sentinel)){throw 'Failed update changed the active installation or its data.'}
  Write-Output 'PASS: failed update retains the working application, registration and data.'
  Remove-Item -LiteralPath (Join-Path $data 'updates\ready.json')
  # Start the version selected by the updated shortcut and verify the actual owned server.
  $screens=Join-Path $fixture 'screens'
  New-Item -ItemType Directory -Path $screens | Out-Null
  $client=Start-Process (Join-Path $application "versions\$next\FrameStudio.exe") -ArgumentList @('--control-center','--test-ui','--test-output',('"'+$screens+'"')) -WindowStyle Hidden -PassThru
  $ready=Join-Path $data 'desktop-test-ready.json'
  for($i=0;$i -lt 600 -and -not(Test-Path $ready);$i++){if($client.HasExited){throw 'Updated application could not start.'};Start-Sleep -Milliseconds 200}
  $state=Get-Content -Raw $ready | ConvertFrom-Json
  if((Invoke-RestMethod ($state.origin+'/api/desktop/status')).version -ne $next){throw 'Updated application did not run its matching source.'}
  Set-Content (Join-Path $screens 'browser-done.json') '{}'
  if(-not $client.WaitForExit(30000)){throw 'Updated application did not exit cleanly.'}
  Write-Output 'PASS: updated executable starts a matching native workbench and exits cleanly.'
  Write-Output ('Update evidence: '+$fixture)
} finally {
  if($client -and -not $client.HasExited){$client.Kill();$client.WaitForExit()}
  if((Test-Path $registry) -and (Get-ItemProperty $registry).InstallLocation -eq $application){$remove=Start-Process (Join-Path $application 'Uninstall.exe') -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru;if($remove.ExitCode -ne 0){throw 'Update test uninstall failed.'}}
  $env:FRAME_LOCAL_DATA=$previousData
  $env:FRAME_DESKTOP_TEST=$previousTest
}
