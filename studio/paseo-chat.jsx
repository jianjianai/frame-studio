import { useCallback, useEffect, useRef, useState } from "react";
import {
  RefreshCw,
  Film,
  Paperclip,
  History,
  MessageSquare,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { request, api, Button, ErrorNote, Loading } from "./ui";
import { positionReference } from "./preview-session";
import {
  FrameBootstrapSchema,
  FrameReviewContextSchema,
} from "../integrations/paseo/frame-plugin/shared/bridge.mjs";
import { paseoBridge } from "./paseo-bridge";
import { WorkHistory } from "./work-history";
import { readAgentTarget } from "./agent/agent-navigation";
import "./paseo-chat.css";
const candidateNames = {
  queued_validation: "等待作品校验",
  validating: "正在校验作品",
  verified: "作品校验通过，等待应用",
  publishing: "正在应用作品",
  applied: "已应用到作品",
  invalid: "作品校验未通过",
  publish_failed: "应用失败，可重试",
  conflict: "作品版本已变更",
  superseded: "已有更新的作品版本",
};
export function PaseoChat({
  work,
  reload,
  notify,
  position,
  previewReference = {},
  selectedAssets = [],
  onAddAssets,
  onPausePreview,
  onRecall,
  onRemoveAsset,
  visible,
  compact,
  onClose,
  onPreviewAgent,
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
    [tab, setTab] = useState("paseo"),
    [status, setStatus] = useState(null),
    [activeAgent, setActiveAgent] = useState(null),
    [activeNative, setActiveNative] = useState(false),
    [statusError, setStatusError] = useState(""),
    [historyTarget, setHistoryTarget] = useState(null),
    [busy, setBusy] = useState(false),
    [resultsRequested, setResultsRequested] = useState(false);
  const resultsPanel = useRef(null);
  const bridge = useRef(null),
    latest = useRef(null),
    connectionCurrent = useRef(connection);
  connectionCurrent.current = connection;
  latest.current = {
    position,
    previewReference,
    selectedAssets,
    reload,
    onPausePreview,
    onClose,
    onPreviewAgent,
    onRecall,
    activeAgent,
    activeNative,
    compact,
  };
  const latestSuggestion = useRef(null);
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
    const read = (event) => {
      const target = event?.detail ?? readAgentTarget();
      if (target?.work !== work.id) return;
      setHistoryTarget(target);
      setTab("history");
    };
    read();
    window.addEventListener("frame-agent-navigate", read);
    return () => window.removeEventListener("frame-agent-navigate", read);
  }, [work.id]);
  useEffect(() => {
    if (!visible && !session) return;
    const control = new AbortController();
    setLoading(true);
    setError("");
    request(`/api/paseo/works/${work.id}/session`, { signal: control.signal })
      .then((value) => {
        const config = FrameBootstrapSchema.parse(value.bootstrap),
          url = new URL(value.uiUrl, location.href);
        if (
          config.workId !== work.id ||
          config.parentOrigin !== location.origin ||
          config.basePath !== `/paseo/${work.id}/` ||
          url.origin !== location.origin ||
          !url.pathname.startsWith(config.basePath) ||
          url.searchParams.get("frameNonce") !== config.nonce
        )
          throw new Error("Paseo 返回的作品连接范围无效");
        setSession(value);
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
    if (!frame || !session) return;
    setConnection("starting");
    const owner = paseoBridge({
      iframe: frame,
      bootstrap: session.bootstrap,
      getContext: context,
      freeze: (body, signal) =>
        request(`/api/paseo/works/${work.id}/messages/freeze`, {
          method: "POST",
          body: JSON.stringify(body),
          signal,
        }),
      onAccepted: () => latest.current.reload?.(),
      onActiveAgent: (id, native) => {
        setActiveAgent(id);
        setActiveNative(native);
      },
      onPreview: () => {
        latest.current.onPausePreview?.();
        if (!latest.current.activeNative) {
          notify("请先发送首条消息创建对话，再预览这个工作区。", "info");
          return;
        }
        latest.current.onPreviewAgent?.(latest.current.activeAgent);
        if (latest.current.compact) latest.current.onClose?.();
      },
      onResults: () => {
        setTab("paseo");
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
  }, [frame, session, work.id]);
  useEffect(() => {
    if (!session || connection !== "starting") return;
    const timer = setTimeout(() => {
      if (connectionCurrent.current === "starting") setConnection("error");
    }, 30000);
    return () => clearTimeout(timer);
  }, [session, connection]);
  useEffect(
    () => bridge.current?.contextChanged(),
    [position, previewReference, selectedAssets],
  );
  useEffect(() => {
    if (!session) return;
    const control = new AbortController();
    let timer;
    const poll = async () => {
      try {
        const value = await request(
          `/api/paseo/works/${work.id}/status${activeAgent && activeNative ? "?agentId=" + encodeURIComponent(activeAgent) : ""}`,
          { signal: control.signal },
        );
        if (!control.signal.aborted) {
          setStatus(value);
          setStatusError("");
        }
      } catch (error) {
        if (!control.signal.aborted) setStatusError(error.message);
      } finally {
        if (!control.signal.aborted)
          timer = setTimeout(poll, visible ? 2000 : 8000);
      }
    };
    void poll();
    return () => {
      control.abort();
      clearTimeout(timer);
    };
  }, [session, work.id, activeAgent, activeNative, visible]);
  const attach = useCallback(
    (item) => {
      if (!activeAgent)
        throw new Error("请先在 Paseo 打开或新建一个对话输入框。");
      if (!bridge.current)
        throw new Error("Paseo 尚未连接，请重新连接后附加。");
      bridge.current.attach(activeAgent, item);
      setTab("paseo");
      frame?.focus();
    },
    [activeAgent, frame],
  );
  const addReference = () => {
    try {
      const value = context();
      attach({
        id: crypto.randomUUID(),
        identifier: "frame-preview",
        title: "当前画面与所选素材",
        subtitle: `${selectedAssets.length} 个素材`,
        url: location.href,
        text: JSON.stringify(
          { workId: work.id, context: value, assets: selectedAssets },
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
    if (!suggestion || !activeAgent) return;
    if (latestSuggestion.current === suggestion.id) return;
    latestSuggestion.current = suggestion.id;
    try {
      attach({
        id: crypto.randomUUID(),
        identifier: "frame-suggestion",
        title: "作品创作建议",
        url: location.href,
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
    } catch (error) {
      notify(error.message, "error");
    }
  }, [suggestion?.id, activeAgent]);
  const act = async (operation) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await request(
        `/api/paseo/works/${work.id}/candidates/${status.candidate.id}/${operation}`,
        { method: "POST" },
      );
      const value = await request(`/api/paseo/works/${work.id}/status`);
      setStatus(value);
      reload?.();
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  };
  const candidate = status?.candidate,
    selected = status?.selectedAgent;
  return (
    <section className="paseo-chat" aria-label="Paseo AI 创作">
      <header className="paseo-toolbar">
        <nav aria-label="AI 创作视图">
          <Button
            aria-pressed={tab === "paseo"}
            icon={MessageSquare}
            onClick={() => setTab("paseo")}
          >
            Paseo
          </Button>
          <Button
            aria-pressed={tab === "history"}
            icon={History}
            onClick={() => setTab("history")}
          >
            旧版记录
          </Button>
        </nav>
        <Button
          icon={expanded ? Minimize2 : Maximize2}
          onClick={onExpand}
          aria-label={expanded ? "还原 AI 面板" : "展开 AI 面板"}
        />
      </header>
      <div className="paseo-context-strip">
        <Button
          icon={Film}
          disabled={!activeAgent || !activeNative}
          onClick={() => {
            onPausePreview?.();
            onPreviewAgent?.(activeAgent);
            if (compact) onClose?.();
          }}
        >
          预览当前对话
        </Button>
        <Button
          onClick={() => {
            onPreviewAgent?.(null);
            if (compact) onClose?.();
          }}
        >
          主工作区预览
        </Button>
        <Button icon={Paperclip} disabled={!activeAgent} onClick={addReference}>
          引用当前画面
        </Button>
        <Button onClick={onAddAssets}>
          选择素材{selectedAssets.length ? `（${selectedAssets.length}）` : ""}
        </Button>
        {selectedAssets.map((asset) => (
          <button
            key={asset.id}
            className="paseo-asset"
            onClick={() => onRemoveAsset?.(asset.id)}
            title={"移除素材引用 " + asset.name}
          >
            {asset.name} ×
          </button>
        ))}
      </div>
      {selected?.kind === "worktree" && (
        <p className="paseo-branch-note" role="status">
          工作树预览{selected.branch ? `：${selected.branch}` : ""}
          。合并回主工作区后应用到作品。
        </p>
      )}
      {status?.native?.incomplete && status?.native?.activeTerminals > 0 && (
        <p className="paseo-branch-note" role="status">
          终端正在运行或尚未确认空闲。关闭该终端后继续自动校验与应用。
        </p>
      )}
      {(status?.native?.activeAgents?.length > 0 ||
        status?.native?.activeTerminals > 0 ||
        status?.native?.pendingPermissions > 0) && (
        <div className="paseo-context-strip">
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api("works_stop", { id: work.id });
                reload?.();
                notify("已请求停止本作品的 AI 与终端。", "info");
              } catch (error) {
                setError(error.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            停止本作品 AI 与终端
          </Button>
        </div>
      )}
      {(candidate || resultsRequested) && (
        <section
          ref={resultsPanel}
          className={"paseo-candidate state-" + (candidate?.state || "waiting")}
          aria-label="作品校验与应用"
          tabIndex={-1}
        >
          {!candidate && (
            <p>
              主工作区尚未产生作品校验结果。AI
              完成修改并关闭仍在运行的终端后，会自动校验与应用；工作树修改需先合并回主工作区。
            </p>
          )}
          {candidate && (
            <>
              <span role="status">
                {candidateNames[candidate.state] ?? candidate.state}
                {candidate.revision
                  ? ` · ${candidate.revision.slice(0, 8)}`
                  : ""}
              </span>
              {["verified", "publish_failed"].includes(candidate.state) && (
                <Button disabled={busy} onClick={() => void act("apply")}>
                  {busy ? "正在处理…" : "应用到作品"}
                </Button>
              )}
              {["invalid", "publish_failed"].includes(candidate.state) && (
                <Button disabled={busy} onClick={() => void act("retry")}>
                  重试{candidate.state === "invalid" ? "校验" : "应用"}
                </Button>
              )}
              {candidate.error && (
                <details>
                  <summary>查看校验或应用原因</summary>
                  <pre>{candidate.error}</pre>
                </details>
              )}
              {candidate.validation?.length > 0 && (
                <details>
                  <summary>查看作品检查</summary>
                  <ul>
                    {candidate.validation.map((check) => (
                      <li key={check.name}>
                        {check.name} · {check.status}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </section>
      )}
      <ErrorNote error={error || statusError} />
      {(error || statusError || connection === "error") && (
        <Button icon={RefreshCw} onClick={() => setRetry((value) => value + 1)}>
          重新连接 Paseo
        </Button>
      )}
      <div className="paseo-native-pane" hidden={tab !== "paseo"}>
        {loading && !session && <Loading />}
        {session && (
          <iframe
            ref={setFrame}
            src={session.uiUrl}
            title={`Paseo · ${work.title || work.project}`}
            className="paseo-native-frame"
            allow="microphone;clipboard-read;clipboard-write;autoplay"
          />
        )}
        {session && connection !== "ready" && (
          <div className="paseo-connection-status" role="status">
            {connection === "error"
              ? "作品桥接连接中断，请重新连接。"
              : "正在连接完整 Paseo 创作界面…"}
          </div>
        )}
      </div>
      {tab === "history" && (
        <WorkHistory
          work={work}
          notify={notify}
          target={historyTarget}
          onRecall={onRecall}
          onChanged={reload}
          onAttachSummary={(item) => {
            try {
              attach(item);
            } catch (error) {
              notify(error.message, "error");
            }
          }}
        />
      )}
    </section>
  );
}
