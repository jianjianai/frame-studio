using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace FrameStudioDesktop {
  static class Program {
    [STAThread] static void Main(string[] args) {
      ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
      Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
      bool first;
      using(var mutex=new Mutex(true,DesktopNames.Ipc("Desktop"),out first)) {
        if(!first) {try{using(var activate=EventWaitHandle.OpenExisting(DesktopNames.Ipc(Array.IndexOf(args,"--control-center")>=0?"Center":"Activate")))activate.Set();}catch{}return;}
        try{Application.Run(new MainWindow(args));}catch(Exception error){MessageBox.Show("FRAME Studio 未能打开："+error.Message,"FRAME Studio",MessageBoxButtons.OK,MessageBoxIcon.Error);}
      }
    }
  }
  sealed class MainWindow : Form {
    readonly string root=AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\'),data,version,installationRoot;
    readonly Panel content=new Panel { Dock=DockStyle.Fill,Padding=new Padding(28) };
    readonly Dictionary<string,FlowLayoutPanel> pages=new Dictionary<string,FlowLayoutPanel>();
    readonly Dictionary<string,Button> navigation=new Dictionary<string,Button>();
    readonly Label status=DesktopTheme.Label("正在打开创作环境",22,true),description=DesktopTheme.Label("只需稍候，工作台即将在默认浏览器打开。",11),stage=DesktopTheme.Label("检查已安装环境…",10),speechStatus=DesktopTheme.Label("语音服务将在后台准备。",10),taskStatus=DesktopTheme.Label("",10);
    readonly Label environmentStatus=DesktopTheme.Label("检查运行环境…",11),environmentDetail=DesktopTheme.Label("",10),updateStatus=DesktopTheme.Label("自动检查新版本",12,true),updateDetail=DesktopTheme.Label("",10);
    readonly Button open=DesktopTheme.Button("打开浏览器工作台",true),restart=DesktopTheme.Button("重启工作台"),retry=DesktopTheme.Button("重试启动"),retrySpeech=DesktopTheme.Button("重试语音服务"),repair=DesktopTheme.Button("检查并修复环境",true),pauseRepair=DesktopTheme.Button("暂停修复"),checkUpdate=DesktopTheme.Button("检查更新"),downloadUpdate=DesktopTheme.Button("继续下载"),applyUpdate=DesktopTheme.Button("重启并更新",true),previous=DesktopTheme.Button("打开上一版本");
    readonly ProgressBar environmentProgress=new ProgressBar {Width=550,Height=8},updateProgress=new ProgressBar {Width=550,Height=8};
    readonly CheckBox automatic=new CheckBox {Text="自动下载更新，并在退出时安装",AutoSize=true,Margin=new Padding(0,14,0,8),Name="automaticUpdates"};
    readonly NotifyIcon tray;
    readonly DesktopUpdates updates;
    readonly EventWaitHandle activate=new EventWaitHandle(false,EventResetMode.AutoReset,DesktopNames.Ipc("Activate")),center=new EventWaitHandle(false,EventResetMode.AutoReset,DesktopNames.Ipc("Center")),closeRequest=new EventWaitHandle(false,EventResetMode.AutoReset,DesktopNames.Ipc("Close"));
    readonly System.Windows.Forms.Timer ipc=new System.Windows.Forms.Timer {Interval=300},statusTimer=new System.Windows.Forms.Timer {Interval=5000},updateTimer=new System.Windows.Forms.Timer {Interval=3600000};
    readonly object logLock=new object();
    OwnedProcess server,preparing;
    string origin="",launchToken="";
    bool starting,ready,exiting,closing,repairCancelled,statusPolling,shownTrayNotice,updateBinding,showCenter;
    public MainWindow(string[] args) {
      SuspendLayout();
      data=Environment.GetEnvironmentVariable("FRAME_LOCAL_DATA") ?? SetupEngine.RegisteredData();if(String.IsNullOrEmpty(data))data=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"FRAME Studio");Directory.CreateDirectory(data);
      version=DesktopFiles.String(DesktopFiles.Read(Path.Combine(root,"package.json")),"version");installationRoot=Path.GetDirectoryName(Path.GetDirectoryName(root));showCenter=Array.IndexOf(args,"--control-center")>=0||DesktopNames.Test;
      Text="FRAME Studio · Windows 控制中心";Icon=DesktopTheme.Icon;Font=DesktopTheme.Font(10);BackColor=DesktopTheme.Paper;ClientSize=new Size(880,690);StartPosition=FormStartPosition.CenterScreen;
      var sidebar=new FlowLayoutPanel {Dock=DockStyle.Left,Width=190,Padding=new Padding(22,28,16,20),FlowDirection=FlowDirection.TopDown,WrapContents=false,BackColor=Color.FromArgb(237,241,230)};
      sidebar.Controls.Add(DesktopTheme.Label("FRAME",18,true));var subtitle=DesktopTheme.Label("WINDOWS 控制中心",8);subtitle.ForeColor=DesktopTheme.Muted;sidebar.Controls.Add(subtitle);
      foreach(var entry in new[]{new[]{"overview","运行概览"},new[]{"environment","运行环境"},new[]{"updates","应用更新"},new[]{"logs","日志与诊断"}}){var tab=entry[0];var button=DesktopTheme.Button(entry[1]);button.Width=150;button.Margin=new Padding(0,8,0,0);button.TextAlign=ContentAlignment.MiddleLeft;button.Click+=(s,e)=>OpenPage(tab);sidebar.Controls.Add(button);navigation[tab]=button;}
      var versionLabel=DesktopTheme.Label("版本 "+version,9);versionLabel.ForeColor=DesktopTheme.Muted;versionLabel.Margin=new Padding(0,36,0,0);sidebar.Controls.Add(versionLabel);
      Controls.Add(content);Controls.Add(sidebar);
      var overview=Page("overview");overview.Controls.Add(DesktopTheme.Label("你的创作环境",10));overview.Controls.Add(status);overview.Controls.Add(description);
      var running=Card();running.Controls.Add(DesktopTheme.Label("工作台服务",11,true));running.Controls.Add(stage);running.Controls.Add(taskStatus);running.Controls.Add(speechStatus);retrySpeech.Visible=false;retrySpeech.Click+=async(s,e)=>{try{await LocalRequest("/api/desktop/speech-retry",true);await PollStatus();}catch(Exception error){Log(error.Message);}};running.Controls.Add(retrySpeech);overview.Controls.Add(running);
      var mainActions=Row(open,restart,retry);overview.Controls.Add(mainActions);overview.Controls.Add(DesktopTheme.Label("关闭此窗口会收起到托盘，浏览器工作台与后台任务继续运行。",9));
      previous.Visible=false;previous.Click+=async(s,e)=>await OpenPrevious();overview.Controls.Add(previous);
      var environment=Page("environment");environment.Controls.Add(DesktopTheme.Label("运行环境",22,true));environment.Controls.Add(DesktopTheme.Label("独立保存依赖缓存，更新程序时复用。语音模型在工作台中按需下载。",10));
      var components=Card();foreach(var entry in new[]{new[]{"工具环境","Node、Git、FFmpeg、pnpm 与 GitHub 授权工具"},new[]{"工作台依赖","由 pnpm 根据锁文件安装，复用包缓存"},new[]{"语音环境","Python 与语音引擎，模型可选下载"},new[]{"预览浏览器","使用本机 Edge / Chrome，缺失时准备 Chromium"}}){components.Controls.Add(DesktopTheme.Label(entry[0],10,true));var detail=DesktopTheme.Label(entry[1],9);detail.ForeColor=DesktopTheme.Muted;components.Controls.Add(detail);}environment.Controls.Add(components);
      environment.Controls.Add(environmentStatus);environment.Controls.Add(environmentProgress);environment.Controls.Add(environmentDetail);environment.Controls.Add(Row(repair,pauseRepair));pauseRepair.Visible=false;
      var updatePage=Page("updates");updatePage.Controls.Add(DesktopTheme.Label("应用更新",22,true));updatePage.Controls.Add(DesktopTheme.Label("在后台准备新版。作品、素材、模型与依赖保存在原位置。",10));
      var updateCard=Card();updateCard.Controls.Add(DesktopTheme.Label("当前版本 "+version,10));updateCard.Controls.Add(updateStatus);updateCard.Controls.Add(updateProgress);updateCard.Controls.Add(updateDetail);updateCard.Controls.Add(Row(checkUpdate,downloadUpdate,applyUpdate));updateCard.Controls.Add(automatic);updateCard.Controls.Add(DesktopTheme.Label("任务运行或编辑未保存时会延后重启。网络中断后可以继续下载。",9));updatePage.Controls.Add(updateCard);
      var logPage=Page("logs");logPage.Controls.Add(DesktopTheme.Label("日志与诊断",22,true));logPage.Controls.Add(DesktopTheme.Label("遇到问题时查看运行日志，或打开数据目录定位作品与缓存。",10));logPage.Controls.Add(DesktopTheme.Label("作品数据",10,true));var location=DesktopTheme.Label(data,9);location.ForeColor=DesktopTheme.Muted;logPage.Controls.Add(location);
      Button logs=DesktopTheme.Button("打开运行日志"),installLog=DesktopTheme.Button("打开安装日志"),updateLog=DesktopTheme.Button("打开更新日志"),openData=DesktopTheme.Button("打开数据目录");logs.Click+=(s,e)=>OpenLog("desktop.log");installLog.Click+=(s,e)=>OpenLog("installer.log");updateLog.Click+=(s,e)=>OpenLog("updates.log");openData.Click+=(s,e)=>DesktopTheme.Open(data);logPage.Controls.Add(Row(logs,installLog,updateLog));logPage.Controls.Add(Row(openData));
      var quit=DesktopTheme.Button("退出 FRAME Studio");quit.Click+=async(s,e)=>await RequestExit(false,false);logPage.Controls.Add(Row(quit));
      open.Click+=(s,e)=>OpenBrowser();restart.Click+=async(s,e)=>await Restart();retry.Click+=async(s,e)=>await Start();repair.Click+=async(s,e)=>await Repair();pauseRepair.Click+=(s,e)=>{repairCancelled=true;if(preparing!=null)preparing.Stop();};
      var testEndpoint=DesktopNames.Test?Environment.GetEnvironmentVariable("FRAME_TEST_UPDATE_URL"):null;updates=new DesktopUpdates(data,version,String.IsNullOrEmpty(testEndpoint)?null:new Uri(testEndpoint));updates.Changed+=()=>Ui(UpdatesChanged);updates.RestorePrepared();
      checkUpdate.Click+=async(s,e)=>await updates.Check(true);downloadUpdate.Click+=async(s,e)=>await updates.DownloadNow();applyUpdate.Click+=async(s,e)=>await RequestExit(true,true);automatic.CheckedChanged+=async(s,e)=>{if(!updateBinding){updates.SetAutomatic(automatic.Checked);if(automatic.Checked&&updates.Available!=null&&updates.State!="ready")await updates.DownloadNow();}};
      tray=new NotifyIcon {Icon=DesktopTheme.Icon,Text="FRAME Studio · 正在启动",ContextMenuStrip=TrayMenu(),Visible=true};tray.MouseClick+=(s,e)=>{if(e.Button==MouseButtons.Left)OpenBrowser();};tray.DoubleClick+=(s,e)=>OpenBrowser();
      ipc.Tick+=async(s,e)=>{if(activate.WaitOne(0))OpenBrowser();if(center.WaitOne(0))ShowCenter("overview");if(closeRequest.WaitOne(0)){ShowCenter("overview");await RequestExit(false,false);}};ipc.Start();statusTimer.Tick+=async(s,e)=>await PollStatus();statusTimer.Start();
      updateTimer.Tick+=async(s,e)=>{if(!starting&&!closing&&!exiting&&(!DesktopNames.Test||Environment.GetEnvironmentVariable("FRAME_TEST_UPDATE_URL")!=null))await updates.Check();};updateTimer.Start();
      Shown+=async(s,e)=>{await Start();if(DesktopNames.Test&&Array.IndexOf(args,"--test-ui")>=0)await ControlCenterTest.Run(this,args,OpenPage,()=>RequestExit(false,false),Restart,OpenBrowser,()=>{if(DesktopNames.Test&&server!=null)server.Stop();});};
      FormClosing+=(s,e)=>{if(!exiting){e.Cancel=true;Hide();if(!shownTrayNotice){shownTrayNotice=true;tray.ShowBalloonTip(3000,"FRAME Studio","已收起到托盘。左键打开浏览器，右键打开控制中心或退出。",ToolTipIcon.Info);}}};
      FormClosed+=(s,e)=>{ipc.Dispose();statusTimer.Dispose();updateTimer.Dispose();tray.Dispose();activate.Dispose();center.Dispose();closeRequest.Dispose();if(preparing!=null)preparing.Dispose();if(server!=null)server.Dispose();};
      AutoScaleDimensions=new SizeF(96,96);AutoScaleMode=AutoScaleMode.Dpi;ResumeLayout(false);MinimumSize=Size;OpenPage("overview");UpdatesChanged();
    }
    FlowLayoutPanel Page(string id){var page=new FlowLayoutPanel {Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoScroll=true,Visible=false};pages[id]=page;content.Controls.Add(page);return page;}
    FlowLayoutPanel Card(){var panel=new FlowLayoutPanel {FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoSize=true,Width=570,MinimumSize=new Size(570,0),Padding=new Padding(20,16,20,12),BackColor=Color.White,Margin=new Padding(0,12,0,18)};return panel;}
    static FlowLayoutPanel Row(params Button[] buttons){var row=new FlowLayoutPanel {AutoSize=true,WrapContents=true,MaximumSize=new Size(570,0),Margin=new Padding(0,12,0,18)};foreach(var button in buttons)row.Controls.Add(button);return row;}
    void OpenPage(string id){if(!pages.ContainsKey(id))id="overview";foreach(var entry in pages)entry.Value.Visible=entry.Key==id;foreach(var entry in navigation)entry.Value.BackColor=entry.Key==id?DesktopTheme.Green:Color.FromArgb(237,241,230);pages[id].BringToFront();}
    void ShowCenter(string tab){showCenter=true;OpenPage(tab);Show();if(WindowState==FormWindowState.Minimized)WindowState=FormWindowState.Normal;Activate();}
    void OpenBrowser(){if(ready){if(DesktopNames.Test)DesktopFiles.Write(Path.Combine(data,"desktop-test-browser.json"),new{url=origin+"/",at=DateTime.UtcNow.Ticks});else DesktopTheme.Open(origin+"/");}else ShowCenter("overview");}
    void Ui(Action action){if(IsDisposed)return;try{if(InvokeRequired)BeginInvoke(action);else action();}catch(InvalidOperationException){}}
    void Log(string line){if(String.IsNullOrEmpty(line))return;lock(logLock)File.AppendAllText(Path.Combine(data,"desktop.log"),DateTime.Now.ToString("O")+" "+line+Environment.NewLine,Encoding.UTF8);}
    void OpenLog(string name){var file=Path.Combine(data,name);if(File.Exists(file))DesktopTheme.Open(file);else DesktopTheme.Open(data);}
    ContextMenuStrip TrayMenu(){var menu=new ContextMenuStrip {Font=DesktopTheme.Font(10)};menu.Items.Add("打开浏览器工作台",null,(s,e)=>OpenBrowser());menu.Items.Add("Windows 控制中心",null,(s,e)=>ShowCenter("overview"));menu.Items.Add("运行环境",null,(s,e)=>ShowCenter("environment"));menu.Items.Add("应用更新",null,async(s,e)=>{ShowCenter("updates");await updates.Check(true);});menu.Items.Add(new ToolStripSeparator());menu.Items.Add("重启工作台",null,async(s,e)=>await Restart());menu.Items.Add("打开作品数据",null,(s,e)=>DesktopTheme.Open(data));menu.Items.Add(new ToolStripSeparator());menu.Items.Add("退出 FRAME Studio",null,async(s,e)=>await RequestExit(false,false));return menu;}
    string Runtime(Dictionary<string,object> entry){var id=DesktopFiles.String(entry,"id");if(!System.Text.RegularExpressions.Regex.IsMatch(id,@"^[a-zA-Z0-9._-]+$"))throw new Exception("运行环境清单无效，请重新安装程序。");var directory=Path.Combine(data,"runtimes",id);if(DesktopFiles.String(DesktopFiles.Read(Path.Combine(directory,"FRAME-RUNTIME.json")),"sha256")!=DesktopFiles.String(entry,"sha256"))throw new Exception("运行环境尚未准备好，请在运行环境页面修复。");return directory;}
    int ChoosePort(){var settings=DesktopFiles.Read(Path.Combine(data,"desktop-settings.json"));int preferred; if(!Int32.TryParse(DesktopFiles.String(settings,"port","43173"),out preferred)||preferred<1024||preferred>65535)preferred=43173;var listener=new TcpListener(IPAddress.Loopback,preferred);try{listener.Start();}catch(SocketException){listener.Stop();listener=new TcpListener(IPAddress.Loopback,0);listener.Start();}var port=((IPEndPoint)listener.LocalEndpoint).Port;listener.Stop();settings["port"]=port;DesktopFiles.Write(Path.Combine(data,"desktop-settings.json"),settings);return port;}
    async Task Start(){if(starting||exiting)return;starting=true;ready=false;open.Enabled=restart.Enabled=false;retry.Visible=false;status.Text="正在打开创作环境";description.Text="只需稍候，工作台即将在默认浏览器打开。";stage.Text="检查已安装环境…";
      try{
        if(server!=null){server.Dispose();server=null;}var manifest=DesktopFiles.Read(Path.Combine(root,"desktop","runtime-manifest.json"));var components=(Dictionary<string,object>)manifest["components"];var tools=Runtime((Dictionary<string,object>)components["tools"]);var speech=Runtime((Dictionary<string,object>)components["speech"]);var deps=Runtime((Dictionary<string,object>)manifest["dependencies"]);
        var github=DesktopFiles.String(DesktopFiles.Read(Path.Combine(data,"runtime-selection.json")),"github");
        var node=Path.Combine(tools,"node.exe");if(!File.Exists(node)||!File.Exists(Path.Combine(deps,"node_modules",".modules.yaml"))||!File.Exists(Path.Combine(root,"node_modules",".modules.yaml")))throw new Exception("已安装环境缺失。运行环境页面可以补齐并复用下载缓存。");
        int port=ChoosePort();var token=Guid.NewGuid().ToString("N");launchToken=token;var startup=new TaskCompletionSource<string>();var info=new ProcessStartInfo(node,DesktopFiles.Quote(Path.Combine(root,"server","local-app.mjs"))){WorkingDirectory=root,RedirectStandardInput=true};
        info.EnvironmentVariables["PATH"]=String.Join(";",new[]{tools,Path.Combine(tools,"tools","pnpm"),Path.Combine(tools,"git","cmd"),Path.Combine(tools,"git","mingw64","bin"),Path.Combine(tools,"ffmpeg","bin"),github,Environment.GetEnvironmentVariable("PATH",EnvironmentVariableTarget.User),Environment.GetEnvironmentVariable("PATH",EnvironmentVariableTarget.Machine),info.EnvironmentVariables["PATH"]});info.EnvironmentVariables["FRAME_LOCAL_MODE"]="1";info.EnvironmentVariables["FRAME_LOCAL_DATA"]=data;info.EnvironmentVariables["FRAME_LOCAL_PORT"]=port.ToString();info.EnvironmentVariables["FRAME_LAUNCH_TOKEN"]=launchToken;info.EnvironmentVariables["FRAME_SPEECH_PYTHON"]=Path.Combine(speech,"python","python.exe");info.EnvironmentVariables["PLAYWRIGHT_BROWSERS_PATH"]=Path.Combine(data,"browsers");
        foreach(var edge in new[]{Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),@"Microsoft\Edge\Application\msedge.exe"),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),@"Microsoft\Edge\Application\msedge.exe"),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),@"Google\Chrome\Application\chrome.exe")})if(File.Exists(edge)){info.EnvironmentVariables["FRAME_BROWSER"]=edge;break;}
        var owned=new OwnedProcess(info,line=>{
          if(line.StartsWith("FRAME_LOCAL_READY ")){try{var value=DesktopFiles.Json.Deserialize<Dictionary<string,object>>(line.Substring(18));if(DesktopFiles.String(value,"token")==token&&DesktopFiles.String(value,"origin")=="http://127.0.0.1:"+port)startup.TrySetResult(DesktopFiles.String(value,"origin"));}catch(Exception error){Log(error.Message);}return;}
          if(line.StartsWith("FRAME_DESKTOP_ACTION ")){try{var value=DesktopFiles.Json.Deserialize<Dictionary<string,object>>(line.Substring(21));if(DesktopFiles.String(value,"token")==token)Ui(()=>{if(launchToken==token)NativeAction(value);});}catch(Exception error){Log(error.Message);}return;}Log(line);
        });server=owned;owned.Process.Exited+=(s,e)=>{startup.TrySetException(new Exception("工作台服务未能继续运行。请重试或查看日志。"));Ui(()=>{if(!exiting&&!closing&&!starting&&server==owned){ready=false;ShowFailure("工作台服务已停止，作品仍保存在数据目录。点击重试启动。 ");}});};if(owned.Process.HasExited)throw new Exception("工作台未能启动，请查看运行日志。");
        if(await Task.WhenAny(startup.Task,Task.Delay(90000))!=startup.Task)throw new Exception("打开工作台超时，请重试或修复运行环境。");origin=await startup.Task;ready=true;status.Text="工作台已就绪";description.Text="在浏览器中创作，在这里管理 Windows 运行环境。";stage.Text="运行中 · "+origin;open.Enabled=restart.Enabled=true;environmentStatus.Text="已安装环境检查通过";environmentDetail.Text="程序更新会继续复用这些依赖。";tray.Text="FRAME Studio · 正在运行";starting=false;await PollStatus();
        if(DesktopNames.Test)DesktopFiles.Write(Path.Combine(data,"desktop-test-ready.json"),new{origin=origin,pid=Process.GetCurrentProcess().Id,server=owned.Process.Id,instance=token});else if(!showCenter){OpenBrowser();Hide();}
        if(!DesktopNames.Test||Environment.GetEnvironmentVariable("FRAME_TEST_UPDATE_URL")!=null)await updates.Check();
      }catch(Exception error){Log(error.ToString());if(server!=null){server.Dispose();server=null;}ShowFailure(error.Message);}finally{starting=false;}
    }
    void ShowFailure(string message){ready=false;status.Text="运行环境需要检查";description.Text=message;stage.Text="你的作品和已有缓存会保留。";retry.Visible=true;open.Enabled=restart.Enabled=false;previous.Visible=PreviousApp()!="";tray.Text="FRAME Studio · 需要恢复";ShowCenter("overview");}
    async void NativeAction(Dictionary<string,object> value){try{var action=DesktopFiles.String(value,"action");if(action=="show-center")ShowCenter(DesktopFiles.String(value,"tab","overview"));else if(action=="login-codex"||action=="login-claude")await OpenLogin(action=="login-codex"?"codex":"claude");}catch(Exception error){Log(error.ToString());ShowCenter("logs");}}
    void UpdatesChanged(){updateBinding=true;automatic.Checked=updates.Automatic;updateBinding=false;updateStatus.Text=updates.Message;updateDetail.Text=updates.State=="downloading"?DesktopTheme.Bytes(updates.Received)+(updates.Total>0?" / "+DesktopTheme.Bytes(updates.Total):""):updates.Error;updateProgress.Visible=updates.State=="downloading";updateProgress.Value=updates.Total>0?(int)Math.Min(100,100*updates.Received/updates.Total):0;checkUpdate.Enabled=updates.State!="checking"&&updates.State!="downloading";downloadUpdate.Visible=updates.Available!=null&&(updates.State=="available"||updates.State=="failed");applyUpdate.Visible=updates.State=="ready";}
    async Task<Dictionary<string,object>> LocalRequest(string route,bool post=false){var request=(HttpWebRequest)WebRequest.Create(origin+route);request.Timeout=5000;request.ReadWriteTimeout=5000;if(post){request.Method="POST";request.ContentLength=0;request.Headers["Origin"]=origin;request.Headers["X-Frame-Desktop"]=launchToken;}using(var response=(HttpWebResponse)await request.GetResponseAsync())using(var reader=new StreamReader(response.GetResponseStream()))return DesktopFiles.Json.Deserialize<Dictionary<string,object>>(await reader.ReadToEndAsync());}
    async Task PollStatus(){if(!ready||statusPolling||exiting)return;statusPolling=true;try{var value=await LocalRequest("/api/desktop/status");taskStatus.Text="后台任务："+value["active"]+" 个";if(value.ContainsKey("pending")&&Convert.ToInt32(value["pending"])>0)taskStatus.Text+="；结果待恢复："+value["pending"]+" 个";var speech=(Dictionary<string,object>)value["speech"];speechStatus.Text=DesktopFiles.String(speech,"message");retrySpeech.Visible=DesktopFiles.String(speech,"state")=="failed";if(DesktopNames.Test)DesktopFiles.Write(Path.Combine(data,"desktop-test-status.json"),value);}catch(Exception error){Log(error.Message);}finally{statusPolling=false;}}
    async Task<bool> CanStop(){if(!ready)return true;try{var value=await LocalRequest("/api/desktop/status");if(Convert.ToInt32(value["active"])>0||Convert.ToInt32(value["unsaved"])>0){ShowCenter("overview");description.Text="请先完成或停止后台任务，并在浏览器保存未保存的编辑，再重启、更新或退出。";return false;}await LocalRequest("/api/desktop/prepare-exit",true);return true;}catch(Exception error){Log(error.Message);if(server==null||server.Process.HasExited)return true;description.Text="暂时无法确认任务状态，请稍后重试。";ShowCenter("overview");return false;}}
    async Task StopServer(){
      ready=false;var stopping=server;if(stopping==null)return;
      try{
        var stopped=stopping.WaitAsync();
        try{stopping.Process.StandardInput.WriteLine("exit");}catch(Exception error){Log(error.Message);}
        if(await Task.WhenAny(stopped,Task.Delay(10000))!=stopped){stopping.Stop();if(await Task.WhenAny(stopped,Task.Delay(5000))!=stopped)Log("Owned service did not finish stopping within the timeout.");}
        if(stopped.IsCompleted)await stopped;
      }catch(Exception error){Log(error.Message);}
      finally{stopping.Dispose();if(server==stopping)server=null;}
    }
    async Task Restart(){if(closing||starting||exiting)return;closing=true;try{if(!await CanStop())return;await StopServer();bool openedByStart=!showCenter;await Start();if(ready&&!openedByStart)OpenBrowser();}finally{closing=false;}}
    async Task RequestExit(bool restartAfter,bool explicitUpdate){
      if(closing||starting||exiting)return;
      bool update=updates.State=="ready"&&(updates.Automatic||explicitUpdate);
      if(explicitUpdate&&!update)return;
      closing=true;
      Exception failure=null;
      try{
        if(!await CanStop())return;
        if(update)Process.Start(new ProcessStartInfo(Path.Combine(root,"FrameSetup.exe"),"--apply-update --silent --root "+DesktopFiles.Quote(installationRoot)+" --wait-pid "+Process.GetCurrentProcess().Id+(restartAfter?" --restart":"")){UseShellExecute=false,CreateNoWindow=true});
        exiting=true;await StopServer();Close();
      }catch(Exception error){
        failure=error;Log(error.ToString());exiting=false;
      }finally{closing=false;}
      if(failure!=null){
        if(ready)try{await LocalRequest("/api/desktop/cancel-exit",true);}catch(Exception releaseError){Log(releaseError.Message);}
        ShowCenter("updates");updateDetail.Text="未能启动更新或退出操作，请查看日志后重试。";
      }
    }
    async Task Repair(){if(starting||closing||exiting)return;if(!await CanStop())return;closing=true;await StopServer();starting=true;repairCancelled=false;OpenPage("environment");repair.Enabled=false;pauseRepair.Visible=true;environmentStatus.Text="正在修复运行环境";environmentProgress.Value=0;
      bool success=false;try{var info=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe"),"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "+DesktopFiles.Quote(Path.Combine(root,"desktop","install.ps1"))+" -SourceRoot "+DesktopFiles.Quote(root)+" -InstallRoot "+DesktopFiles.Quote(root)+" -DataRoot "+DesktopFiles.Quote(data)){WorkingDirectory=root};preparing=new OwnedProcess(info,line=>{Log(line);if(line.StartsWith("FRAME_PROGRESS "))Ui(()=>{var value=DesktopFiles.Json.Deserialize<Dictionary<string,object>>(line.Substring(15));environmentStatus.Text=DesktopFiles.String(value,"message");long received=Convert.ToInt64(value["received"]),total=Convert.ToInt64(value["total"]);environmentDetail.Text=total>0?DesktopTheme.Bytes(received)+" / "+DesktopTheme.Bytes(total):"复用已下载内容，只补齐缺少的部分。";environmentProgress.Value=total>0?(int)Math.Min(100,received*100/total):0;});});var code=await preparing.WaitAsync();if(repairCancelled)throw new OperationCanceledException();if(code!=0)throw new Exception("环境修复未完成，请检查网络后重试；详细原因在安装日志。");success=true;environmentProgress.Value=100;environmentStatus.Text="环境已准备好";}
      catch(Exception error){Log(error.ToString());environmentStatus.Text=repairCancelled?"修复已暂停，已下载内容会保留。":error.Message;retry.Visible=true;}
      finally{if(preparing!=null){preparing.Dispose();preparing=null;}starting=false;closing=false;repair.Enabled=true;pauseRepair.Visible=false;}if(success)await Start();
    }
    async Task OpenLogin(string tool){var request=(HttpWebRequest)WebRequest.Create(origin+"/api/desktop/ai?refresh=1");string json;using(var response=await request.GetResponseAsync())using(var reader=new StreamReader(response.GetResponseStream()))json=await reader.ReadToEndAsync();var states=DesktopFiles.Json.Deserialize<List<Dictionary<string,object>>>(json);var item=states.Find(value=>DesktopFiles.String(value,"tool")==tool);if(item==null||!DesktopFiles.Bool(item,"installed"))return;var binary=DesktopFiles.String(item,"path");var command="& '"+binary.Replace("'","''")+"' "+(tool=="codex"?"login":"auth login");var powershell=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe");Process.Start(new ProcessStartInfo(powershell,"-NoProfile -NoExit -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(command))){UseShellExecute=true});}
    string PreviousApp(){var v=DesktopFiles.String(DesktopFiles.Read(Path.Combine(installationRoot,"installation.json")),"previous");if(!System.Text.RegularExpressions.Regex.IsMatch(v,@"^\d+\.\d+\.\d+$"))return "";var file=Path.Combine(installationRoot,"versions",v,"FrameStudio.exe");return File.Exists(file)?file:"";}
    async Task OpenPrevious(){if(closing||starting||PreviousApp()==""||!await CanStop())return;updates.SetAutomatic(false);Process.Start(new ProcessStartInfo(Path.Combine(root,"FrameSetup.exe"),"--open-previous --silent --root "+DesktopFiles.Quote(installationRoot)+" --wait-pid "+Process.GetCurrentProcess().Id){CreateNoWindow=true,UseShellExecute=false});exiting=true;await StopServer();Close();}
  }
}
