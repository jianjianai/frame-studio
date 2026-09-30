using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

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
        var node = Path.Combine(root, "node.exe");
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
          root,
          Path.Combine(root, "tools", "pnpm"),
          Path.Combine(root, "git", "cmd"),
          Path.Combine(root, "git", "mingw64", "bin"),
          Path.Combine(root, "git", "usr", "bin"),
          Path.Combine(root, "ffmpeg", "bin"),
          info.EnvironmentVariables["PATH"],
        });
        info.EnvironmentVariables["FRAME_LOCAL_MODE"] = "1";
        info.EnvironmentVariables["FRAME_LOCAL_DATA"] = data;
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
