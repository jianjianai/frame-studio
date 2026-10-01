import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Player } from "./ui/Player";
import {
  createLivePreviewClient,
  type LivePreviewManifest,
  type LivePreviewStatus,
} from "./engine/live-preview-client";
import type { AnimationProject } from "./engine/types";
import {
  validPreviewMode,
  type PreviewCacheState,
  type PreviewMediaMode,
} from "./engine/live-preview-cache";
import { installPreviewControls } from "./engine/live-preview-controls";
import { installAiBrowser } from "./engine/ai-browser";
import "./styles.css";
import "./preview-cache.css";
import "./work-preview.css";
import "./ui/player-workspace.css";

class LiveBoundary extends Component<
  { children: ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <p role="alert">{this.state.error}</p>
    ) : (
      this.props.children
    );
  }
}
type Candidate = {
  project: AnimationProject;
  manifest: LivePreviewManifest;
  signal: AbortSignal;
};
function LivePreview() {
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [status, setStatus] = useState<LivePreviewStatus | null>(null);
  const [acceptedTitle, setAcceptedTitle] = useState("");
  const [cache, setCache] = useState<PreviewCacheState | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [controlError, setControlError] = useState("");
  const [visibleFiles, setVisibleFiles] = useState(60);
  const [mediaMode, setMediaMode] = useState<PreviewMediaMode>(() => {
    const mode =
      new URLSearchParams(location.search).get("mediaMode") ||
      window.__FRAME_LIVE_PREVIEW__?.mediaMode;
    return validPreviewMode(mode) ? mode : "compressed";
  });
  const pending = useRef(
    new Map<
      number,
      {
        project: AnimationProject;
        resolve: () => void;
        reject: (error: Error) => void;
      }
    >(),
  );
  const ai = useRef<ReturnType<typeof installAiBrowser> | null>(null);
  const client = useRef<ReturnType<typeof createLivePreviewClient> | null>(
    null,
  );
  const aiMode = new URLSearchParams(location.search).get("ai") === "1";
  useEffect(() => {
    const config = window.__FRAME_LIVE_PREVIEW__;
    if (!config) {
      setStatus({
        state: "error",
        sessionId: "",
        error: "Missing live preview connection",
      });
      return;
    }
    const connection = createLivePreviewClient(config, {
      onProject: (project, manifest, signal, onCommit) =>
        new Promise<void>((resolve, reject) => {
          const abort = () => {
            pending.current.delete(manifest.revision);
            reject(new Error("Superseded live revision"));
          };
          signal.addEventListener("abort", abort, { once: true });
          pending.current.set(manifest.revision, {
            project,
            resolve: () => {
              signal.removeEventListener("abort", abort);
              onCommit();
              resolve();
            },
            reject: (error) => {
              signal.removeEventListener("abort", abort);
              reject(error);
            },
          });
          setCandidate({ project, manifest, signal });
        }),
      onCache: (value) => setCache(value),
      onStatus: (value) => {
        setStatus(value);
        if (value.mediaMode) setMediaMode(value.mediaMode);
        if (parent !== window) {
          const { sessionId: _session, ...message } = value;
          parent.postMessage({ type: "frame-live-preview", ...message }, "*");
        }
      },
    });
    client.current = connection;
    installPreviewControls(connection);
    const readers = () =>
      setExportBusy((window.__FRAME_PREVIEW_READERS__ ?? 0) > 0);
    window.addEventListener("frame-preview-readers", readers);
    const retry = (event: MessageEvent) => {
      if (event.source !== parent) return;
      if (event.data?.type === "frame-live-retry") void connection.retry();
      if (
        event.data?.type === "frame-preview-media-mode" &&
        validPreviewMode(event.data.mode)
      )
        connection.setMode(event.data.mode);
    };
    window.addEventListener("message", retry);
    return () => {
      window.removeEventListener("message", retry);
      window.removeEventListener("frame-preview-readers", readers);
      connection.dispose();
      client.current = null;
    };
  }, []);
  useEffect(() => {
    if (parent === window) return;
    const observer = new ResizeObserver(() =>
      parent.postMessage(
        {
          type: "frame-preview-height",
          height: Math.ceil(document.body.getBoundingClientRect().height),
        },
        "*",
      ),
    );
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);
  const applied = (result: {
    revision: number;
    success: boolean;
    error?: string;
  }) => {
    const waiting = pending.current.get(result.revision);
    if (!waiting) return;
    pending.current.delete(result.revision);
    if (result.success) {
      setAcceptedTitle(waiting.project.title);
      if (aiMode) {
        if (ai.current) ai.current.updateProject(waiting.project);
        else ai.current = installAiBrowser(waiting.project);
      }
      waiting.resolve();
    } else
      waiting.reject(
        new Error(result.error || "Live scene initialization failed"),
      );
  };
  const bytes = (value: number) =>
    value >= 1024 * 1024
      ? (value / (1024 * 1024)).toFixed(1) + " MB"
      : (value / 1024).toFixed(1) + " KB";
  const changeMode = (mode: PreviewMediaMode) => {
    try {
      client.current?.setMode(mode);
      setMediaMode(mode);
      setControlError("");
    } catch (error) {
      setControlError(String(error));
      return;
    }
    if (parent !== window)
      parent.postMessage({ type: "frame-preview-media-mode", mode }, "*");
  };
  const previewDiagnostic = String(status?.error || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b/g, "");
  return (
    <>
      <section className="preview-media-controls" aria-label="预览素材模式">
        <label>
          素材模式{" "}
          <select
            value={mediaMode}
            disabled={exportBusy}
            title={exportBusy ? "导出完成后可切换素材模式" : undefined}
            onChange={(event) =>
              changeMode(event.target.value as PreviewMediaMode)
            }
          >
            <option value="original">原始素材 · 浏览器处理</option>
            <option value="compressed">压缩素材 · 节省流量</option>
            <option value="cached">完整缓存 · 原始素材</option>
          </select>
        </label>
        <span>
          {mediaMode === "original"
            ? "原始素材直接交给浏览器解码和处理"
            : mediaMode === "compressed"
              ? "按需使用服务器预览副本"
              : "先缓存本版本全部素材和运行依赖；保存更新后自动补齐变化"}
        </span>
        {controlError && <p role="alert">{controlError}</p>}
        {mediaMode === "cached" && cache && (
          <div className="preview-cache-panel" aria-live="polite">
            <div className="preview-cache-summary">
              <strong>
                {
                  {
                    idle: "等待缓存",
                    downloading: "正在缓存",
                    preparing: "素材已缓存，正在准备播放",
                    ready: "缓存与画面已就绪",
                    cancelled: "缓存已取消",
                    error: "缓存未完成",
                  }[cache.state]
                }
              </strong>
              <span>
                {cache.completeFiles} / {cache.totalFiles} 个文件 ·{" "}
                {bytes(cache.downloadedBytes)} / {bytes(cache.totalBytes)}
              </span>
              <div className="preview-cache-actions">
                {(cache.state === "downloading" ||
                  cache.state === "preparing") && (
                  <button onClick={() => client.current?.cancelCache()}>
                    取消缓存
                  </button>
                )}
                {(cache.state === "error" || cache.state === "cancelled") && (
                  <button onClick={() => void client.current?.retry()}>
                    继续缓存
                  </button>
                )}
                <button
                  onClick={() =>
                    void client.current
                      ?.clearCache()
                      .catch((error) =>
                        setCache((value) =>
                          value ? { ...value, warning: String(error) } : value,
                        ),
                      )
                  }
                >
                  清理本作品缓存
                </button>
              </div>
            </div>
            <progress
              aria-label="完整素材缓存进度"
              value={cache.downloadedBytes}
              max={cache.totalBytes || 1}
            />
            {cache.state === "ready" && (
              <small>
                本版本播放从浏览器缓存读取；解码和声音生成仍由浏览器执行。已持久保存{" "}
                {cache.persistentFiles} 个文件。
              </small>
            )}
            {cache.storage?.quota !== undefined && (
              <small>
                浏览器剩余存储约{" "}
                {bytes(
                  Math.max(0, cache.storage.quota - (cache.storage.usage ?? 0)),
                )}
              </small>
            )}
            {cache.warning && (
              <p className="preview-cache-warning">{cache.warning}</p>
            )}
            {cache.error && <p role="alert">{cache.error}</p>}
            {!!cache.remaining.length && (
              <details open={cache.state === "error"}>
                <summary>还需缓存 {cache.remaining.length} 个文件</summary>
                <ul className="preview-cache-files">
                  {cache.remaining.slice(0, visibleFiles).map((file) => (
                    <li key={file.path}>
                      <span title={file.path}>{file.path}</span>
                      <small>
                        {file.state === "downloading"
                          ? "下载中 "
                          : file.state === "error"
                            ? "失败 "
                            : "等待 "}
                        {bytes(file.downloadedBytes)} / {bytes(file.bytes)}
                      </small>
                      {file.error && <em>{file.error}</em>}
                    </li>
                  ))}
                </ul>
                {cache.remaining.length > visibleFiles && (
                  <button
                    onClick={() => setVisibleFiles((value) => value + 100)}
                  >
                    显示更多文件（还有 {cache.remaining.length - visibleFiles}{" "}
                    个）
                  </button>
                )}
              </details>
            )}
          </div>
        )}
      </section>
      {aiMode && (
        <section className="ai-browser-header">
          <div>
            <h1>{acceptedTitle || "实时预览"} · AI 审片</h1>
            <p>
              画面与声音在浏览器持续运行。控制台入口：
              <code>await FRAME_AI.ready()</code>
            </p>
          </div>
          <button onClick={() => void window.FRAME_AI?.play()}>
            启用声音并播放
          </button>
        </section>
      )}
      {status?.error && (
        <div className="live-preview-notice" role="alert">
          <details className="preview-error-details">
            <summary>实时预览更新失败 · 查看错误</summary>
            <pre>{previewDiagnostic}</pre>
          </details>
          <button onClick={() => void client.current?.retry()}>重试连接</button>
        </div>
      )}
      {candidate ? (
        <Player
          project={candidate.project}
          embedded
          liveUpdate={{
            revision: candidate.manifest.revision,
            changes: candidate.manifest.changes,
            signal: candidate.signal,
          }}
          onLiveUpdate={applied}
        />
      ) : (
        <p role="status">正在连接实时预览…</p>
      )}
    </>
  );
}
document.body.classList.add("work-preview");
document.documentElement.dataset.previewAudio = "0";
createRoot(document.getElementById("root")!).render(
  <LiveBoundary>
    <LivePreview />
  </LiveBoundary>,
);
