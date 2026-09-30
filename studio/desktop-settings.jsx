import { useState } from "react";
import { Monitor, RefreshCw, Terminal, ExternalLink, ArrowUpRight } from "lucide-react";
import { request, useQuery, Button, ErrorNote, Loading } from "./ui";
import { ProviderSettings } from "./model-settings";
import "./desktop.css";

export function openWindowsCenter(tab = "overview") {
  return request("/api/desktop/native", { method: "POST", body: JSON.stringify({ action: "show-center", tab }) });
}

export function WindowsCenterLink() {
  const [error, setError] = useState("");
  const open = async tab => { try { await openWindowsCenter(tab); setError(""); } catch (error) { setError(error.message); } };
  return <section className="desktop-settings">
    <header className="desktop-section-heading"><Monitor size={24} /><div><h2>Windows 控制中心</h2><p>通过独立的 Windows 窗口管理本机运行环境。</p></div></header>
    <section className="desktop-card"><h3>打开本机管理窗口</h3><p>检查更新、下载与修复依赖、重启工作台和查看日志。也可以右键点击任务栏托盘里的 FRAME 图标打开。</p><div className="desktop-secondary-actions"><Button className="primary" onClick={() => open("overview")}>打开 Windows 控制中心</Button><Button onClick={() => open("updates")}>打开应用更新</Button><Button onClick={() => open("environment")}>打开运行环境</Button></div><ErrorNote error={error} /></section>
  </section>;
}

export function LocalAiSettings({ notify }) {
  const query = useQuery("connections_list"), [advanced, setAdvanced] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const refresh = async () => { setBusy(true); setError(""); try { await request("/api/desktop/ai?refresh=1"); query.refresh(); } catch (error) { setError(error.message); } finally { setBusy(false); } };
  return <section className="desktop-settings">
    <header className="desktop-section-heading"><Terminal size={24} /><div><h2>本机 AI 助手</h2><p>使用你电脑上的 Codex 与 Claude CLI，以及它们已有的登录配置。</p></div><Button icon={RefreshCw} disabled={busy || query.loading} onClick={refresh}>{busy ? "检测中…" : "重新检测"}</Button></header>
    <ErrorNote error={error || query.error} />{query.loading && !query.data ? <Loading /> : <div className="desktop-ai-grid">{["codex", "claude"].map(tool => {
      const connection = query.data?.find(item => item.tool === tool), status = connection?.localRuntime, name = tool === "codex" ? "Codex" : "Claude Code";
      return <article className="desktop-card desktop-ai-card" key={tool}>
        <div className="desktop-card-heading"><h3>{name}</h3><span className={"desktop-chip " + (status?.ready ? "ready" : "")}>{status?.ready ? "可用" : status?.installed ? "等待登录" : "不可用"}</span></div>
        <p>{status?.message || "正在检测本机安装…"}</p><div className="desktop-cli-detail"><span>已安装版本</span><strong>{status?.version || "尚未安装"}</strong></div>
        {status?.path && <details><summary>安装位置</summary><code>{status.path}</code></details>}
        <div className="desktop-ai-actions">{status?.installed ? <Button className={status.ready ? "" : "primary"} icon={Terminal} onClick={async () => { try { await request("/api/desktop/native", { method: "POST", body: JSON.stringify({ action: "login-" + tool }) }); } catch (error) { setError(error.message); } }}>{status.ready ? "重新登录" : "打开登录终端"}</Button> : <a className="button" href={tool === "codex" ? "https://developers.openai.com/codex/cli/" : "https://code.claude.com/docs/en/setup"} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />安装指南</a>}</div>
        {status?.installed && !status.ready && <small>完成登录后，点击「重新检测」。也可以在终端运行 <code>{tool === "codex" ? "codex login" : "claude auth login"}</code>。</small>}
      </article>;
    })}</div>}
    <section className="desktop-card"><h3>选择创作模型</h3><p>登录成功后即可在作品中选择助手。模型目录与默认模型可按你的 CLI 账号调整。</p><Button onClick={() => setAdvanced(!advanced)}>{advanced ? "收起模型设置" : "管理模型与默认选择"}</Button></section>
    {advanced && <ProviderSettings notify={notify} localMode />}
  </section>;
}

export function LocalWelcome() {
  return <aside className="desktop-welcome"><div className="desktop-welcome-art" aria-hidden="true"><div /><div /><div /></div><div><span className="desktop-eyebrow">FRAME / WINDOWS</span><h2>从一个想法开始</h2><p>给作品起个名字，就可以开始创作。作品会自动保存到「我的作品」。</p><div className="desktop-welcome-links"><a href="#/settings/ai">连接本机 AI <ArrowUpRight size={14} /></a><a href="#/settings/speech">选择配音与模型 <ArrowUpRight size={14} /></a></div></div></aside>;
}
