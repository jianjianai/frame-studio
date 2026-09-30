using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
namespace FrameStudioDesktop {
  static class ShortcutTest {
    [STAThread] static int Main(string[] args) {
      try {
        // Chinese plus supplementary characters cannot fit in either Western or Chinese ANSI.
        var directory=Path.Combine(args[0],"\u4e2d\u6587 \uD83C\uDFAC");Directory.CreateDirectory(directory);
        var target=Path.Combine(directory,"\u76ee\u6807 \uD83E\uDE9F.exe");File.WriteAllText(target,"Shortcut target fixture");
        var file=Path.Combine(directory,"Windows \u63a7\u5236\u4e2d\u5fc3 \uD83C\uDFAC.lnk");
        var arguments="--control-center \"\u4e2d\u6587 \uD83C\uDFAC\"";
        DesktopShortcut.Create(file,target,arguments);
        if(!File.Exists(file)||new FileInfo(file).Length==0)throw new Exception("Unicode shortcut file was not saved");
        var link=(IShellLinkW)new ShellLink();
        try {
          ((IPersistFile)link).Load(file,0);
          var value=new StringBuilder(32768);link.GetPath(value,value.Capacity,IntPtr.Zero,4);
          if(!String.Equals(value.ToString(),target,StringComparison.OrdinalIgnoreCase))throw new Exception("Shortcut target lost Unicode");
          value.Clear();link.GetArguments(value,value.Capacity);
          if(value.ToString()!=arguments)throw new Exception("Shortcut arguments changed");
        } finally {Marshal.FinalReleaseComObject(link);}
        Console.WriteLine("PASS: Windows Unicode shortcut filename, target and arguments survive the native Shell API.");return 0;
      } catch(Exception error){Console.Error.WriteLine(error);return 1;}
    }
  }
}
