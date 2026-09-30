using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Text;

namespace FrameStudioDesktop {
  static class Program {
    [STAThread]
    static void Main() {
      bool first;
      using (var mutex = new Mutex(true, @"Local\FRAME-Studio-Desktop", out first)) {
        if (!first) {
          Process.Start("http://127.0.0.1:43173/");
          return;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new TrayContext());
      }
    }
  }

  sealed class TrayContext : ApplicationContext {
    readonly NotifyIcon tray;
    readonly Control ui;
    readonly string data;
    readonly string root;
    readonly object logLock = new object();
    Process server;
    Process installer;
    bool ready;
    bool exiting;

    public TrayContext() {
      ui = new Control();
      var handle = ui.Handle;
      root = AppDomain.CurrentDomain.BaseDirectory;
      data = Environment.GetEnvironmentVariable("FRAME_LOCAL_DATA") ??
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FRAME Studio");
      Directory.CreateDirectory(data);
      var menu = new ContextMenuStrip();
      menu.Items.Add("打开工作台", null, (sender, args) => OpenBrowser());
      menu.Items.Add("退出", null, (sender, args) => Exit());
      tray = new NotifyIcon {
        Icon = SystemIcons.Application,
        Text = "FRAME Studio · 正在启动",
        ContextMenuStrip = menu,
        Visible = true,
      };
      tray.MouseUp += (sender, args) => {
        if (args.Button == MouseButtons.Left) OpenBrowser();
      };
      Task.Run((Action)StartServer);
    }

    void WriteLog(string line) {
      if (String.IsNullOrEmpty(line)) return;
      lock (logLock) {
        File.AppendAllText(Path.Combine(data, "desktop.log"),
          DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line + Environment.NewLine);
      }
    }

    void StartServer() {
      try {
        var selection = Path.Combine(data, "runtime-selection.json");
        var setup = Path.Combine(root, "desktop", "bootstrap.ps1");
        if (!File.Exists(setup)) throw new Exception("安装包缺少运行环境安装器，请重新下载并完整解压。");
        var setupInfo = new ProcessStartInfo(
          Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
          "-NoProfile -ExecutionPolicy Bypass -File \"" + setup + "\" -AppRoot \"" + root.TrimEnd('\\') +
          "\" -DataRoot \"" + data.TrimEnd('\\') + "\" -Selection \"" + selection + "\"") {
          UseShellExecute = false, CreateNoWindow = true,
          RedirectStandardOutput = true, RedirectStandardError = true,
          StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
        };
        installer = new Process { StartInfo = setupInfo };
        installer.OutputDataReceived += (sender, args) => { WriteLog(args.Data); Status(args.Data); };
        installer.ErrorDataReceived += (sender, args) => WriteLog(args.Data);
        if (!installer.Start()) throw new Exception("无法启动运行环境安装器。");
        installer.BeginOutputReadLine();
        installer.BeginErrorReadLine();
        installer.WaitForExit();
        if (exiting) return;
        if (installer.ExitCode != 0) throw new Exception("运行环境安装失败，请查看 desktop.log；重新启动会重试下载。");
        var runtime = new JavaScriptSerializer().Deserialize<Dictionary<string,string>>(File.ReadAllText(selection));
        var tools = runtime["tools"];
        var node = Path.Combine(tools, "node.exe");
        var entry = Path.Combine(root, "server", "local-app.mjs");
        if (!File.Exists(node) || !File.Exists(entry) || !File.Exists(Path.Combine(root, "studio-dist", "index.html")))
          throw new Exception("安装包缺少本地运行文件，请重新下载完整的 Windows 压缩包并解压。");
        var info = new ProcessStartInfo(node, "\"" + entry + "\"") {
          WorkingDirectory = root,
          UseShellExecute = false,
          CreateNoWindow = true,
          RedirectStandardInput = true,
          RedirectStandardOutput = true,
          RedirectStandardError = true,
        };
        info.EnvironmentVariables["PATH"] = String.Join(";", new[] {
          tools,
          Path.Combine(tools, "tools", "pnpm"),
          Path.Combine(tools, "git", "cmd"),
          Path.Combine(tools, "git", "mingw64", "bin"),
          Path.Combine(tools, "git", "usr", "bin"),
          Path.Combine(tools, "ffmpeg", "bin"),
          info.EnvironmentVariables["PATH"],
        });
        info.EnvironmentVariables["FRAME_LOCAL_MODE"] = "1";
        info.EnvironmentVariables["FRAME_LOCAL_DATA"] = data;
        info.EnvironmentVariables["FRAME_SPEECH_PYTHON"] = Path.Combine(runtime["speech"], "python", "python.exe");
        info.EnvironmentVariables["PORT"] = "43173";
        var edge = @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
        if (File.Exists(edge)) info.EnvironmentVariables["FRAME_BROWSER"] = edge;
        server = new Process { StartInfo = info, EnableRaisingEvents = true };
        server.OutputDataReceived += (sender, args) => WriteLog(args.Data);
        server.ErrorDataReceived += (sender, args) => WriteLog(args.Data);
        server.Exited += (sender, args) => {
          if (!exiting) Show("本地服务已停止，请查看 desktop.log", ToolTipIcon.Warning);
          ready = false;
        };
        if (!server.Start()) throw new Exception("无法启动本地服务。");
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();
        var deadline = DateTime.UtcNow.AddSeconds(120);
        while (DateTime.UtcNow < deadline && !exiting && !server.HasExited) {
          try {
            var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:43173/healthz");
            request.Timeout = 1000;
            using (var response = (HttpWebResponse)request.GetResponse()) {
              if (response.StatusCode == HttpStatusCode.OK) {
                ready = true;
                Show("工作台已就绪，左键单击托盘图标打开浏览器", ToolTipIcon.Info);
                return;
              }
            }
          } catch { Thread.Sleep(500); }
        }
        if (!exiting) Show("本地服务启动失败，请查看 desktop.log", ToolTipIcon.Error);
      } catch (Exception error) {
        WriteLog(error.ToString());
        Show(error.Message, ToolTipIcon.Error);
      }
    }

