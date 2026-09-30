using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace FrameStudioDesktop {
  static class DesktopNames {
    public static bool Test { get {return Environment.GetEnvironmentVariable("FRAME_DESKTOP_TEST")=="1";} }
    public static string Ipc(string name) {return @"Local\FRAME-Studio-"+name+(Test?"-Test":"");}
    public static string Group {get {return Test?"FRAME Studio Test":"FRAME Studio";}}
  }
  static class DesktopTheme {
    public static readonly Color Paper = Color.FromArgb(245,245,239), Ink = Color.FromArgb(38,59,50), Muted = Color.FromArgb(112,128,116), Line = Color.FromArgb(223,229,218), Green = Color.FromArgb(209,230,177);
    public static Font Font(float size, bool bold = false) { return new Font("Microsoft YaHei UI",size,bold ? FontStyle.Bold : FontStyle.Regular); }
    public static Label Label(string text, float size = 10, bool bold = false) { return new Label { Text=text, AutoSize=true, ForeColor=Ink, Font=Font(size,bold), MaximumSize=new Size(640,0), Margin=new Padding(0,0,0,12) }; }
    public static Button Button(string text, bool primary = false) {
      var button = new Button { Text=text, AutoSize=true, MinimumSize=new Size(96,38), Padding=new Padding(14,3,14,3), FlatStyle=FlatStyle.Flat, ForeColor=primary ? Color.White : Ink, BackColor=primary ? Ink : Color.White, Font=Font(10), Cursor=Cursors.Hand, Margin=new Padding(0,0,10,0) };
      button.FlatAppearance.BorderColor=Line; return button;
    }
    public static Form Form(string title, Size size) { return new Form { Text=title, ClientSize=size, MinimumSize=size, StartPosition=FormStartPosition.CenterScreen, BackColor=Paper, Font=Font(10), AutoScaleDimensions=new SizeF(96,96), AutoScaleMode=AutoScaleMode.Dpi, Icon=Icon, MaximizeBox=false }; }
    public static Icon Icon { get {
      using (var bitmap = new Bitmap(64,64)) {
        using(var g=Graphics.FromImage(bitmap)) {
          g.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias; g.Clear(Ink);
          using(var pen=new Pen(Green,5)) { g.DrawRectangle(pen,13,12,38,40); g.DrawLine(pen,20,25,44,25); g.DrawLine(pen,20,37,39,37); }
        }
        var handle=bitmap.GetHicon(); var result=(Icon)System.Drawing.Icon.FromHandle(handle).Clone(); DestroyIcon(handle); return result;
      }
    } }
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);
    public static void Open(string target) { Process.Start(new ProcessStartInfo(target) { UseShellExecute=true }); }
    public static string Bytes(long value) { return value >= 1024*1024 ? (value / 1048576.0).ToString("0.0")+" MB" : (value/1024.0).ToString("0")+" KB"; }
  }
  static class DesktopFiles {
    public static JavaScriptSerializer Json {get {return new JavaScriptSerializer { MaxJsonLength=16*1024*1024 };}}
    public static Dictionary<string,object> Read(string path) { return File.Exists(path) ? Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(path)) : new Dictionary<string,object>(); }
    public static string String(Dictionary<string,object> value,string key,string fallback="") { object result; return value.TryGetValue(key,out result) && result != null ? Convert.ToString(result) : fallback; }
    public static bool Bool(Dictionary<string,object> value,string key,bool fallback=false) { object result; return value.TryGetValue(key,out result) ? Convert.ToBoolean(result) : fallback; }
    public static void Write(string path,object value) {
      Directory.CreateDirectory(Path.GetDirectoryName(path)); var temporary=path+"."+Guid.NewGuid().ToString("N")+".tmp";
      File.WriteAllText(temporary,Json.Serialize(value),new UTF8Encoding(false));
      if(File.Exists(path)) File.Replace(temporary,path,null); else File.Move(temporary,path);
    }
    public static bool Within(string path,string directory) { return Path.GetFullPath(path).StartsWith(Path.GetFullPath(directory).TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase); }
    public static string Quote(string value) { return "\""+value.TrimEnd('\\').Replace("\"", "\\\"")+"\""; }
  }
  sealed class OwnedProcess : IDisposable {
    public Process Process;
    IntPtr job;
    public OwnedProcess(ProcessStartInfo info,Action<string> output=null) {
      info.UseShellExecute=false; info.CreateNoWindow=true; info.RedirectStandardOutput=true; info.RedirectStandardError=true;
      info.StandardOutputEncoding=Encoding.UTF8; info.StandardErrorEncoding=Encoding.UTF8;
      Process=new Process { StartInfo=info, EnableRaisingEvents=true };
      if(output!=null) { Process.OutputDataReceived+=(s,e)=>{if(e.Data!=null) output(e.Data);}; Process.ErrorDataReceived+=(s,e)=>{if(e.Data!=null) output(e.Data);}; }
      job=CreateJobObject(IntPtr.Zero,null);
      var limits=new JobLimits(); limits.BasicLimitInformation.LimitFlags=0x2000;
      var length=Marshal.SizeOf(limits); var buffer=Marshal.AllocHGlobal(length);
      try { Marshal.StructureToPtr(limits,buffer,false); if(!SetInformationJobObject(job,9,buffer,(uint)length)) throw new System.ComponentModel.Win32Exception(); }
      finally { Marshal.FreeHGlobal(buffer); }
      try {
        if(!Process.Start()) throw new Exception("无法启动应用进程");
        if(!AssignProcessToJobObject(job,Process.Handle)) { try{Process.Kill();}catch{} throw new System.ComponentModel.Win32Exception(); }
        Process.BeginOutputReadLine(); Process.BeginErrorReadLine();
      } catch {Dispose();throw;}
    }
    public Task<int> WaitAsync() { return Task.Run(()=>{Process.WaitForExit();return Process.ExitCode;}); }
    public void Stop() { if(job!=IntPtr.Zero) TerminateJobObject(job,1); }
    public void Dispose() { if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; } Process.Dispose(); }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long PerProcessUserTimeLimit,PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass,SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IO { public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct JobLimits { public BasicLimits BasicLimitInformation; public IO IoInfo; public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed; }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int infoClass,IntPtr info,uint length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint exitCode);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  }
}
