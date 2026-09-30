using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace FrameStudioDesktop {
  sealed class SetupOptions {
    public string Source="",Root="",Data="",Version="",Uninstaller="";
    public bool Shortcut=true,Restart=false,Silent=false;
  }
  sealed class SetupEngine {
    public static string RegistryKey {get {return @"Software\Microsoft\Windows\CurrentVersion\Uninstall\FRAMEStudio"+(DesktopNames.Test?"Test":"");}}
    public event Action<string> Output;
    public OwnedProcess Current;
    public bool Cancelled;
    public void Cancel() { Cancelled=true; if(Current!=null) Current.Stop(); }
    void Emit(string component,string phase,string message) { var callback=Output; if(callback!=null) callback("FRAME_PROGRESS "+DesktopFiles.Json.Serialize(new { component=component,phase=phase,message=message })); }
    public static string RegisteredRoot() { using(var key=Registry.CurrentUser.OpenSubKey(RegistryKey)) return key==null ? "" : Convert.ToString(key.GetValue("InstallLocation","")); }
    public static string RegisteredData() { using(var key=Registry.CurrentUser.OpenSubKey(RegistryKey)) return key==null ? "" : Convert.ToString(key.GetValue("DataLocation","")); }
    public static bool AppRunning() {
      System.Threading.Mutex mutex;
      try { if(!System.Threading.Mutex.TryOpenExisting(DesktopNames.Ipc("Desktop"),out mutex)) return false; mutex.Dispose(); return true; } catch { return false; }
    }
    async Task RunScript(string source,string script,string arguments) {
      var info=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "+DesktopFiles.Quote(Path.Combine(source,"desktop",script))+" "+arguments) { WorkingDirectory=source };
      var process=new OwnedProcess(info,line=>{var callback=Output;if(callback!=null)callback(line);}); Current=process;
      try { var code=await process.WaitAsync(); if(Cancelled) throw new OperationCanceledException(); if(code!=0) throw new Exception("准备未完成。已下载的文件会保留，请检查网络后重试。详细原因可在安装日志查看。"); }
      finally { Current=null; process.Dispose(); }
    }
    public async Task Install(SetupOptions options) {
      Cancelled=false;
      if(!System.Text.RegularExpressions.Regex.IsMatch(options.Version,@"^\d+\.\d+\.\d+$"))throw new Exception("安装版本无效，请重新下载安装程序。");
      if(DesktopFiles.String(DesktopFiles.Read(Path.Combine(options.Source,"package.json")),"version")!=options.Version)throw new Exception("安装内容与版本不一致，请重新下载安装程序。");
      if(AppRunning()) throw new Exception("工作台正在运行，请关闭工作台后继续安装。");
      var root=Path.GetFullPath(options.Root).TrimEnd('\\'); var data=Path.GetFullPath(options.Data).TrimEnd('\\');
      if(root.Length<8 || root.StartsWith(@"\\") || root==data || DesktopFiles.Within(data,root) || DesktopFiles.Within(root,data)) throw new Exception("程序目录与作品数据目录需要分别保存，请选择独立目录。");
      var registered=RegisteredRoot(); if(registered!="" && !String.Equals(root,Path.GetFullPath(registered).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)) throw new Exception("已安装的程序需要更新到原目录；数据与依赖会继续保留。");
      Directory.CreateDirectory(data); Directory.CreateDirectory(root);
      var minimum=Directory.Exists(Path.Combine(data,"runtimes"))?1L:6L;
      var drive=new DriveInfo(Path.GetPathRoot(data)); if(drive.AvailableFreeSpace<minimum*1024*1024*1024) throw new Exception("数据磁盘空间不足，请至少保留 "+minimum+" GB 可用空间后重试。");
      var versions=Path.Combine(root,"versions"); Directory.CreateDirectory(versions);
      var stage=Path.Combine(versions,options.Version+".install-"+Guid.NewGuid().ToString("N"));
      try {
        Emit("checking","checking","正在检查电脑与已安装环境");
        await RunScript(options.Source,"install.ps1","-SourceRoot "+DesktopFiles.Quote(options.Source)+" -InstallRoot "+DesktopFiles.Quote(stage)+" -DataRoot "+DesktopFiles.Quote(data));
        if(Cancelled) throw new OperationCanceledException();
        Emit("application","installing","正在安装 FRAME Studio 并创建快捷方式");
        CopyTree(options.Source,stage);
        Commit(options,root,data,stage);
        Emit("application","done","安装完成，可以开始创作");
      } finally { if(Directory.Exists(stage)) RemoveTree(stage,versions); }
    }
    static void CopyTree(string source,string target) {
      Directory.CreateDirectory(target);
      foreach(var file in Directory.GetFiles(source)) { if(Path.GetFileName(file)=="prepared-runtime.json") continue; File.Copy(file,Path.Combine(target,Path.GetFileName(file)),true); }
      foreach(var directory in Directory.GetDirectories(source)) {
        if(Path.GetFileName(directory)=="node_modules") continue;
        if((File.GetAttributes(directory)&FileAttributes.ReparsePoint)!=0) throw new Exception("安装源中含有未预期的目录链接");
        CopyTree(directory,Path.Combine(target,Path.GetFileName(directory)));
      }
    }
    static void Commit(SetupOptions options,string root,string data,string stage) {
      var final=Path.Combine(root,"versions",options.Version); var previous=DesktopFiles.Read(Path.Combine(root,"installation.json"));
      var old=DesktopFiles.String(previous,"version"); var displaced=final+".previous-"+Guid.NewGuid().ToString("N");
      bool movedOld=false,movedNew=false;
      var programGroup=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),DesktopNames.Group);
      var files=new Dictionary<string,byte[]>();
      foreach(var file in new[]{Path.Combine(root,"Uninstall.exe"),Path.Combine(root,"installation.json"),Path.Combine(data,"desktop-settings.json"),Path.Combine(programGroup,DesktopNames.Group+".lnk"),Path.Combine(programGroup,"Windows 控制中心.lnk"),Path.Combine(programGroup,"卸载 FRAME Studio.lnk"),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),DesktopNames.Group+".lnk")})files[file]=File.Exists(file)?File.ReadAllBytes(file):null;
      var registryValues=new Dictionary<string,object>();var registryKinds=new Dictionary<string,RegistryValueKind>();bool existed;
      using(var key=Registry.CurrentUser.OpenSubKey(RegistryKey)){existed=key!=null;if(key!=null)foreach(var name in key.GetValueNames()){registryValues[name]=key.GetValue(name);registryKinds[name]=key.GetValueKind(name);}}
      try {
        if(Directory.Exists(final)) { Directory.Move(final,displaced); movedOld=true; }
        Directory.Move(stage,final); movedNew=true;
        File.Copy(options.Uninstaller,Path.Combine(root,"Uninstall.exe"),true);
        Directory.CreateDirectory(programGroup);
        Shortcut(Path.Combine(programGroup,DesktopNames.Group+".lnk"),Path.Combine(final,"FrameStudio.exe"),"");
        Shortcut(Path.Combine(programGroup,"Windows 控制中心.lnk"),Path.Combine(final,"FrameStudio.exe"),"--control-center");
        Shortcut(Path.Combine(programGroup,"卸载 FRAME Studio.lnk"),Path.Combine(root,"Uninstall.exe"),"");
        if(options.Shortcut) Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),DesktopNames.Group+".lnk"),Path.Combine(final,"FrameStudio.exe"),"");
        var settings=DesktopFiles.Read(Path.Combine(data,"desktop-settings.json")); if(!settings.ContainsKey("automaticUpdates")) settings["automaticUpdates"]=true;
        settings["desktopShortcut"]=options.Shortcut;
        DesktopFiles.Write(Path.Combine(data,"desktop-settings.json"),settings);
        DesktopFiles.Write(Path.Combine(root,"installation.json"),new { version=options.Version,previous=old==options.Version ? DesktopFiles.String(previous,"previous") : old,data=data });
        using(var key=Registry.CurrentUser.CreateSubKey(RegistryKey)) {
          key.SetValue("DisplayName","FRAME Studio"); key.SetValue("DisplayVersion",options.Version); key.SetValue("Publisher","FRAME Studio"); key.SetValue("InstallLocation",root);key.SetValue("DataLocation",data);
          key.SetValue("DisplayIcon",Path.Combine(final,"FrameStudio.exe")); key.SetValue("UninstallString",DesktopFiles.Quote(Path.Combine(root,"Uninstall.exe"))); key.SetValue("QuietUninstallString",DesktopFiles.Quote(Path.Combine(root,"Uninstall.exe"))+" /S");
          key.SetValue("NoModify",1,RegistryValueKind.DWord); key.SetValue("NoRepair",1,RegistryValueKind.DWord);
        }
      } catch {
        if(movedNew && Directory.Exists(final)) Directory.Move(final,stage);
        if(movedOld && Directory.Exists(displaced)) Directory.Move(displaced,final);
        foreach(var file in files){if(file.Value==null){if(File.Exists(file.Key))File.Delete(file.Key);}else File.WriteAllBytes(file.Key,file.Value);}
        if(!existed)Registry.CurrentUser.DeleteSubKeyTree(RegistryKey,false);
        else using(var key=Registry.CurrentUser.CreateSubKey(RegistryKey)){foreach(var name in key.GetValueNames())if(!registryValues.ContainsKey(name))key.DeleteValue(name);foreach(var item in registryValues)key.SetValue(item.Key,item.Value,registryKinds[item.Key]);}
        throw;
      }
      if(movedOld) RemoveTree(displaced,Path.Combine(root,"versions"));
    }
    public static void Shortcut(string file,string target,string arguments) {
      DesktopShortcut.Create(file,target,arguments);
    }
    public static void RemoveTree(string target,string boundary) {
      if(!DesktopFiles.Within(target,boundary)) throw new Exception("程序清理目录不在安装版本目录内");
      if(!Directory.Exists(target)) return;
      if((File.GetAttributes(target)&FileAttributes.ReparsePoint)!=0) { Directory.Delete(target); return; }
      foreach(var directory in Directory.GetDirectories(target)) RemoveTree(directory,boundary);
      foreach(var file in Directory.GetFiles(target)) { File.SetAttributes(file,FileAttributes.Normal); File.Delete(file); }
      Directory.Delete(target);
    }
    public async Task Uninstall(string source,string root) { if(AppRunning()) throw new Exception("请先关闭工作台，再卸载程序。"); await RunScript(source,"uninstall.ps1","-InstallRoot "+DesktopFiles.Quote(root)); }
  }
}
