import { randomUUID } from "../src/browser/uuid.mjs";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  Film,
  Paperclip,
  ExternalLink,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { request, api, useQuery, Button, ErrorNote, Loading, date } from "./ui";
import { positionReference } from "./preview-session";
import {
  FrameBootstrapSchema,
  FrameReviewContextSchema,
} from "../integrations/t3-code/shared/bridge.mjs";
import { aiBridge } from "./ai-bridge";
import { embeddedAiUrl, standaloneAiUrl } from "./ai-session.mjs";
import { aiReferenceUrl, aiReferenceLabel } from "./ai-reference.mjs";
import "./ai-chat.css";

const validationNames = {
  queued: "等待检查作品",
  running: "正在检查作品",
  passed: "作品检查通过",
  failed: "作品检查未通过",
  stale: "作品已有更新，检查结果已过期",
  cancelled: "作品检查已停止",
};
const checkNames = {
  scope: "修改范围",
  structure: "工程结构",
  "project-tests": "项目测试",
  "project-types": "类型检查",
  runtime: "画面与声音",
};
const checkStates = {
  passed: "通过",
  failed: "失败",
  running: "进行中",
  skipped: "未执行",
};

export function AiChat({
  work,
  reload,
  notify,
  position = {},
  previewReference = {},
  selectedAssets = [],
  onAddAssets,
  onPausePreview,
  onRemoveAsset,
  visible,
  compact,
  onClose,
  onPreviewWork,
  onExpand,
  expanded,
  suggestion,
}) {
  const [session, setSession] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [retry, setRetry] = useState(0),
    [frame, setFrame] = useState(null),
    [connection, setConnection] = useState("starting"),
    [activeThread, setActiveThread] = useState(null),
    [nativeRoute, setNativeRoute] = useState(null),
    [busy, setBusy] = useState(false),
    [resultsRequested, setResultsRequested] = useState(false);
  const currentSession =
    session?.bootstrap?.workId === work.id ? session : null;
  const statusQuery = useQuery(
    currentSession ? "works_ai_status" : null,
    { id: work.id },
    1,
  );
  const status = statusQuery.data;
  const resultsPanel = useRef(null);
  const bridge = useRef(null),
    latest = useRef(null),
    connectionCurrent = useRef(connection),
    pendingAction = useRef(false);
  connectionCurrent.current = connection;
  latest.current = {
    position,
    previewReference,
    selectedAssets,
    reload,
    onPausePreview,
    onClose,
    onPreviewWork,
    compact,
  };
  const latestSuggestion = useRef(null);
  useEffect(() => {
    setActiveThread(null);
    setNativeRoute(null);
    setResultsRequested(false);
    latestSuggestion.current = null;
  }, [work.id]);
  const context = () =>
    FrameReviewContextSchema.parse({
      ...positionReference(
        latest.current.position,
        latest.current.previewReference,
        Boolean(latest.current.position.selection),
      ),
      ...(latest.current.selectedAssets.length
        ? { assets: latest.current.selectedAssets.map((asset) => asset.id) }
        : {}),
    });
  useEffect(() => {
    if (!visible && !session) return;
    const control = new AbortController();
    setLoading(true);
    setError("");
    request(`/api/ai/works/${work.id}/session`, { signal: control.signal })
      .then((value) => {
        FrameBootstrapSchema.parse(value.bootstrap);
        embeddedAiUrl(value, location.href, work.id);
        if (!control.signal.aborted) setSession(value);
      })
      .catch((error) => {
        if (!control.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!control.signal.aborted) setLoading(false);
      });
    return () => control.abort();
  }, [work.id, retry, Boolean(visible || session)]);
  useEffect(() => {
    if (!frame || !currentSession) return;
    setConnection("starting");
    setActiveThread(null);
    setNativeRoute(null);
    const owner = aiBridge({
      iframe: frame,
      bootstrap: currentSession.bootstrap,
      getContext: context,
      freeze: (body, signal) =>
        request(`/api/ai/works/${work.id}/messages/freeze`, {
          method: "POST",
          body: JSON.stringify(body),
          signal,
        }),
      onAccepted: () => latest.current.reload?.(),
      onActiveThread: (threadId, navigation) => {
        setActiveThread(threadId);
        setNativeRoute(navigation?.standaloneUrl || null);
      },
      onPreview: (reference) => {
        latest.current.onPausePreview?.();
        latest.current.onPreviewWork?.(reference);
        if (latest.current.compact) latest.current.onClose?.();
      },
      onResults: () => {
        setResultsRequested(true);
        requestAnimationFrame(() => resultsPanel.current?.focus());
      },
      onClose: () => latest.current.onClose?.(),
      onConnection: setConnection,
    });
    bridge.current = owner;
    return () => {
      owner.dispose();
      if (bridge.current === owner) bridge.current = null;
    };
  }, [frame, currentSession, work.id]);
  useEffect(() => {
    if (!currentSession || connection !== "starting") return;
    const timer = setTimeout(() => {
      if (connectionCurrent.current === "starting") setConnection("error");
    }, 30000);
    return () => clearTimeout(timer);
  }, [currentSession, connection]);
  const attach = useCallback(
    (item) => {
      if (!activeThread) throw new Error("请先打开或新建此作品的对话。");
      if (!bridge.current)
        throw new Error("T3 Code 尚未连接，请重新连接后附加。");
      bridge.current.attach(activeThread, item);
      frame?.focus();
    },
    [activeThread, frame],
  );
  const addReference = () => {
    try {
      const review = context();
      attach({
        id: randomUUID(),
        identifier: "frame-preview",
        title: "作品 " + aiReferenceLabel(review),
        subtitle: `${selectedAssets.length} 个素材`,
        url: aiReferenceUrl(work.id, review, location.href),
        text: JSON.stringify(
          { workId: work.id, context: review, assets: selectedAssets },
          null,
          2,
        ),
        resourceType: "frame-reference",
      });
    } catch (error) {
      notify(error.message, "error");
    }
  };
  useEffect(() => {
    if (!suggestion || !activeThread || connection !== "ready") return;
    if (latestSuggestion.current === suggestion.id) return;
    try {
      attach({
        id: randomUUID(),
        identifier: "frame-suggestion",
        title: "作品创作建议",
        url: suggestion.review
          ? aiReferenceUrl(work.id, suggestion.review, location.href)
          : location.href,
        text:
          suggestion.text +
          (suggestion.review
            ? "\n\n" +
              JSON.stringify(
                { review: FrameReviewContextSchema.parse(suggestion.review) },
                null,
                2,
              )
            : ""),
        resourceType: "frame-context",
      });
      latestSuggestion.current = suggestion.id;
    } catch (error) {
      notify(error.message, "error");
    }
  }, [suggestion, activeThread, connection, attach, notify, work.id]);
  const act = async (operation, success) => {
    if (pendingAction.current) return;
    pendingAction.current = true;
    setBusy(true);
    setError("");
    try {
      await api(operation, { id: work.id });
      statusQuery.refresh();
      reload?.();
      if (success) notify(success, "info");
    } catch (error) {
      setError(error.message);
    } finally {
      pendingAction.current = false;
      setBusy(false);
    }
  };
  const validation = status?.validation;
  const checking = ["queued", "running"].includes(validation?.state);
  const stale = validation && validation.revision !== status.sourceRevision;
  const validationLabel = stale
    ? "检查对应较早版本，当前修改尚未检查"
    : validationNames[validation?.state] || "当前作品尚未检查";
  return (
    <section className="ai-chat" aria-label="T3 Code AI 创作">
      <header className="ai-toolbar">
        <strong>T3 Code</strong>
        <div className="ai-toolbar-actions">
          {currentSession && (
            <a
              className="button ai-open-tab"
              href={standaloneAiUrl(currentSession, nativeRoute, location.href)}
              target="_blank"
              rel="noopener"
              aria-label="在新标签页打开 T3 Code"
              title="打开完整 T3 Code 工作台，并定位当前对话"
              onClick={(event) => {
                let nativeUrl;
                try {
                  nativeUrl = frame?.contentWindow?.location.href;
                } catch {}
                event.currentTarget.href = standaloneAiUrl(
                  currentSession,
                  nativeRoute || nativeUrl,
                  location.href,
                );
              }}
            >
              <ExternalLink size={17} aria-hidden="true" />
              完整工作台
            </a>
          )}
          <Button
            icon={expanded ? Minimize2 : Maximize2}
            onClick={onExpand}
            aria-label={expanded ? "还原 AI 面板" : "展开 AI 面板"}
          />
        </div>
      </header>
      <div className="ai-context-strip">
        <Button
          icon={Film}
          onClick={() => {
            onPausePreview?.();
            onPreviewWork?.();
            if (compact) onClose?.();
          }}
        >
          查看作品预览
        </Button>
        <Button
          icon={Paperclip}
          disabled={!activeThread || connection !== "ready"}
          onClick={addReference}
        >
          引用当前画面
        </Button>
        <Button onClick={onAddAssets}>
          选择素材{selectedAssets.length ? `（${selectedAssets.length}）` : ""}
        </Button>
        {selectedAssets.map((asset) => (
          <button
            type="button"
            key={asset.id}
            className="ai-asset"
            onClick={() => onRemoveAsset?.(asset.id)}
            aria-label={"移除素材引用 " + asset.name}
            title={"移除素材引用 " + asset.name}
          >
            {asset.name} ×
          </button>
        ))}
      </div>
      {(status?.native?.activeThreads?.length > 0 ||
        status?.native?.activeTerminals > 0 ||
        status?.native?.pendingPermissions > 0) && (
        <div className="ai-context-strip">
          <Button
            disabled={busy}
            aria-describedby={"ai-stop-scope-" + work.id}
            onClick={() =>
              void act("works_stop", "已请求停止本作品的 AI、终端和后台任务。")
            }
          >
            停止本作品后台工作
          </Button>
          <small id={"ai-stop-scope-" + work.id} className="quiet">
            AI、终端及排队和运行中的任务（含导出）都会停止。
          </small>
        </div>
      )}
      {(validation || resultsRequested) && (
        <section
          ref={resultsPanel}
          className="ai-validation"
          aria-label="作品检查"
          tabIndex={-1}
        >
          <span role="status">
            {validationLabel}
            {validation?.revision
              ? ` · ${validation.revision.slice(0, 8)}`
              : ""}
          </span>
          <Button
            disabled={busy || (checking && !stale)}
            onClick={() => void act("works_ai_validate")}
          >
            {checking && !stale ? "正在检查…" : "检查当前作品"}
          </Button>
          {(validation?.checkedAt || validation?.updated) && (
            <small>
              检查时间：{date(validation.checkedAt || validation.updated)}
            </small>
          )}
          {validation?.error && (
            <details>
              <summary>查看检查原因</summary>
              <pre>{validation.error}</pre>
            </details>
          )}
          {validation?.checks?.length > 0 && (
            <details>
              <summary>查看作品检查</summary>
              <ul>
                {validation.checks.map((check) => (
                  <li key={check.name}>
                    {checkNames[check.name] || check.name} ·{" "}
                    {checkStates[check.status] || check.status}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      <ErrorNote error={error || statusQuery.error} />
      {(error || statusQuery.error || connection === "error") && (
        <Button
          icon={RefreshCw}
          disabled={loading}
          onClick={() => {
            setRetry((value) => value + 1);
            statusQuery.refresh();
          }}
        >
          重新连接 T3 Code
        </Button>
      )}
      <div className="ai-native-pane">
        {loading && !currentSession && <Loading />}
        {currentSession && (
          <iframe
            ref={setFrame}
            src={currentSession.uiUrl}
            title={`T3 Code · ${work.title || work.project}`}
            className="ai-native-frame"
            allow="microphone;clipboard-read;clipboard-write;autoplay"
          />
        )}
        {currentSession && connection !== "ready" && (
          <div className="ai-connection-status" role="status">
            {connection === "error"
              ? "作品桥接连接中断，请重新连接。"
              : "正在打开此作品的 AI 对话…"}
          </div>
        )}
      </div>
    </section>
  );
}
