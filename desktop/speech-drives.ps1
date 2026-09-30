param([Parameter(Mandatory=$true)][ValidatePattern('^[F-Z]:$')][string]$Drive)
$ErrorActionPreference='Stop'
$env:PSModulePath=Join-Path $PSHOME 'Modules'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FrameDriveTarget {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint QueryDosDevice(string name, StringBuilder target, int length);
  public static string Read(string name) {
    var target = new StringBuilder(32768);
    if (QueryDosDevice(name, target, target.Capacity) == 0) return "";
    var value = target.ToString();
    return value.StartsWith(@"\??\") ? value.Substring(4) : "";
  }
}
'@
[Console]::Write([FrameDriveTarget]::Read($Drive))
