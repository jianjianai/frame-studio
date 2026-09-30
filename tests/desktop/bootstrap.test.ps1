$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$fixture = Join-Path $repo ('.cache\installer-test-' + [Guid]::NewGuid().ToString('N'))
$app = Join-Path $fixture 'app'
$data = Join-Path $fixture 'data'
$assets = Join-Path $fixture 'assets'
New-Item -ItemType Directory -Path (Join-Path $app 'desktop'),$data,$assets -Force | Out-Null
Copy-Item (Join-Path $repo 'desktop\extract.mjs') (Join-Path $app 'desktop\extract.mjs')
Copy-Item (Join-Path $repo 'desktop\dependencies.mjs') (Join-Path $app 'desktop\dependencies.mjs')
Copy-Item (Join-Path $repo 'desktop\runtime-versions.json') (Join-Path $app 'desktop\runtime-versions.json')
foreach ($name in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','.npmrc')) { Copy-Item (Join-Path $repo $name) (Join-Path $app $name) }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$selection = Join-Path $data 'selected.json'
$components = @{}
try {
  $dependencies = (& node (Join-Path $repo 'desktop\dependencies.mjs') fingerprint $app) | ConvertFrom-Json
  $dependencyDirectory = Join-Path $data ('runtimes\' + $dependencies.id)
  New-Item -ItemType Directory -Path (Join-Path $dependencyDirectory 'node_modules') -Force | Out-Null
  Set-Content (Join-Path $dependencyDirectory 'node_modules\.modules.yaml') 'pnpm cache fixture'
  Set-Content (Join-Path $dependencyDirectory 'node_modules\test.txt') 'cached pnpm dependencies'
  $dependencies | ConvertTo-Json | Set-Content (Join-Path $dependencyDirectory 'FRAME-RUNTIME.json') -Encoding utf8
  foreach ($kind in @('tools','speech')) {
    $stage = Join-Path $fixture $kind
    New-Item -ItemType Directory -Path (Join-Path $stage 'node_modules') -Force | Out-Null
    Set-Content (Join-Path $stage 'node_modules\test.txt') $kind
    if ($kind -eq 'tools') { Copy-Item (Get-Command node.exe).Source (Join-Path $stage 'node.exe') }
    $zip = Join-Path $assets "$kind.zip"
    [IO.Compression.ZipFile]::CreateFromDirectory($stage,$zip)
    $components[$kind] = @{id="$kind-test-1";url=([Uri]$zip).AbsoluteUri;sha256=(Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()}
  }
  @{schema=2;components=$components;dependencies=$dependencies} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $app 'desktop\runtime-manifest.json') -Encoding utf8
  & (Join-Path $repo 'desktop\bootstrap.ps1') -AppRoot $app -DataRoot $data -Selection $selection -LocalAssets
  if (-not (Test-Path (Join-Path $app 'node_modules\test.txt'))) { throw 'Dependency junction did not resolve.' }
  foreach ($zip in Get-ChildItem $assets -Filter '*.zip') { Remove-Item -LiteralPath $zip.FullName }
  & (Join-Path $repo 'desktop\bootstrap.ps1') -AppRoot $app -DataRoot $data -Selection $selection -LocalAssets
  Write-Output 'PASS: updating an application reuses all installed dependencies without source archives.'
  $badSource = Join-Path $assets 'bad.zip'
  Set-Content $badSource 'deliberately corrupt archive'
  $components.tools = @{id='tools-test-bad';url=([Uri]$badSource).AbsoluteUri;sha256=('0' * 64)}
  @{schema=2;components=$components;dependencies=$dependencies} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $app 'desktop\runtime-manifest.json') -Encoding utf8
  $failed = $false
  try { & (Join-Path $repo 'desktop\bootstrap.ps1') -AppRoot $app -DataRoot $data -Selection $selection -LocalAssets }
  catch { $failed = $_.Exception.Message -match '校验失败' }
  if (-not $failed -or (Test-Path (Join-Path $data 'runtimes\tools-test-bad'))) { throw 'Corrupt archive was installed.' }
  Write-Output 'PASS: corrupt downloads are rejected and existing runtime components remain intact.'
} finally {
  $link = Join-Path $app 'node_modules'
  if (Test-Path $link) { [IO.Directory]::Delete($link) }
  if (-not ([IO.Path]::GetFullPath($fixture)).StartsWith((Join-Path $repo '.cache\'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected test cleanup path.' }
  Remove-Item -LiteralPath $fixture -Recurse -Force
}
