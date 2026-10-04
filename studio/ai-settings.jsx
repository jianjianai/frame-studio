import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Terminal } from "lucide-react";
import { request, Button, ErrorNote, Loading } from "./ui";
import { nativeAiUrl } from "./ai-session.mjs";
import "./ai-settings.css";

export function AiSettings() {
  const [session, setSession] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    request("/api/ai/session", { signal: controller.signal })
      .then((value) => {
        const settingsUrl = nativeAiUrl(value.nativeSettingsUrl, location.href);
        const workbenchUrl = nativeAiUrl(
          value.standaloneUrl || value.uiUrl,
          location.href,
        );
        settingsUrl.searchParams.set("frameStandalone", "1");
        workbenchUrl.searchParams.set("frameStandalone", "1");
        if (!controller.signal.aborted)
          setSession({
            ...value,
            settingsUrl: settingsUrl.href,
            workbenchUrl: workbenchUrl.href,
          });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [retry]);
  return (
    <section className="ai-settings" aria-label="AI 助手设置">
      <div className="settings-section-heading">
        <Terminal size={24} aria-hidden="true" />
        <div>
          <h2>T3 Code</h2>
          <p>所有作品共用一个 AI 工作台，作品侧栏只显示当前作品的对话。</p>
        </div>
      </div>
      <div className="ai-settings-card">
        <h3>提供商与模型</h3>
        <p>
          在 T3 Code 管理 Codex、Claude Code
          的账号、模型和默认设置，沿用官方 CLI 的登录与配置。
        </p>
        {loading && !session && <Loading />}
        <ErrorNote error={error} />
        {session && (
          <div className="ai-settings-actions">
            <a
              className="button primary"
              href={session.settingsUrl}
              target="_blank"
              rel="noopener"
            >
              <ExternalLink size={16} aria-hidden="true" />
              打开提供商与模型
            </a>
            <a
              className="button"
              href={session.workbenchUrl}
              target="_blank"
              rel="noopener"
            >
              打开完整工作台
            </a>
          </div>
        )}
        {error && (
          <Button
            icon={RefreshCw}
            disabled={loading}
            onClick={() => setRetry((value) => value + 1)}
          >
            重新连接
          </Button>
        )}
        {session?.runtime?.version && (
          <small>当前版本：{session.runtime.version}</small>
        )}
      </div>
    </section>
  );
}
