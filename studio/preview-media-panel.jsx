import { useEffect, useId, useRef, useState } from "react";
import { previewCachePresentation } from "../src/engine/live-preview-cache";
import "./preview-media-panel.css";

const modes = [
  {
    id: "original",
    title: "原始素材",
    tag: "查看原始细节",
    description: "按需加载原始文件，由浏览器解码和播放。",
  },
  {
    id: "compressed",
    title: "压缩素材",
    tag: "节省流量",
    description: "按需使用服务器预览副本，适合日常预览。",
  },
  {
    id: "cached",
    title: "完整缓存",
    tag: "减少重复下载",
    description: "先缓存本版本原始素材与运行依赖，再准备播放。",
  },
];

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const pendingLabels = {
  mode: "正在切换素材模式…",
  cancel: "正在取消缓存…",
  retry: "正在重新准备…",
  clear: "正在清理本作品缓存…",
};

/** The player owns cache state; this panel only issues explicit user commands. */
export function PreviewMediaPanel({ state, disabled = false, onCommand }) {
  const id = useId();
  const [confirmClear, setConfirmClear] = useState(false);
  const [visibleFiles, setVisibleFiles] = useState(30);
  const [filesOpen, setFilesOpen] = useState(false);
  const clearButton = useRef(null);
  const confirmButton = useRef(null);
  const modeFocus = useRef(null);
  const connected = !!state;
  const mode = state?.mode;
  const cache = state?.cache;
  const pending = state?.pendingAction;
  const locked = disabled || state?.exportBusy;
  const unavailable = !connected || !!locked || !!pending;
  const presentation = cache ? previewCachePresentation(cache) : null;
  const busy = cache?.state === "downloading" || cache?.state === "preparing";
  const retryable = cache?.state === "cancelled" || cache?.state === "error";
  const remaining = cache?.remaining || [];
  const downloaded = Math.max(0, cache?.downloadedBytes || 0);
  const total = Math.max(0, cache?.totalBytes || 0);
  const percent =
    total > 0
      ? Math.min(100, Math.round((downloaded / total) * 100))
      : presentation?.resourcesComplete
        ? 100
        : 0;
  const statusText = !connected
    ? "正在连接预览，连接后可选择素材模式。"
    : locked
      ? "正在导出，完成后可切换模式和管理缓存。"
      : pending
        ? pendingLabels[pending] || "正在处理素材操作…"
        : "";

  useEffect(() => {
    setConfirmClear(false);
    setVisibleFiles(30);
    setFilesOpen(false);
  }, [connected, mode, cache?.revision]);

  useEffect(() => {
    if (unavailable) setConfirmClear(false);
  }, [unavailable]);

  useEffect(() => {
    if (cache?.state === "error") setFilesOpen(true);
  }, [cache?.state]);

  useEffect(() => {
    if (confirmClear) confirmButton.current?.focus();
  }, [confirmClear]);

  useEffect(() => {
    if (unavailable || !modeFocus.current) return;
    const radio = modeFocus.current;
    modeFocus.current = null;
    // Temporarily disabling the pending command can blur a keyboard-selected radio.
    // Restore only that lost focus, never a user's newer focus elsewhere.
    if (radio.isConnected && document.activeElement === document.body)
      radio.focus({ preventScroll: true });
  }, [unavailable, mode]);

  const command = (action, nextMode) => {
    if (unavailable) return;
    setConfirmClear(false);
    onCommand(action, nextMode);
  };
  const dismissClear = () => {
    setConfirmClear(false);
    requestAnimationFrame(() => clearButton.current?.focus());
  };

  return (
    <section className="preview-media-panel" aria-label="预览素材设置">
      <div className="pmp-intro">
        <p>选择预览时的素材读取方式。</p>
        <span>仅影响预览，导出使用原始素材。</span>
      </div>

      <fieldset
        className="pmp-modes"
        disabled={unavailable}
        aria-describedby={statusText ? `${id}-status` : undefined}
      >
        <legend>素材模式</legend>
        {modes.map((item) => (
          <label
            key={item.id}
            className={`pmp-mode ${mode === item.id ? "is-selected" : ""}`}
          >
            <input
              type="radio"
              aria-label={item.title}
              name={`${id}-mode`}
              value={item.id}
              checked={mode === item.id}
              aria-describedby={`${id}-${item.id}-description`}
              onChange={(event) => {
                modeFocus.current = event.currentTarget;
                command("mode", item.id);
              }}
            />
            <span className="pmp-mode-content">
              <span className="pmp-mode-heading">
                <strong>{item.title}</strong>
                {mode === item.id && (
                  <span className="pmp-selected" aria-hidden="true">
                    当前
                  </span>
                )}
              </span>
              <span className="pmp-mode-tag">{item.tag}</span>
              <span
                className="pmp-mode-description"
                id={`${id}-${item.id}-description`}
              >
                {item.description}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <div
        className="pmp-status-message"
        id={`${id}-status`}
        role="status"
        hidden={!statusText}
      >
        {statusText}
      </div>
      {state?.controlError && (
        <p className="pmp-message is-error" role="alert">
          {state.controlError}
        </p>
      )}

      {mode === "cached" && (
        <section className="pmp-cache" aria-labelledby={`${id}-cache-title`}>
          <div className="pmp-section-heading">
            <h3 id={`${id}-cache-title`}>本版本缓存</h3>
            {cache?.revision != null && <span>版本 {cache.revision}</span>}
          </div>
          <div
            className={`pmp-cache-state is-${cache?.state || "idle"}`}
            role="status"
          >
            <span className="pmp-state-dot" aria-hidden="true" />
            <strong>{presentation?.title || "正在读取缓存状态"}</strong>
          </div>

          {cache && (
            <>
              <div className="pmp-progress-heading">
                <span>文件下载</span>
                <strong>{percent}%</strong>
              </div>
              <progress
                className="pmp-progress"
                aria-label="完整素材缓存下载进度"
                value={Math.min(downloaded, total || 1)}
                max={total || 1}
                aria-valuetext={`${cache.completeFiles} / ${cache.totalFiles} 个文件，${formatBytes(downloaded)} / ${formatBytes(total)}`}
              />
              <div className="pmp-progress-detail">
                <span>
                  {cache.completeFiles} / {cache.totalFiles} 个文件
                </span>
                <span>
                  {formatBytes(downloaded)} / {formatBytes(total)}
                </span>
              </div>

              <p className="pmp-cache-explanation">
                {cache.state === "ready"
                  ? "本版本已可播放，素材从浏览器缓存读取。解码与声音生成仍由浏览器执行。"
                  : cache.state === "preparing"
                    ? "文件已下载完成，正在准备画面和声音；准备就绪后才能播放。"
                    : cache.state === "cancelled"
                      ? presentation.resourcesComplete
                        ? "素材已缓存。可重试准备播放，或选择其他素材模式。"
                        : "准备已停止。可继续缓存，或选择其他素材模式。"
                      : "保存作品后会自动补齐变化的素材；缓存完成后继续准备画面和声音。"}
              </p>

              <dl className="pmp-storage">
                <div>
                  <dt>已持久保存</dt>
                  <dd>{cache.persistentFiles} 个文件</dd>
                </div>
                <div>
                  <dt>浏览器剩余空间</dt>
                  <dd>
                    {cache.storage?.quota != null
                      ? `约 ${formatBytes(Math.max(0, cache.storage.quota - (cache.storage.usage || 0)))}`
                      : "暂未获取"}
                  </dd>
                </div>
              </dl>

              {cache.warning && (
                <p className="pmp-message is-warning" role="status">
                  {cache.warning}
                </p>
              )}
              {cache.error && (
                <p className="pmp-message is-error" role="alert">
                  {cache.error}
                </p>
              )}

              <div className="pmp-cache-actions">
                {busy && (
                  <button
                    type="button"
                    disabled={unavailable}
                    onClick={() => command("cancel")}
                  >
                    {cache.state === "preparing" ? "取消准备" : "取消缓存"}
                  </button>
                )}
                {retryable && (
                  <button
                    className="pmp-primary"
                    type="button"
                    disabled={unavailable}
                    onClick={() => command("retry")}
                  >
                    {presentation.retryLabel}
                  </button>
                )}
                {!confirmClear && (
                  <button
                    ref={clearButton}
                    type="button"
                    disabled={unavailable}
                    onClick={() => setConfirmClear(true)}
                  >
                    清理本作品缓存
                  </button>
                )}
              </div>

              {confirmClear && (
                <div
                  className="pmp-clear-confirm"
                  role="group"
                  aria-labelledby={`${id}-clear-title`}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      dismissClear();
                    }
                  }}
                >
                  <strong id={`${id}-clear-title`}>
                    清理本作品的持久缓存？
                  </strong>
                  <p>
                    {cache.state === "ready"
                      ? "已就绪的当前页面仍可播放，下次打开需要重新缓存。"
                      : "会停止当前缓存或准备；之后可点击继续缓存。"}
                    作品源文件不会删除。
                  </p>
                  <div className="pmp-confirm-actions">
                    <button
                      ref={confirmButton}
                      type="button"
                      disabled={unavailable}
                      onClick={dismissClear}
                    >
                      保留缓存
                    </button>
                    <button
                      type="button"
                      className="pmp-clear-button"
                      disabled={unavailable}
                      onClick={() => command("clear")}
                    >
                      确认清理
                    </button>
                  </div>
                </div>
              )}

              {remaining.length > 0 && (
                <details
                  className="pmp-files"
                  open={filesOpen}
                  onToggle={(event) => setFilesOpen(event.currentTarget.open)}
                >
                  <summary>还需缓存 {remaining.length} 个文件</summary>
                  <ul>
                    {remaining.slice(0, visibleFiles).map((file) => (
                      <li
                        key={file.path}
                        className={
                          file.state === "error" ? "is-error" : undefined
                        }
                      >
                        <span className="pmp-file-path" title={file.path}>
                          {file.path}
                        </span>
                        <span className="pmp-file-meta">
                          <span>
                            {file.state === "downloading"
                              ? "下载中"
                              : file.state === "error"
                                ? "失败"
                                : "等待"}
                          </span>
                          <span>
                            {formatBytes(file.downloadedBytes)} /{" "}
                            {formatBytes(file.bytes)}
                          </span>
                        </span>
                        {file.error && (
                          <span className="pmp-file-error">{file.error}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {remaining.length > visibleFiles && (
                    <button
                      className="pmp-more"
                      type="button"
                      disabled={unavailable}
                      onClick={() => setVisibleFiles((value) => value + 50)}
                    >
                      显示更多文件（还有 {remaining.length - visibleFiles} 个）
                    </button>
                  )}
                </details>
              )}
            </>
          )}
        </section>
      )}
      {mode && mode !== "cached" && (
        <p className="pmp-footnote">
          需要反复查看同一版本时，可选择完整缓存，减少素材的重复下载。
        </p>
      )}
    </section>
  );
}
