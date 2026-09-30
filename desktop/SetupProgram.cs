using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Windows.Forms;

namespace FrameStudioDesktop {
  static class SetupProgram {
    [STAThread] static int Main(string[] args) {
      ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
      Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
      var source=Argument(args,"--source",AppDomain.CurrentDomain.BaseDirectory);
      var root=Argument(args,"--root",SetupEngine.RegisteredRoot());
      if(root=="")root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","FRAME Studio");
      var data=Environment.GetEnvironmentVariable("FRAME_LOCAL_DATA") ?? SetupEngine.RegisteredData();
      if(String.IsNullOrEmpty(data))data=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"FRAME Studio");
      try {
        if(Array.IndexOf(args,"--apply-update")>=0)return ApplyUpdate(args,root,data);
        if(Array.IndexOf(args,"--open-previous")>=0) {WaitParent(args);var v=DesktopFiles.String(DesktopFiles.Read(Path.Combine(root,"installation.json")),"previous");if(!System.Text.RegularExpressions.Regex.IsMatch(v,@"^\d+\.\d+\.\d+$"))throw new Exception("上一版本不存在。");DesktopTheme.Open(Path.Combine(root,"versions",v,"FrameStudio.exe"));return 0;}
        if(Array.IndexOf(args,"--uninstall")>=0)return Uninstall(args,source,root,data);
        var options=new SetupOptions { Source=source,Root=root,Data=data,Version=Argument(args,"--version",""),Uninstaller=Argument(args,"--uninstaller",Path.Combine(source,"Uninstall.exe")),Silent=Array.IndexOf(args,"--silent")>=0,Restart=Array.IndexOf(args,"--restart")>=0,Shortcut=DesktopFiles.Bool(DesktopFiles.Read(Path.Combine(data,"desktop-settings.json")),"desktopShortcut",true) };
        if(options.Silent) {
          var engine=new SetupEngine();engine.Output+=line=>Console.WriteLine(line);engine.Install(options).GetAwaiter().GetResult();
          if(options.Restart) DesktopTheme.Open(Path.Combine(root,"versions",options.Version,"FrameStudio.exe"));return 0;
        }
        using(var form=new SetupForm(options)) {if(DesktopNames.Test&&Array.IndexOf(args,"--test-ui")>=0)form.Shown+=async(s,e)=>await form.TestFlow(Argument(args,"--test-output"));Application.Run(form);return form.Result; }
      } catch(Exception error) {
        Directory.CreateDirectory(data);File.AppendAllText(Path.Combine(data,"installer.log"),DateTime.Now.ToString("O")+" "+error+Environment.NewLine);
        if(Array.IndexOf(args,"--silent")<0) MessageBox.Show("安装未完成："+error.Message,"FRAME Studio",MessageBoxButtons.OK,MessageBoxIcon.Error);
        return 1;
      }
    }
    public static string Argument(string[] args,string key,string fallback="") { var index=Array.IndexOf(args,key);return index>=0 && index+1<args.Length?args[index+1]:fallback; }
    static void WaitParent(string[] args) {
      int pid;if(Int32.TryParse(Argument(args,"--wait-pid"),out pid)) { try { using(var process=Process.GetProcessById(pid)) if(!process.WaitForExit(60000))throw new Exception("工作台尚未退出，更新延后。" ); }catch(ArgumentException){} }
    }
    static int ApplyUpdate(string[] args,string root,string data) {
      WaitParent(args);
      var marker=DesktopFiles.Read(Path.Combine(data,"updates","ready.json"));var file=DesktopFiles.String(marker,"file");
      var next=DesktopFiles.String(marker,"version");
      if(!System.Text.RegularExpressions.Regex.IsMatch(next,@"^\d+\.\d+\.\d+$") || Path.GetFileName(file)!="FrameStudio-v"+next+"-win-x64-Setup.exe" || !DesktopFiles.Within(file,Path.Combine(data,"updates")) || !File.Exists(file) || DesktopUpdates.Hash(file)!=DesktopFiles.String(marker,"sha256"))throw new Exception("更新文件校验失败，请重新下载。");
      var restart=Array.IndexOf(args,"--restart")>=0;
      var info=new ProcessStartInfo(file,"/S"+(restart?" /RESTARTAPP":"")+" /D="+root) { UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden };
      using(var process=Process.Start(info)) {
        process.WaitForExit();if(process.ExitCode==0) {File.Delete(Path.Combine(data,"updates","ready.json"));return 0;}
        File.AppendAllText(Path.Combine(data,"updates.log"),DateTime.Now.ToString("O")+" 更新安装失败，保留原版本。"+Environment.NewLine);
      }
      if(restart) { var previous=DesktopFiles.String(marker,"previous");if(System.Text.RegularExpressions.Regex.IsMatch(previous,@"^\d+\.\d+\.\d+$")){var app=Path.Combine(root,"versions",previous,"FrameStudio.exe"); if(File.Exists(app))DesktopTheme.Open(app);} }
      return 1;
    }
    static int Uninstall(string[] args,string source,string root,string data) {
      var engine=new SetupEngine();
      if(Array.IndexOf(args,"--silent")>=0) {engine.Uninstall(source,root).GetAwaiter().GetResult();return 0;}
      using(var form=DesktopTheme.Form("卸载 FRAME Studio",new Size(640,330))) {
        var body=new FlowLayoutPanel { Dock=DockStyle.Fill,Padding=new Padding(28),FlowDirection=FlowDirection.TopDown,WrapContents=false };
        body.Controls.Add(DesktopTheme.Label("卸载 FRAME Studio",21,true));body.Controls.Add(DesktopTheme.Label("只移除程序。你的作品、素材、模型和依赖缓存会继续保留。",11));
        var path=DesktopTheme.Label("数据位置："+data,9);path.ForeColor=DesktopTheme.Muted;body.Controls.Add(path);
        var actions=new FlowLayoutPanel { AutoSize=true,WrapContents=false };var remove=DesktopTheme.Button("卸载程序",true);var cancel=DesktopTheme.Button("取消");var open=DesktopTheme.Button("打开数据目录");actions.Controls.Add(remove);actions.Controls.Add(cancel);actions.Controls.Add(open);body.Controls.Add(actions);form.Controls.Add(body);
        int result=1;bool busy=false;cancel.Click+=(s,e)=>form.Close();open.Click+=(s,e)=>{if(Directory.Exists(data))DesktopTheme.Open(data);};
        form.FormClosing+=(s,e)=>{if(busy)e.Cancel=true;};
        remove.Click+=async(s,e)=>{if(result==0){form.Close();return;}busy=true;remove.Enabled=false;cancel.Enabled=false;try{await engine.Uninstall(source,root);result=0;path.Text="程序已卸载。数据仍保存在 "+data;remove.Text="完成";remove.Enabled=true;}catch(Exception error){path.Text=error.Message;remove.Enabled=true;cancel.Enabled=true;}finally{busy=false;}};
        Application.Run(form);return result;
      }
    }
  }
}
