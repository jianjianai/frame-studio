Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\FRAMEStudio"
Name "FRAME Studio ${AppVersion}"
OutFile "${OutputDir}\FrameStudio-v${AppVersion}-win-x64-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\FRAME Studio"
InstallDirRegKey HKCU "${REGKEY}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${AppVersion}.0"
VIAddVersionKey "ProductName" "FRAME Studio"
VIAddVersionKey "FileDescription" "FRAME Studio Installer"
VIAddVersionKey "FileVersion" "${AppVersion}"
VIAddVersionKey "LegalCopyright" "FRAME Studio contributors"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\versions\${AppVersion}\FrameStudio.exe"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
Var DataRoot
Var SetupMutex

!macro CheckRunning
  System::Call 'kernel32::OpenMutexW(i 0x100000, i 0, w "Local\FRAME-Studio-Desktop") p .r0'
  ${If} $0 <> 0
    System::Call 'kernel32::CloseHandle(p r0)'
    MessageBox MB_OK|MB_ICONEXCLAMATION "请先从托盘退出 FRAME Studio，再继续安装或卸载。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

Function .onInit
  SetShellVarContext current
  SetRegView 64
  ${IfNot} ${RunningX64}
    MessageBox MB_OK "FRAME Studio requires 64-bit Windows." /SD IDOK
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK "FRAME Studio requires Windows 10 or newer." /SD IDOK
    Abort
  ${EndIf}
  !insertmacro CheckRunning
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\FRAME-Studio-Setup") p .r0 ?e'
  Pop $1
  StrCpy $SetupMutex $0
  ${If} $1 = 183
    MessageBox MB_OK "FRAME Studio Setup is already running." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd

Section "FRAME Studio"
  !insertmacro CheckRunning
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\payload"
  File /r "${BundleDir}\*"
  ReadEnvStr $DataRoot FRAME_LOCAL_DATA
  ${If} $DataRoot == ""
    StrCpy $DataRoot "$LOCALAPPDATA\FRAME Studio"
  ${EndIf}
  DetailPrint "检查并安装运行环境、浏览器和 pnpm 依赖；已安装组件会复用。"
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\payload\desktop\install.ps1" -SourceRoot "$PLUGINSDIR\payload" -InstallRoot "$INSTDIR\versions\${AppVersion}" -DataRoot "$DataRoot"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "依赖准备失败，现有版本保持可用。请查看 $DataRoot\installer.log 后重试。"
    SetErrorLevel 1
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR\versions\${AppVersion}"
  ClearErrors
  CopyFiles /SILENT "$PLUGINSDIR\payload\*.*" "$INSTDIR\versions\${AppVersion}"
  ${If} ${Errors}
    SetErrorLevel 1
    Abort "Could not copy application files."
  ${EndIf}
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\FRAME Studio"
  CreateShortcut "$SMPROGRAMS\FRAME Studio\FRAME Studio.lnk" "$INSTDIR\versions\${AppVersion}\FrameStudio.exe" "" "$INSTDIR\versions\${AppVersion}\FrameStudio.exe"
  CreateShortcut "$SMPROGRAMS\FRAME Studio\卸载 FRAME Studio.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${REGKEY}" "DisplayName" "FRAME Studio"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${AppVersion}"
  WriteRegStr HKCU "${REGKEY}" "Publisher" "FRAME Studio"
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "DisplayIcon" "$INSTDIR\versions\${AppVersion}\FrameStudio.exe"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "${REGKEY}" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1
SectionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  !insertmacro CheckRunning
FunctionEnd

Section "Uninstall"
  SetOutPath "$INSTDIR"
  nsExec::ExecToLog '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\versions\${AppVersion}\desktop\uninstall.ps1" -InstallRoot "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    SetErrorLevel 1
    Abort "Could not remove application files; user data has been preserved."
  ${EndIf}
  Delete "$SMPROGRAMS\FRAME Studio\FRAME Studio.lnk"
  Delete "$SMPROGRAMS\FRAME Studio\卸载 FRAME Studio.lnk"
  RMDir "$SMPROGRAMS\FRAME Studio"
  DeleteRegKey HKCU "${REGKEY}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
