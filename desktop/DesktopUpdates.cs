using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

namespace FrameStudioDesktop {
  sealed class ReleaseUpdate {
    public string Version,Url,Sha256,Notes,File;
    public long Bytes;
  }
  sealed class DesktopUpdates {
    readonly string data,current;
    readonly Uri endpoint;
    readonly SemaphoreSlim gate=new SemaphoreSlim(1,1);
    public event Action Changed;
    public string State="idle",Message="自动检查新版本",Error="";
    public long Received,Total;
    public ReleaseUpdate Available;
    public bool Automatic=true;
    public DesktopUpdates(string data,string current,Uri endpoint=null) {
      this.data=data; this.current=current;
      this.endpoint=endpoint ?? new Uri("https://api.github.com/repos/jianjianai/frame-studio/releases/latest");
      if(endpoint!=null && Environment.GetEnvironmentVariable("FRAME_DESKTOP_TEST")!="1") throw new InvalidOperationException("Test update source is disabled.");
      Automatic=DesktopFiles.Bool(DesktopFiles.Read(Path.Combine(data,"desktop-settings.json")),"automaticUpdates",true);
    }
    public object Snapshot() { return new { state=State,message=Message,error=Error,received=Received,total=Total,automatic=Automatic,current=current,version=Available==null ? null : Available.Version,notes=Available==null ? null : Available.Notes }; }
    void Change(string state,string message) { State=state; Message=message; var handler=Changed; if(handler!=null) handler(); }
    public void SetAutomatic(bool enabled) {
      var settings=DesktopFiles.Read(Path.Combine(data,"desktop-settings.json")); settings["automaticUpdates"]=enabled; DesktopFiles.Write(Path.Combine(data,"desktop-settings.json"),settings); Automatic=enabled; Change(State,Message);
    }
    public async Task Check(bool forced=false) {
      if(!await gate.WaitAsync(0)) return;
      try {
        var settings=DesktopFiles.Read(Path.Combine(data,"desktop-settings.json")); DateTime last;
        if(!forced && DateTime.TryParse(DesktopFiles.String(settings,"lastUpdateCheck"),out last) && DateTime.UtcNow-last.ToUniversalTime()<TimeSpan.FromHours(24)) { RestorePrepared(); return; }
        Error=""; Change("checking","正在检查新版本");
        var request=(HttpWebRequest)WebRequest.Create(endpoint); request.UserAgent="FRAME-Studio-Windows/"+current; request.Accept="application/vnd.github+json"; request.Timeout=20000; request.ReadWriteTimeout=20000;
        string json;
        using(var response=(HttpWebResponse)await request.GetResponseAsync()) using(var input=new StreamReader(response.GetResponseStream())) json=await input.ReadToEndAsync();
        Available=ParseRelease(json,current,endpoint.Host=="api.github.com");
        if(Available==null) { settings["lastUpdateCheck"]=DateTime.UtcNow.ToString("O");DesktopFiles.Write(Path.Combine(data,"desktop-settings.json"),settings);Change("current","已是最新版本"); return; }
        Change("available","发现新版本 "+Available.Version);
        if(Automatic) await Download();
        if(State!="failed"){settings["lastUpdateCheck"]=DateTime.UtcNow.ToString("O");DesktopFiles.Write(Path.Combine(data,"desktop-settings.json"),settings);}
      } catch(Exception error) { Error="暂时无法获取更新，请检查网络后重试。"; if(Available!=null&&Available.File!=null)Change("ready","新版已准备好，可在退出时安装");else Change("failed",Error); Log(error); }
      finally { gate.Release(); }
    }
    public static ReleaseUpdate ParseRelease(string json,string current,bool trusted=true) {
      var release=DesktopFiles.Json.Deserialize<Dictionary<string,object>>(json);
      if(DesktopFiles.Bool(release,"draft") || DesktopFiles.Bool(release,"prerelease")) return null;
      var tag=DesktopFiles.String(release,"tag_name"); Version incoming,installed;
      if(!System.Text.RegularExpressions.Regex.IsMatch(tag,@"^v\d+\.\d+\.\d+$") || !Version.TryParse(tag.Substring(1),out incoming) || !Version.TryParse(current,out installed) || incoming<=installed) return null;
      var filename="FrameStudio-"+tag+"-win-x64-Setup.exe";
      object raw; if(!release.TryGetValue("assets",out raw) || !(raw is IEnumerable)) throw new Exception("新版缺少安装程序");
      foreach(var value in (IEnumerable)raw) {
        var asset=value as Dictionary<string,object>; if(asset==null || DesktopFiles.String(asset,"name")!=filename) continue;
        var digest=DesktopFiles.String(asset,"digest"); var url=DesktopFiles.String(asset,"browser_download_url");
        if(!System.Text.RegularExpressions.Regex.IsMatch(digest,@"^sha256:[a-f0-9]{64}$")) throw new Exception("新版缺少可校验的摘要");
        if(trusted && url!="https://github.com/jianjianai/frame-studio/releases/download/"+tag+"/"+filename) throw new Exception("更新来源不符合仓库约定");
        return new ReleaseUpdate { Version=tag.Substring(1),Url=url,Sha256=digest.Substring(7),Bytes=Convert.ToInt64(asset["size"]),Notes=DesktopFiles.String(release,"body") };
      }
      throw new Exception("新版安装程序尚未准备好");
    }
    public async Task DownloadNow() {
      if(!await gate.WaitAsync(0))return;
      try {await Download();}finally{gate.Release();}
    }
    async Task Download() {
      if(Available==null) return;
      Directory.CreateDirectory(Path.Combine(data,"updates"));
      var target=Path.Combine(data,"updates","FrameStudio-v"+Available.Version+"-win-x64-Setup.exe");
      try {
        Error="";
        if(!File.Exists(target) || Hash(target)!=Available.Sha256) {
          if(File.Exists(target)) File.Delete(target);
          await DownloadFile(new Uri(Available.Url),target,(received,total)=>{Received=received;Total=total;Change("downloading","正在后台下载新版 "+Available.Version);});
          if(Hash(target)!=Available.Sha256) { File.Delete(target); throw new Exception("更新文件校验失败"); }
        }
        Available.File=target;
        DesktopFiles.Write(Path.Combine(data,"updates","ready.json"),new { version=Available.Version,file=target,sha256=Available.Sha256,previous=current });
        Change("ready",Automatic?"新版已准备好，将在退出时自动安装":"新版已准备好，可以重启更新");
      } catch(Exception error) { Error="更新下载未完成，稍后可继续下载。"; Change("failed",Error); Log(error); }
    }
    public void RestorePrepared() {
      var marker=DesktopFiles.Read(Path.Combine(data,"updates","ready.json")); var file=DesktopFiles.String(marker,"file"); var version=DesktopFiles.String(marker,"version"); var digest=DesktopFiles.String(marker,"sha256"); Version a,b;
      if(!System.Text.RegularExpressions.Regex.IsMatch(version,@"^\d+\.\d+\.\d+$") || !Version.TryParse(version,out a) || !Version.TryParse(current,out b) || a<=b || Path.GetFileName(file)!="FrameStudio-v"+version+"-win-x64-Setup.exe" || !DesktopFiles.Within(file,Path.Combine(data,"updates")) || !File.Exists(file) || Hash(file)!=digest) return;
      Available=new ReleaseUpdate { Version=version,File=file,Sha256=digest }; Change("ready",Automatic?"新版已准备好，将在退出时自动安装":"新版已准备好，可以重启更新");
    }
    public static string Hash(string path) { using(var input=File.OpenRead(path)) using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(input)).Replace("-","").ToLowerInvariant(); }
    void Log(Exception error) { File.AppendAllText(Path.Combine(data,"updates.log"),DateTime.Now.ToString("O")+" "+error+Environment.NewLine); }
    public static async Task DownloadFile(Uri url,string target,Action<long,long> progress) {
      for(int attempt=0;attempt<3;attempt++) {
        try {await DownloadAttempt(url,target,progress);return;}
        catch {if(attempt==2)throw;}
        await Task.Delay(2000*(attempt+1));
      }
    }
    static async Task DownloadAttempt(Uri url,string target,Action<long,long> progress) {
      var partial=target+".part";
      var offset=File.Exists(partial) ? new FileInfo(partial).Length : 0;
      var request=(HttpWebRequest)WebRequest.Create(url); request.UserAgent="FRAME-Studio-Windows"; request.Timeout=20000;request.ReadWriteTimeout=30000;
      if(offset>0) request.AddRange(offset);
      HttpWebResponse response;
      try { response=(HttpWebResponse)await request.GetResponseAsync(); }
      catch(WebException error) {
        if(offset>0 && error.Response!=null && ((HttpWebResponse)error.Response).StatusCode==HttpStatusCode.RequestedRangeNotSatisfiable) { File.Move(partial,target); return; }
        throw;
      }
      using(response) {
        if(response.StatusCode!=HttpStatusCode.PartialContent) offset=0;
        var total=response.ContentLength<0 ? 0 : offset+response.ContentLength;
        using(var input=response.GetResponseStream()) using(var output=new FileStream(partial,offset>0 ? FileMode.Append : FileMode.Create,FileAccess.Write,FileShare.Read,1024*1024,true)) {
          var buffer=new byte[1024*1024]; var received=offset; int count;
          while((count=await input.ReadAsync(buffer,0,buffer.Length))>0) { await output.WriteAsync(buffer,0,count); received+=count; if(progress!=null) progress(received,total); }
          if(total>0 && received!=total) throw new Exception("Download was interrupted");
        }
      }
      File.Move(partial,target);
    }
  }
}
