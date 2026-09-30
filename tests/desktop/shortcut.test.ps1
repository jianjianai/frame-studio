$ErrorActionPreference='Stop'
$repo=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$fixture=Join-Path $repo ('.cache\shortcut-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
  $compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  $executable=Join-Path $fixture 'shortcut-test.exe'
  & $compiler /nologo /codepage:65001 /target:exe /platform:x64 "/out:$executable" /reference:System.dll (Join-Path $repo 'desktop\DesktopShortcut.cs') (Join-Path $PSScriptRoot 'ShortcutTest.cs')
  if($LASTEXITCODE -ne 0){throw 'Shortcut regression did not compile.'}
  & $executable $fixture
  if($LASTEXITCODE -ne 0){throw 'Unicode shortcut regression failed.'}
} finally {
  if(-not ([IO.Path]::GetFullPath($fixture)).StartsWith((Join-Path $repo '.cache\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected test cleanup path.'}
  Remove-Item -LiteralPath $fixture -Recurse -Force
}
