using System;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
namespace FrameStudioDesktop {
  static class ControlCenterTest {
    public static async Task Run(Form form,string[] args,Action<string> navigate,Func<Task> exit,Func<Task> restart,Action browser,Action fault){
      if(!DesktopNames.Test)return;var i=Array.IndexOf(args,"--test-output");if(i<0||i+1>=args.Length)return;var output=args[i+1];Directory.CreateDirectory(output);
      try{
        foreach(var page in new[]{"overview","environment","updates","logs"}){navigate(page);await Task.Delay(500);using(var image=new Bitmap(form.Width,form.Height)){form.DrawToBitmap(image,new Rectangle(Point.Empty,form.Size));image.Save(Path.Combine(output,"control-center-"+page+".png"),System.Drawing.Imaging.ImageFormat.Png);}}
        var automatic=(CheckBox)form.Controls.Find("automaticUpdates",true)[0];var enabled=automatic.Checked;automatic.Checked=!enabled;automatic.Checked=enabled;
        navigate("overview");DesktopFiles.Write(Path.Combine(output,"control-center-result.json"),new{state="ready",automatic=automatic.Checked});
        string last="";
        for(int attempt=0;attempt<720;attempt++){
          var command=DesktopFiles.Read(Path.Combine(output,"native-command.json"));var id=DesktopFiles.String(command,"id");
          if(id!=""&&id!=last){last=id;var action=DesktopFiles.String(command,"action");if(action=="exit")await exit();else if(action=="restart")await restart();else if(action=="browser")browser();else if(action=="fault-service"){fault();await Task.Delay(300);}else if(action=="fault-restart"){fault();await restart();}else if(action=="hide"){form.Close();}else if(action=="show"){form.Show();}else throw new Exception("Unknown acceptance command");DesktopFiles.Write(Path.Combine(output,"native-result.json"),new{id=id,disposed=form.IsDisposed,visible=form.Visible});}
          if(File.Exists(Path.Combine(output,"browser-done.json"))){await exit();if(!form.IsDisposed)throw new Exception("Idle exit was blocked");DesktopFiles.Write(Path.Combine(output,"control-center-result.json"),new{state="done"});return;}await Task.Delay(500);
        }
        throw new Exception("Browser acceptance did not complete");
      }catch(Exception error){DesktopFiles.Write(Path.Combine(output,"control-center-result.json"),new{state="failed",error=error.ToString()});form.Dispose();Application.Exit();}
    }
  }
}
