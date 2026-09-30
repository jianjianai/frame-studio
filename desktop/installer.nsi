Unicode true
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
Name "FRAME Studio ${AppVersion}"
OutFile "${OutputDir}\FrameStudio-v${AppVersion}-win-x64-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\FRAME Studio"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FRAMEStudio" "InstallLocation"
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
SetCompressor /SOLID lzma
Icon "${BundleDir}\desktop\FrameStudio.ico"
UninstallIcon "${BundleDir}\desktop\FrameStudio.ico"
VIProductVersion "${AppVersion}.0"
VIAddVersionKey "ProductName" "FRAME Studio"
VIAddVersionKey "FileDescription" "FRAME Studio 安装程序"
VIAddVersionKey "FileVersion" "${AppVersion}"
VIAddVersionKey "LegalCopyright" "FRAME Studio contributors"
Var Mode
Var Restart
Var SetupMutex
Var Parameters
Var Registration
Var Group
Function .onInit
  SetShellVarContext current
  SetRegView 64
  ReadEnvStr $0 "FRAME_DESKTOP_TEST"
  StrCpy $Registration "Software\Microsoft\Windows\CurrentVersion\Uninstall\FRAMEStudio"
  StrCpy $Group "FRAME Studio"
  ${If} $0 = "1"
    StrCpy $Registration "Software\Microsoft\Windows\CurrentVersion\Uninstall\FRAMEStudioTest"
    StrCpy $Group "FRAME Studio Test"
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_OK "FRAME Studio 需要 64 位 Windows。" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK "FRAME Studio 需要 Windows 10 或更新版本。" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\FRAME-Studio-Setup") p .r0 ?e'
  Pop $1
  StrCpy $SetupMutex $0
  ${If} $1 = 183
    MessageBox MB_OK "安装程序已打开，请在现有窗口继续。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  StrCpy $Mode ""
  StrCpy $Restart ""
  ${GetParameters} $Parameters
  ClearErrors
  ${GetOptions} $Parameters "/S" $0
  ${IfNot} ${Errors}
    StrCpy $Mode "--silent"
  ${EndIf}
  ClearErrors
  ${GetOptions} $Parameters "/RESTARTAPP" $0
  ${IfNot} ${Errors}
    StrCpy $Restart "--restart"
  ${EndIf}
FunctionEnd
Section "Install"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\payload"
  File /r "${BundleDir}\*"
  WriteUninstaller "$PLUGINSDIR\Uninstall.exe"
  ExecWait '"$PLUGINSDIR\payload\FrameSetup.exe" --source "$PLUGINSDIR\payload" --root "$INSTDIR" --version "${AppVersion}" --uninstaller "$PLUGINSDIR\Uninstall.exe" $Mode $Restart' $0
  SetErrorLevel $0
SectionEnd
Function un.onInit
  SetShellVarContext current
  SetRegView 64
  ReadEnvStr $0 "FRAME_DESKTOP_TEST"
  StrCpy $Registration "Software\Microsoft\Windows\CurrentVersion\Uninstall\FRAMEStudio"
  StrCpy $Group "FRAME Studio"
  ${If} $0 = "1"
    StrCpy $Registration "Software\Microsoft\Windows\CurrentVersion\Uninstall\FRAMEStudioTest"
    StrCpy $Group "FRAME Studio Test"
  ${EndIf}
  StrCpy $Mode ""
  ${GetParameters} $Parameters
  ClearErrors
  ${GetOptions} $Parameters "/S" $0
  ${IfNot} ${Errors}
    StrCpy $Mode "--silent"
  ${EndIf}
FunctionEnd
Section "Uninstall"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=FrameSetup.exe "${BundleDir}\FrameSetup.exe"
  CreateDirectory "$PLUGINSDIR\desktop"
  SetOutPath "$PLUGINSDIR\desktop"
  File "${BundleDir}\desktop\uninstall.ps1"
  ExecWait '"$PLUGINSDIR\FrameSetup.exe" --uninstall --source "$PLUGINSDIR" --root "$INSTDIR" $Mode' $0
  SetErrorLevel $0
  ${If} $0 = 0
    Delete "$SMPROGRAMS\$Group\$Group.lnk"
    Delete "$SMPROGRAMS\$Group\卸载 FRAME Studio.lnk"
    Delete "$SMPROGRAMS\$Group\Windows 控制中心.lnk"
    RMDir "$SMPROGRAMS\$Group"
    Delete "$DESKTOP\$Group.lnk"
    DeleteRegKey HKCU "$Registration"
    Delete "$INSTDIR\installation.json"
    Delete "$INSTDIR\Uninstall.exe"
    RMDir "$INSTDIR"
  ${EndIf}
SectionEnd
