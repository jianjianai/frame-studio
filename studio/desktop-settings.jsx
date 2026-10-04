import { useState } from "react";
import { Monitor } from "lucide-react";
import { request, Button, ErrorNote } from "./ui";
import "./desktop.css";

export function openWindowsCenter(tab = "overview") {
  return request("/api/desktop/native", {
    method: "POST",
    body: JSON.stringify({ action: "show-center", tab }),
  });
}

export function WindowsCenterLink() {
  const [error, setError] = useState("");
  const open = async (tab) => {
    try {
      await openWindowsCenter(tab);
      setError("");
    } catch (error) {
      setError(error.message);
    }
  };
  return (
    <section className="desktop-settings">
      <header className="desktop-section-heading">
        <Monitor size={24} />
        <div>
          <h2>Windows 控制中心</h2>
          <p>通过独立的 Windows 窗口管理本机运行环境。</p>
        </div>
      </header>
      <section className="desktop-card">
        <h3>打开本机管理窗口</h3>
        <p>
          检查更新、下载与修复依赖、重启工作台和查看日志。也可以右键点击任务栏托盘里的
          FRAME 图标打开。
        </p>
        <div className="desktop-secondary-actions">
          <Button className="primary" onClick={() => open("overview")}>
            打开 Windows 控制中心
          </Button>
          <Button onClick={() => open("updates")}>打开应用更新</Button>
          <Button onClick={() => open("environment")}>打开运行环境</Button>
        </div>
        <ErrorNote error={error} />
      </section>
    </section>
  );
}
