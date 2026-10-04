using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace FrameStudioDesktop {
  sealed class SetupForm : Form {
    readonly SetupOptions options;
    readonly SetupEngine engine=new SetupEngine();
    readonly Label heading,description,status,detail,steps;
    readonly TextBox location;
    readonly CheckBox shortcut,launch;
    readonly ProgressBar progress;
    readonly Button primary,cancel,diagnostics;
    readonly FlowLayoutPanel body;
    bool busy,done;
    public int Result=1;
    public async Task TestFlow(string output) {
      if(!DesktopNames.Test)return;Directory.CreateDirectory(output);
      SaveImage(Path.Combine(output,"installer-welcome.png"));launch.Checked=false;
      await BeginInstall();SaveImage(Path.Combine(output,done?"installer-complete.png":"installer-failed.png"));
      DesktopFiles.Write(Path.Combine(output,"installer-result.json"),new { done=done,result=Result,status=status.Text,detail=detail.Text });Close();
    }
    void SaveImage(string file){using(var image=new Bitmap(Width,Height)){DrawToBitmap(image,new Rectangle(Point.Empty,Size));image.Save(file,System.Drawing.Imaging.ImageFormat.Png);}}
    public SetupForm(SetupOptions options) {
      SuspendLayout();this.options=options; Text="安装 FRAME Studio"; ClientSize=new Size(740,540);MaximizeBox=false;StartPosition=FormStartPosition.CenterScreen;BackColor=DesktopTheme.Paper;Font=DesktopTheme.Font(10);Icon=DesktopTheme.Icon;
      body=new FlowLayoutPanel { Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,Padding=new Padding(34,28,34,20),AutoScroll=true };
      Controls.Add(body);
      body.Controls.Add(DesktopTheme.Label("FRAME  /  WINDOWS",10,true));
      heading=DesktopTheme.Label("让想法成为作品",24,true); body.Controls.Add(heading);
      description=DesktopTheme.Label("完整动画工作台，安装到你的电脑。",11); body.Controls.Add(description);
      body.Controls.Add(DesktopTheme.Label("安装位置",10,true));
      var folder=new FlowLayoutPanel { AutoSize=true,WrapContents=false,Margin=new Padding(0,0,0,14) };
      location=new TextBox { Text=options.Root,Width=535,Font=DesktopTheme.Font(10),Margin=new Padding(0,5,10,0) }; folder.Controls.Add(location);
      var browse=DesktopTheme.Button("选择…"); browse.Click+=(s,e)=>{using(var dialog=new FolderBrowserDialog { SelectedPath=location.Text,Description="选择 FRAME Studio 程序安装目录" }) if(dialog.ShowDialog(this)==DialogResult.OK) location.Text=dialog.SelectedPath;}; folder.Controls.Add(browse); body.Controls.Add(folder);
      shortcut=new CheckBox { Text="创建桌面快捷方式",Checked=options.Shortcut,AutoSize=true,Margin=new Padding(0,0,0,12) };body.Controls.Add(shortcut);
      steps=DesktopTheme.Label("检查电脑  →  下载依赖  →  安装工作台  →  完成",10);body.Controls.Add(steps);
      status=DesktopTheme.Label("首次安装需要联网；更新会复用已安装环境。",11,true);body.Controls.Add(status);
      detail=DesktopTheme.Label(DownloadSummary(),9); detail.ForeColor=DesktopTheme.Muted;body.Controls.Add(detail);
      progress=new ProgressBar { Width=662,Height=8,Minimum=0,Maximum=100,Margin=new Padding(0,4,0,14) };body.Controls.Add(progress);
      launch=new CheckBox { Text="安装完成后打开 FRAME Studio",Checked=true,AutoSize=true,Visible=false,Margin=new Padding(0,0,0,14) };body.Controls.Add(launch);
      var actions=new FlowLayoutPanel { AutoSize=true,WrapContents=false,Margin=new Padding(0,12,0,0) };
      primary=DesktopTheme.Button("安装并开始创作",true);primary.Click+=async(s,e)=>await BeginInstall();actions.Controls.Add(primary);
      cancel=DesktopTheme.Button("取消");cancel.Click+=(s,e)=>CancelOrClose();actions.Controls.Add(cancel);
      diagnostics=DesktopTheme.Button("查看详细日志");diagnostics.Visible=false;diagnostics.Click+=(s,e)=>{var log=Path.Combine(options.Data,"installer.log");if(File.Exists(log))DesktopTheme.Open(log);};actions.Controls.Add(diagnostics);body.Controls.Add(actions);
      engine.Output+=Output;
      FormClosing+=(s,e)=>{if(busy){e.Cancel=true;CancelOrClose();}};
      AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;ResumeLayout(false);MinimumSize=Size;
    }
    string DownloadSummary() {
      try {
        var manifest=DesktopFiles.Read(Path.Combine(options.Source,"desktop","runtime-manifest.json")); var components=(Dictionary<string,object>)manifest["components"];long bytes=0;
        foreach(var component in components.Values) { var value=(Dictionary<string,object>)component;var marker=Path.Combine(options.Data,"runtimes",DesktopFiles.String(value,"id"),"FRAME-RUNTIME.json"); if(!File.Exists(marker) && value.ContainsKey("bytes")) bytes+=Convert.ToInt64(value["bytes"]); }
        return bytes>0 ? "工具与语音环境约 "+DesktopTheme.Bytes(bytes)+"，另由 pnpm 下载工作台依赖。语音模型在安装后按需选择。" : "已检测到运行环境缓存；仅准备缺少的依赖。作品、素材和模型会保留。";
      } catch { return "依赖保存在独立缓存中；网络中断后可继续下载。"; }
    }
    async Task BeginInstall() {
      if(done) { if(launch.Checked) DesktopTheme.Open(Path.Combine(options.Root,"versions",options.Version,"FrameStudio.exe")); Close(); return; }
      if(busy) return;
      if(SetupEngine.AppRunning()) {
        if(MessageBox.Show(this,"工作台正在运行。关闭工作台后可以继续安装，正在进行的任务会由工作台提醒处理。","准备更新",MessageBoxButtons.OKCancel,MessageBoxIcon.Information)!=DialogResult.OK)return;
        try { using(var request=EventWaitHandle.OpenExisting(DesktopNames.Ipc("Close"))) request.Set(); } catch {}
        for(int i=0;i<60 && SetupEngine.AppRunning();i++) await Task.Delay(500);
        if(SetupEngine.AppRunning()) { status.Text="请完成工作台的退出确认后再继续安装。";return; }
      }
      options.Root=location.Text.Trim(); options.Shortcut=shortcut.Checked;
      busy=true;primary.Enabled=false;location.Enabled=false;shortcut.Enabled=false;diagnostics.Visible=false;cancel.Text="取消安装";
      try {
        await engine.Install(options);busy=false;done=true;Result=0;
        heading.Text="已准备好，可以开始创作";description.Text="作品保存在这台电脑，关闭窗口后可从托盘继续打开。";status.Text="FRAME Studio "+options.Version+" 安装完成";detail.Text="自动更新已开启；新版在后台准备，退出工作台时安装。";progress.Value=100;
        primary.Text="完成";primary.Enabled=true;launch.Visible=true;cancel.Visible=false;
      } catch(OperationCanceledException) { busy=false;heading.Text="安装已暂停";status.Text="已下载内容会保留，下次可以继续。";primary.Text="继续安装";primary.Enabled=true;cancel.Text="关闭";location.Enabled=true;shortcut.Enabled=true; }
      catch(Exception error) { busy=false;heading.Text="还差一步，继续准备";status.Text=error.Message;detail.Text="作品与旧版本保持可用。可以重试，或查看详细日志。";primary.Text="重试安装";primary.Enabled=true;cancel.Text="关闭";diagnostics.Visible=true;location.Enabled=true;shortcut.Enabled=true; }
    }
    void CancelOrClose() {
      if(!busy) {Close();return;}
      if(MessageBox.Show(this,"暂停安装？已下载的内容会保留，再次安装时继续。","暂停安装",MessageBoxButtons.YesNo,MessageBoxIcon.Question)==DialogResult.Yes){cancel.Enabled=false;engine.Cancel();cancel.Enabled=true;}
    }
    void Output(string line) {
      if(IsDisposed)return;
      if(InvokeRequired){try{BeginInvoke((Action)(()=>Output(line)));}catch{}return;}
      if(!line.StartsWith("FRAME_PROGRESS "))return;
      try {
        var value=DesktopFiles.Json.Deserialize<Dictionary<string,object>>(line.Substring(15));var component=DesktopFiles.String(value,"component");var phase=DesktopFiles.String(value,"phase");
        var names=new Dictionary<string,string>{{"checking","检查电脑"},{"tools","工具环境"},{"speech","语音运行环境"},{"dependencies","工作台依赖"},{"t3","T3 Code 创作环境"},{"browser","预览浏览器"},{"github","GitHub 授权工具"},{"application","安装工作台"}};
        status.Text=(names.ContainsKey(component)?names[component]:"准备环境")+" · "+DesktopFiles.String(value,"message");
        long received=value.ContainsKey("received")?Convert.ToInt64(value["received"]):0,total=value.ContainsKey("total")?Convert.ToInt64(value["total"]):0;
        double speed=value.ContainsKey("speed")?Convert.ToDouble(value["speed"]):0;
        var basePercent=new Dictionary<string,int>{{"checking",2},{"tools",5},{"speech",30},{"dependencies",60},{"t3",77},{"browser",85},{"github",91},{"application",96}};
        var weights=new Dictionary<string,int>{{"tools",25},{"speech",30},{"dependencies",17},{"t3",8},{"browser",6},{"github",5},{"application",4}};
        int start=basePercent.ContainsKey(component)?basePercent[component]:0,weight=weights.ContainsKey(component)?weights[component]:0;
        progress.Value=Math.Max(progress.Value,Math.Min(100,start+((phase=="done"||phase=="cached")?weight:total>0?(int)(weight*received/total):0)));
        if(total>0) detail.Text=DesktopTheme.Bytes(received)+" / "+DesktopTheme.Bytes(total)+(speed>0?"  ·  "+DesktopTheme.Bytes((long)speed)+"/s":"");
        else detail.Text=phase=="cached"?"复用现有缓存，不重复下载。":phase=="installing"?"正在配置环境，请稍候；可以安全取消后继续。":"网络中断后自动重试，已下载的部分会保留。";
      } catch {}
    }
  }
}
