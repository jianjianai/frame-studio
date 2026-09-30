using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace FrameStudioDesktop {
  static class DesktopShortcut {
    public static void Create(string file,string target,string arguments) {
      var link=(IShellLinkW)new ShellLink();
      try {
        link.SetPath(target);link.SetArguments(arguments);link.SetWorkingDirectory(Path.GetDirectoryName(target));link.SetIconLocation(target,0);
        ((IPersistFile)link).Save(file,true);
      } finally { Marshal.FinalReleaseComObject(link); }
    }
  }
  // Explicit Unicode interface; WScript.Shell can lose names outside the system code page.
  // https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ishelllinkw
  [ComImport,Guid("00021401-0000-0000-C000-000000000046")]
  class ShellLink {}
  [ComImport,Guid("000214F9-0000-0000-C000-000000000046"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellLinkW {
    void GetPath([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder path,int length,IntPtr findData,uint flags);
    void GetIDList(out IntPtr list);
    void SetIDList(IntPtr list);
    void GetDescription([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder description,int length);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
    void GetWorkingDirectory([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory,int length);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
    void GetArguments([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments,int length);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
    void GetHotkey(out short hotkey);
    void SetHotkey(short hotkey);
    void GetShowCmd(out int command);
    void SetShowCmd(int command);
    void GetIconLocation([Out,MarshalAs(UnmanagedType.LPWStr)] StringBuilder file,int length,out int index);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string file,int index);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path,uint reserved);
    void Resolve(IntPtr window,uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
  }
}
