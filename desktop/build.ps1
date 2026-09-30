$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler is required.' }
$directory = Join-Path (Split-Path -Parent $PSScriptRoot) '.cache\desktop'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
Add-Type -AssemblyName System.Drawing
$iconPath=Join-Path $directory 'FrameStudio.ico'
$bitmap=New-Object Drawing.Bitmap(64,64)
$graphics=[Drawing.Graphics]::FromImage($bitmap)
$pen=New-Object Drawing.Pen([Drawing.Color]::FromArgb(209,230,177),5)
try {
  $graphics.Clear([Drawing.Color]::FromArgb(38,59,50))
  $graphics.DrawRectangle($pen,13,12,38,40)
  $graphics.DrawLine($pen,20,25,44,25)
  $graphics.DrawLine($pen,20,37,39,37)
  $icon=[Drawing.Icon]::FromHandle($bitmap.GetHicon())
  $stream=[IO.File]::Create($iconPath)
  try {$icon.Save($stream)} finally {$stream.Dispose();$icon.Dispose()}
} finally {$pen.Dispose();$graphics.Dispose();$bitmap.Dispose()}
$version=(Get-Content -Raw (Join-Path (Split-Path -Parent $PSScriptRoot) 'package.json') | ConvertFrom-Json).version
$assembly=Join-Path $directory 'AssemblyInfo.cs'
[IO.File]::WriteAllText($assembly,('[assembly: System.Reflection.AssemblyTitle("FRAME Studio")][assembly: System.Reflection.AssemblyProduct("FRAME Studio")][assembly: System.Reflection.AssemblyVersion("'+$version+'.0")][assembly: System.Reflection.AssemblyFileVersion("'+$version+'.0")]'))
$shared = @('DesktopUi.cs','DesktopUpdates.cs','SetupEngine.cs') | ForEach-Object { Join-Path $PSScriptRoot $_ }
$references = @('/reference:System.dll','/reference:System.Core.dll','/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll')
foreach ($application in @('FrameStudio','FrameSetup')) {
  $output = Join-Path $directory "$application.exe"
  $sources = if ($application -eq 'FrameStudio') { @('MainWindow.cs','ControlCenterTest.cs') } else { @('SetupProgram.cs','SetupForm.cs') }
  $extra = @()
  & $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$output" "/win32icon:$iconPath" "/win32manifest:$(Join-Path $PSScriptRoot 'app.manifest')" @references @extra @shared $assembly ($sources | ForEach-Object { Join-Path $PSScriptRoot $_ })
  if ($LASTEXITCODE -ne 0) { throw "$application compilation failed." }
  Copy-Item (Join-Path $PSScriptRoot 'app.config') (Join-Path $directory "$application.exe.config") -Force
}
Write-Output (Join-Path $directory 'FrameStudio.exe')
