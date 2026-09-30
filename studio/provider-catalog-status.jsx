import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  LogIn,
  RefreshCw,
} from "lucide-react";
import { Button, date } from "./ui";

export function CodexCatalogStatus({
  provider,
  syncing,
  error,
  onSync,
  onLogin,
  localMode,
}) {
  const catalog = provider.modelCatalog;
  const failure = error || catalog?.error;
  const connected = provider.configured && provider.state === "ready";
  const loading = connected && syncing;
  const Icon = loading
    ? LoaderCircle
    : failure
      ? AlertCircle
      : connected && catalog?.fetchedAt
        ? CheckCircle2
        : LogIn;
  const count = provider.models?.length || 0;
  const title = loading
    ? "正在同步模型与参数"
    : !connected
      ? "连接 OpenAI 账号后自动获取模型"
      : failure
        ? "模型同步未完成"
        : catalog?.fetchedAt
          ? `模型目录已更新 · ${count} 个模型`
          : "准备获取账号模型";
  const detail = loading
    ? "正在读取 Codex 工具目录；已有模型和手动配置会保留。"
    : !connected
      ? localMode
        ? "先在终端运行 codex login，再点击“检查登录”。"
        : "在官方页面完成授权，返回后模型会自动出现在这里。"
      : failure
        ? failure
        : catalog?.fetchedAt
          ? `更新于 ${date(catalog.fetchedAt)} · 登录后自动同步，可随时刷新`
          : "无需逐个填写模型 ID 或参数。";
  return (
    <section
      className={`codex-catalog-status ${loading ? "syncing" : failure ? "failed" : "ready"}`}
      aria-label="Codex 模型同步状态"
      aria-busy={loading}
    >
      <div
        className="codex-catalog-status-main"
        role="status"
        aria-live="polite"
      >
        <Icon size={18} className={loading ? "catalog-spin" : ""} />
        <div>
          <strong>{title}</strong>
          <p>{detail}</p>
        </div>
        {connected && failure && (
          <Button icon={RefreshCw} disabled={syncing} onClick={onSync}>
            重试同步
          </Button>
        )}
        {!connected && !localMode && onLogin && (
          <Button className="primary" icon={LogIn} onClick={onLogin}>
            登录账号
          </Button>
        )}
      </div>
      {connected && catalog?.fetchedAt && !loading && (
        <div className="codex-catalog-status-footer">
          {catalog.defaultModel && (
            <span>
              工具推荐 <code>{catalog.defaultModel}</code>
            </span>
          )}
          <details>
            <summary>
              来源与说明{catalog.warnings?.length ? " · 有待补充规格" : ""}
            </summary>
            <p>
              模型及推理档位来自 Codex
              工具目录，未提供的规格可由公共参考补齐。目录可能缓存，实际账号可用性在创作时确认。
            </p>
            {catalog.warnings?.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </details>
        </div>
      )}
    </section>
  );
}
