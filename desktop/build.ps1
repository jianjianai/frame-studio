$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler is required.' }
$directory = Join-Path (Split-Path -Parent $PSScriptRoot) '.cache\desktop'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$output = Join-Path $directory 'FrameStudio.exe'
& $compiler /nologo /target:winexe /optimize+ /out:$output /reference:System.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'FrameTray.cs')
if ($LASTEXITCODE -ne 0) { throw 'Tray compilation failed.' }
Write-Output $output