    void Status(string message) {
      if (String.IsNullOrEmpty(message) || exiting) return;
      try {
        if (ui.InvokeRequired) ui.BeginInvoke((Action)(() => Status(message)));
        else tray.Text = message.Length > 60 ? message.Substring(0, 60) : message;
      } catch { }
    }

    void Show(string message, ToolTipIcon kind) {
      if (exiting) return;
      var text = message.Length > 60 ? message.Substring(0, 60) : message;
      try {
        if (ui.InvokeRequired)
          ui.BeginInvoke((Action)(() => Show(text, kind)));
        else {
          tray.Text = "FRAME Studio";
          tray.ShowBalloonTip(5000, "FRAME Studio", text, kind);
        }
      } catch { /* The tray was closed while startup completed. */ }
    }

    void OpenBrowser() {
      if (!ready) {
        Show("本地服务尚未就绪，请稍后再试", ToolTipIcon.Info);
        return;
      }
      try { Process.Start("http://127.0.0.1:43173/"); }
      catch (Exception error) { Show(error.Message, ToolTipIcon.Error); }
    }

    async void Exit() {
      if (exiting) return;
      exiting = true;
      tray.Visible = false;
      await Task.Run(() => {
        try {
          if (installer != null && !installer.HasExited) {
            var stop = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe"),
              "/PID " + installer.Id + " /T /F") { UseShellExecute = false, CreateNoWindow = true };
            using (var killer = Process.Start(stop)) { if (killer != null) killer.WaitForExit(10000); }
          }
          if (server != null && !server.HasExited) {
            server.StandardInput.WriteLine("exit");
            server.StandardInput.Flush();
            if (!server.WaitForExit(15000)) server.Kill();
          }
        } catch (Exception error) { WriteLog(error.ToString()); }
      });
      tray.Dispose();
      ui.Dispose();
      ExitThread();
    }
  }
}
