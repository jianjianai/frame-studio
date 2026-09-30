using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Threading.Tasks;

namespace FrameStudioDesktop {
  static class UpdatesTest {
    static int Main(string[] args) {try{Run(args).GetAwaiter().GetResult();return 0;}catch(Exception error){Console.Error.WriteLine(error);return 1;}}
    static void Assert(bool value,string message){if(!value)throw new Exception(message);Console.WriteLine("PASS: "+message);}
    static async Task Run(string[] args) {
      var data=args[0];var origin=args[1];var expected=args[2];Directory.CreateDirectory(data);
      var target=Path.Combine(data,"partial.exe");File.WriteAllBytes(target+".part",new byte[0]);
      var seed=new byte[65536];for(int i=0;i<seed.Length;i++)seed[i]=37;File.WriteAllBytes(target+".part",seed);
      await DesktopUpdates.DownloadFile(new Uri(origin+"/resume"),target,null);Assert(DesktopUpdates.Hash(target)==expected,"update download resumes verified bytes");
      target=Path.Combine(data,"ignored.exe");File.WriteAllBytes(target+".part",seed);await DesktopUpdates.DownloadFile(new Uri(origin+"/ignore"),target,null);Assert(DesktopUpdates.Hash(target)==expected,"server ignoring Range restarts cleanly");
      target=Path.Combine(data,"interrupted.exe");await DesktopUpdates.DownloadFile(new Uri(origin+"/interrupted"),target,null);Assert(DesktopUpdates.Hash(target)==expected,"interrupted update automatically retries from partial bytes");
      var updates=new DesktopUpdates(data,"7.5.0",new Uri(origin+"/release"));await updates.Check(true);Assert(updates.State=="ready","official release metadata produces a verified ready update");
      var restored=new DesktopUpdates(data,"7.5.0",new Uri(origin+"/release"));restored.RestorePrepared();Assert(restored.State=="ready","prepared update survives application restart");
      restored.SetAutomatic(false);Assert(!new DesktopUpdates(data,"7.5.0",new Uri(origin+"/release")).Automatic,"automatic update preference persists");
      var marker=DesktopFiles.Read(Path.Combine(data,"updates","ready.json"));File.AppendAllText(DesktopFiles.String(marker,"file"),"tamper");var rejected=new DesktopUpdates(data,"7.5.0",new Uri(origin+"/release"));rejected.RestorePrepared();Assert(rejected.State!="ready","tampered installer is never marked ready");
      using(var client=new WebClient()) {
        var release=client.DownloadString(origin+"/release");
        Assert(DesktopUpdates.ParseRelease(release,"7.5.1",false)==null,"same version and downgrade do not update");
        bool bad=false;try{DesktopUpdates.ParseRelease(release,"7.5.0",true);}catch{bad=true;}Assert(bad,"non-repository installer source is rejected");
        bad=false;try{DesktopUpdates.ParseRelease(release.Replace("sha256:","invalid:"),"7.5.0",false);}catch{bad=true;}Assert(bad,"release without SHA-256 is rejected");
      }
    }
  }
}
