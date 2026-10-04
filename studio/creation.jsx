import { randomUUID } from "../src/browser/uuid.mjs";
import { usePreviewSession, decodePlayerMessage } from "./preview-session";
import { useBrowserExport } from "./browser-export-session";
import { AiChat } from "./ai-chat";
import { WorkTools } from "./work-tools";
import { WorkDock } from "./work-dock";
import { PreviewMediaPanel } from "./preview-media-panel";
import { usePreviewMediaSession } from "./preview-media-session";
const AudioEditor = lazy(() =>
  import("./audio-editor").then((m) => ({ default: m.AudioEditor })),
);
const CompositionEditor = lazy(() =>
  import("./composition-editor").then((m) => ({
    default: m.CompositionEditor,
  })),
);
import { ExportProgress, exportState } from "./exports";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
} from "react";
import { previewCacheBridge } from "./preview-cache";
import { liveAudioInputBridge } from "./live-audio-input";
import { ResizeHandle } from "../src/ui/ResizeHandle";
import {
  readPreference,
  writePreference,
  boundedPreference,
} from "../src/ui/view-preferences";
import { Square, Play, RefreshCw } from "lucide-react";
import {
  api,
  useQuery,
  useAction,
  Button,
  Modal,
  ErrorNote,
  Loading,
  active,
  cancellable,
  states,
  kinds,
  date,
  useMediaQuery,
} from "./ui";
import { Materials, Details, Voice, Exports } from "./work-panels";
import {
  readAiReference,
  aiReferenceMatch,
  aiReferencePosition,
  aiReferenceLabel,
} from "./ai-reference.mjs";

const SourceControl = lazy(() =>
  import("./source-control").then((module) => ({
    default: module.SourceControl,
  })),
);

export function Creation({ id, notify }) {
  const query = useQuery("works_open", { id }),
    taskQuery = useQuery("works_tasks", { id }, 2000),
    previewQuery = useQuery("works_preview_status", { id }, 1),
    syncQuery = useQuery("works_sync_status", { id }, 1),
    tasks = taskQuery.data || [],
    iframe = useRef(null),
    split = useRef(null);
  const [playerElement, setPlayerElement] = useState(null);
  const [aiExpanded, setAiExpanded] = useState(false);
  const [messageReference, setMessageReference] = useState(null),
    [messageReferenceError, setMessageReferenceError] = useState(""),
    [referenceLocated, setReferenceLocated] = useState(false);
  const referenceApplied = useRef(false);
  const showMessageReference = useCallback((reference) => {
    referenceApplied.current = false;
    setReferenceLocated(false);
    setMessageReference(reference);
    setMessageReferenceError("");
  }, []);
  useEffect(() => {
    const read = () => {
      try {
        showMessageReference(readAiReference(location.href, id));
      } catch (error) {
        showMessageReference(null);
        setMessageReferenceError(error.message);
      }
    };
    read();
    window.addEventListener("popstate", read);
    window.addEventListener("hashchange", read);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener("hashchange", read);
    };
  }, [id, showMessageReference]);
  const [editorDirty, setEditorDirty] = useState({
    audio: false,
    composition: false,
  });
  const onAudioDirtyChange = useCallback(
    (dirty) =>
      setEditorDirty((previous) =>
        previous.audio === dirty ? previous : { ...previous, audio: dirty },
      ),
    [],
  );
  const onCompositionDirtyChange = useCallback(
    (dirty) =>
      setEditorDirty((previous) =>
        previous.composition === dirty
          ? previous
          : { ...previous, composition: dirty },
      ),
    [],
  );
  const bindPlayer = useCallback((element) => {
    iframe.current = element;
    setPlayerElement(element);
  }, []);
  const [panel, setPanel] = useState(""),
    [tool, setTool] = useState(() => {
      const fallback = readPreference(
        "frame.chat-open",
        window.innerWidth > 900,
      )
        ? "ai"
        : "";
      const saved = readPreference("frame.work-tool", fallback);
      return [
        "ai",
        "composition",
        "audio",
        "materials",
        "preview-media",
        "voice",
        "tasks",
        "sync",
        "",
      ].includes(saved)
        ? saved
        : fallback;
    }),
    [visited, setVisited] = useState({ ai: true }),
    [ratio, setRatio] = useState(() =>
      boundedPreference(
        readPreference("frame.workspace-split", 68),
        68,
        35,
        80,
      ),
    ),
    [dragging, setDragging] = useState(false),
    [position, setPosition] = useState({ time: 0 }),
    [assets, setAssets] = useState(() => {
      try {
        const value = JSON.parse(
          sessionStorage.getItem("frame.assets:" + id) || "[]",
        );
        return Array.isArray(value)
          ? value
              .filter(
                (a) =>
                  a && typeof a.id === "string" && typeof a.name === "string",
              )
              .slice(0, 20)
          : [];
      } catch {
        return [];
      }
    }),
    [suggestion, setSuggestion] = useState(null),
    [run, busy] = useAction(notify);
  useEffect(() => {
    setAiExpanded(false);
  }, [id]);
  useEffect(() => {
    try {
      sessionStorage.setItem(
        "frame.assets:" + id,
        JSON.stringify(assets.map(({ id, name }) => ({ id, name }))),
      );
    } catch {}
  }, [assets, id]);
  const addAsset = (asset) =>
    setAssets((old) =>
      old.some((item) => item.id === asset.id)
        ? old
        : old.length < 20
          ? [...old, { id: asset.id, name: asset.name }]
          : old,
    );
  const audioInput = useRef(null);
  const [audioInputState, setAudioInputState] = useState(null);
  const restartPreview = useRef(() => {});
  const browserExport = useBrowserExport(iframe, notify, () =>
    restartPreview.current(),
  );
  const { job: browserJob, busy: browserBusy } = browserExport;
  const latest = previewQuery.data?.latest;
  const {
    preview,
    stage: previewStage,
    setStage: setPreviewStage,
    reference: previewReference,
    error: previewError,
    retry: renewPreview,
    restart,
    playerGeneration,
    status: liveStatus,
    receiveLive,
  } = usePreviewSession({
    workId: id,
    latest,
    mode: "live",
    blocked: browserBusy,
    notify,
  });
  const liveReceiver = useRef(receiveLive);
  liveReceiver.current = receiveLive;
  restartPreview.current = restart;
  const compact = useMediaQuery("(max-width: 900px)");
  const toolbarRef = useRef(null);
  const returnFocus = useRef(null);
  const dockOpen = !!tool;
  const chatOpen = tool === "ai";
  const openTool = (key, trigger) => {
    returnFocus.current =
      trigger || toolbarRef.current?.querySelector(`[data-tool-key="${key}"]`);
    setVisited((previous) => ({ ...previous, [key]: true }));
    setTool(key);
  };
  useEffect(() => {
    if (tool)
      setVisited((previous) =>
        previous[tool] ? previous : { ...previous, [tool]: true },
      );
  }, [tool]);
  const closeTool = () => {
    setTool("");
    requestAnimationFrame(() => {
      const previous = returnFocus.current;
      const fallback = toolbarRef.current?.querySelector(
        `[data-tool-key="${compact && tool !== "ai" ? "tools" : tool}"]`,
      );
      (previous?.isConnected && previous.getClientRects().length
        ? previous
        : fallback
      )?.focus();
    });
  };
  useEffect(() => {
    const shortcut = (event) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "g" &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        openTool("sync");
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const resourcePreference = useRef(
    readPreference("frame.preview-media-mode", "compressed"),
  );
  const attachedMedia = useRef({ key: "", mode: resourcePreference.current });
  const playerPreferences = useRef(readPreference("frame.player-view", {}));
  const playbackSnapshot = useRef(null),
    restorePending = useRef(null),
    attachedPlayer = useRef("");
  useEffect(() => {
    playbackSnapshot.current = null;
    restorePending.current = null;
    attachedPlayer.current = "";
    setPosition({ time: 0 });
  }, [id]);
  const playerKey = preview ? preview.id + ":" + playerGeneration : "";
  if (attachedMedia.current.key !== playerKey)
    attachedMedia.current = {
      key: playerKey,
      mode: resourcePreference.current,
    };
  const mediaSession = usePreviewMediaSession({
    iframe,
    playerElement,
    playerKey,
    live: preview?.live,
    onMode: (mode) => {
      if (resourcePreference.current === mode) return;
      resourcePreference.current = mode;
      writePreference("frame.preview-media-mode", mode);
    },
  });
  const previewFrameUrl = () => {
    const url = new URL(preview.url, location.href);
    if (preview.live) {
      url.searchParams.set("mediaMode", attachedMedia.current.mode);
      url.searchParams.set("mediaControls", "external");
    }
    return url.href;
  };
  if (playerKey && attachedPlayer.current !== playerKey) {
    attachedPlayer.current = playerKey;
    restorePending.current = playbackSnapshot.current;
  }
  const restorePlayback = () => {
    const value = restorePending.current;
    if (!value) return;
    restorePending.current = null;
    sendPlayer("restore-session", {
      state: {
        time: value.time || 0,
        playing: !!value.playing,
        rate: value.rate || 1,
        loop: !!value.loop,
        ...(typeof value.volume === "number" ? { volume: value.volume } : {}),
        ...(typeof value.muted === "boolean" ? { muted: value.muted } : {}),
        ...(typeof value.subtitles === "boolean"
          ? { subtitles: value.subtitles }
          : {}),
        ...(value.selection ? { selection: value.selection } : {}),
      },
    });
  };
  const sendPlayer = (command, extra = {}) =>
    iframe.current?.contentWindow?.postMessage(
      { type: "frame-player-command", command, ...extra },
      "*",
    );
  const referenceMatch = messageReference
    ? aiReferenceMatch(messageReference, previewReference)
    : null;
  const referenceReady = Boolean(
    playerElement &&
    preview &&
    !browserBusy &&
    (preview.live ? liveStatus === "ready" : !previewStage),
  );
  useEffect(() => {
    referenceApplied.current = false;
    setReferenceLocated(false);
  }, [
    playerElement,
    previewReference.liveSessionId,
    previewReference.sourceRevision,
    previewReference.compiledRevision,
    previewReference.previewTask,
    previewReference.sourceCommit,
  ]);
  const locateMessageReference = () => {
    if (!messageReference || !referenceReady) return;
    sendPlayer("pause");
    sendPlayer("seek", aiReferencePosition(messageReference));
    referenceApplied.current = true;
    setReferenceLocated(true);
  };
  useEffect(() => {
    if (
      referenceReady &&
      referenceMatch === "matched" &&
      !referenceApplied.current
    )
      locateMessageReference();
  }, [
    referenceReady,
    referenceMatch,
    messageReference,
    playerElement,
    previewReference.liveSessionId,
    previewReference.sourceRevision,
    previewReference.compiledRevision,
    previewReference.previewTask,
    previewReference.sourceCommit,
  ]);
  const closeChat = closeTool;
  const retryPreview = () => {
    if (browserBusy) return;
    if (preview?.live)
      iframe.current?.contentWindow?.postMessage(
        { type: "frame-live-retry" },
        "*",
      );
    renewPreview();
  };
  const updatePreview = () => {
    if (!browserBusy) retryPreview();
  };
  const updatePreviewRef = useRef(updatePreview);
  updatePreviewRef.current = updatePreview;
  const workContext = useRef(null);
  workContext.current = {
    title: query.data?.title || "作品",
    compact,
    previewStatus:
      liveStatus === "updating" || liveStatus === "starting"
        ? "building"
        : liveStatus === "reconnecting" || liveStatus === "error"
          ? "unknown"
          : "ready",
    updateDisabled: browserBusy,
    previewMode: preview?.live ? "live" : "published",
    previewSource: preview?.source || "work",
    liveState: liveStatus,
  };
  const workContextKey = JSON.stringify(workContext.current);
  useEffect(() => {
    if (preview) sendPlayer("configure-work", { context: workContext.current });
  }, [workContextKey, preview?.url]);

  useEffect(() => {
    document.title = query.data
      ? query.data.title + " · FRAME"
      : "作品 · FRAME";
  }, [query.data?.title]);
  useEffect(() => {
    let last = 0,
      pending = false;
    const check = () => {
      if (pending || document.hidden || Date.now() - last < 300000) return;
      pending = true;
      last = Date.now();
      api("works_sync_status", { id, fetch: true })
        .then(syncQuery.refresh)
        .catch(() => {})
        .finally(() => {
          pending = false;
        });
    };
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [id]);
  useEffect(() => {
    const check = () => previewQuery.refresh();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [id]);
  useEffect(() => {
    const receive = (e) => {
      if (e.source !== iframe.current?.contentWindow) return;
      if (
        e.data?.type === "frame-preview-media-mode" &&
        ["original", "compressed", "cached"].includes(e.data.mode)
      ) {
        resourcePreference.current = e.data.mode;
        writePreference("frame.preview-media-mode", e.data.mode);
      }
      const decoded = decodePlayerMessage(e.data);
      if (!decoded) return;
      if (decoded.type === "frame-download-error")
        notify(decoded.message, "error");
      if (decoded.type === "frame-player-ready") {
        sendPlayer("configure-view", {
          preferences: playerPreferences.current,
        });
        sendPlayer("configure-work", { context: workContext.current });
        restorePlayback();
      }
      if (decoded.type === "frame-live-preview") liveReceiver.current(decoded);
      if (decoded.type === "frame-player-preferences") {
        playerPreferences.current = decoded.preferences;
        writePreference("frame.player-view", decoded.preferences);
      }
      if (decoded.type === "frame-preview-update-request")
        void updatePreviewRef.current();
      if (decoded.type === "frame-preview-loading")
        setPreviewStage(decoded.message);
      if (decoded.type === "frame-player-state") {
        playbackSnapshot.current = decoded;
        setPosition(decoded);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(
    () =>
      preview && playerElement
        ? previewCacheBridge(iframe, preview.url)
        : undefined,
    [preview?.url, playerGeneration, playerElement],
  );
  useEffect(() => {
    setAudioInputState(null);
    if (!preview?.live || !playerElement) return;
    const bridge = liveAudioInputBridge(
      iframe,
      preview.url,
      setAudioInputState,
    );
    audioInput.current = bridge;
    return () => {
      bridge.dispose();
      if (audioInput.current === bridge) audioInput.current = null;
    };
  }, [id, preview?.url, preview?.live, playerGeneration, playerElement]);
  useEffect(() => {
    writePreference("frame.chat-open", chatOpen);
    writePreference("frame.work-tool", tool);
    writePreference("frame.workspace-split", ratio);
  }, [tool, ratio]);
  if (query.loading && !query.data) return <Loading />;
  if (query.error) return <ErrorNote error={query.error} />;
  const work = query.data;
  if (!work) return null;
  const previewDiagnostic = String(previewError || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b/g, "");
  const running = tasks.filter(active),
    title = {
      exports: "导出",
      details: "作品资料",
    }[panel];
  return (
    <div className="creation">
      <WorkTools
        work={work}
        tool={tool}
        compact={compact}
        running={running.length + (browserBusy ? 1 : 0)}
        sync={syncQuery.data}
        syncError={syncQuery.error}
        browserBusy={browserBusy}
        inert={compact && dockOpen}
        toolbarRef={toolbarRef}
        onModal={setPanel}
        onTool={(key, trigger) =>
          tool === key ? closeTool() : openTool(key, trigger)
        }
      />
      {audioInputState &&
        (audioInputState.requests.length > 0 ||
          audioInputState.granted ||
          audioInputState.enumerationGranted ||
          audioInputState.denied ||
          audioInputState.error) && (
          <section
            className="live-audio-input-notice"
            aria-label="预览麦克风权限"
            aria-live="polite"
          >
            {audioInputState.requests.map((request) => (
              <div className="live-audio-input-request" key={request.requestId}>
                <div>
                  <strong>此预览请求{request.label}</strong>
                  <small>
                    {request.op === "open"
                      ? `仅传入本浏览器预览 · ${request.sampleRate} Hz · ${request.channels} 声道 · 不会自动外放或上传录音`
                      : "仅返回音频输入设备信息，不会开启录音"}
                  </small>
                  {request.device !== undefined && (
                    <small>请求设备：{String(request.device)}</small>
                  )}
                </div>
                {request.stage === "opening" ? (
                  <span role="status">正在取得音频权限…</span>
                ) : (
                  <Button
                    onClick={(event) =>
                      void audioInput.current?.allow(
                        request.requestId,
                        event.nativeEvent,
                      )
                    }
                  >
                    允许此作品本次预览
                  </Button>
                )}
                <Button
                  onClick={() => audioInput.current?.deny(request.requestId)}
                >
                  拒绝本预览
                </Button>
              </div>
            ))}
            {(audioInputState.granted ||
              audioInputState.enumerationGranted) && (
              <div className="live-audio-input-active">
                <span>
                  {audioInputState.active.length
                    ? `麦克风使用中 · ${audioInputState.active.length} 个音频节点`
                    : audioInputState.granted
                      ? "麦克风已授权此预览 · 当前没有录音节点"
                      : "此预览已获设备查询权限 · 不录音"}
                </span>
                {audioInputState.active[0]?.device?.label && (
                  <small>{audioInputState.active[0].device.label}</small>
                )}
                <Button
                  onClick={() =>
                    audioInput.current?.stop("用户停止了本预览的麦克风")
                  }
                >
                  停止麦克风并撤销授权
                </Button>
              </div>
            )}
            {audioInputState.error && (
              <p role="alert">{audioInputState.error}</p>
            )}
            {audioInputState.denied && (
              <div className="live-audio-input-active">
                <small>
                  麦克风已停止；代码不能自行重新开启。允许重新申请后，重新播放或调用
                  open() 可再次发起请求。
                </small>
                <Button
                  onClick={(event) =>
                    audioInput.current?.reallow(event.nativeEvent)
                  }
                >
                  允许重新申请麦克风
                </Button>
              </div>
            )}
          </section>
        )}
      <div
        ref={split}
        className={`creation-split ${dockOpen ? "chat-open" : "chat-closed"} ${dragging ? "dragging" : ""}`}
        style={{
          "--video-share": ratio + "fr",
          "--chat-share": 100 - ratio + "fr",
        }}
      >
        <div
          className="preview-pane"
          inert={compact && dockOpen ? true : undefined}
        >
          <ErrorNote error={messageReferenceError} />
          {messageReference && (
            <div
              className="preview-version-note live-preview-note"
              role="status"
              aria-label="对话中的画面引用"
            >
              <strong>对话引用 · {aiReferenceLabel(messageReference)}</strong>
              <span>
                {referenceMatch === "matched"
                  ? referenceLocated
                    ? "已定位引用对应的预览版本。"
                    : "正在定位引用画面…"
                  : referenceMatch === "pending"
                    ? "正在核对引用记录的预览版本…"
                    : referenceMatch === "unversioned"
                      ? "此引用未记录源码版本，尚未定位。"
                      : referenceLocated
                        ? "已按你的选择定位当前版本；引用仍属于记录的较早版本。"
                        : "引用记录的版本与当前预览不同，尚未定位。"}
              </span>
              {(messageReference.sourceRevision ||
                messageReference.sourceCommit) && (
                <details style={{ maxWidth: "100%", overflowWrap: "anywhere" }}>
                  <summary>查看引用版本</summary>
                  <p>
                    记录源码：
                    {messageReference.sourceRevision ||
                      messageReference.sourceCommit}
                  </p>
                  {messageReference.compiledRevision && (
                    <p>记录画面：{messageReference.compiledRevision}</p>
                  )}
                  <p>
                    当前源码：
                    {previewReference.sourceRevision ||
                      previewReference.sourceCommit ||
                      "正在获取"}
                  </p>
                  {messageReference.compiledRevision && (
                    <p>
                      当前画面：
                      {previewReference.compiledRevision || "正在获取"}
                    </p>
                  )}
                </details>
              )}
              <Button
                disabled={!referenceReady || referenceMatch === "pending"}
                onClick={locateMessageReference}
              >
                {referenceMatch === "matched"
                  ? "重新定位引用"
                  : "在当前版本定位此时间"}
              </Button>
            </div>
          )}
          {(previewError || preview?.fallback) && (
            <div
              className="preview-version-note live-preview-note"
              role="status"
            >
              {preview?.fallback && (
                <span>实时预览暂不可用，当前显示已发布版本。</span>
              )}
              {previewError && (
                <details className="preview-error-details">
                  <summary>实时预览更新失败 · 查看错误</summary>
                  <pre>{previewDiagnostic}</pre>
                </details>
              )}
              <Button disabled={browserBusy} onClick={retryPreview}>
                重新连接实时预览
              </Button>
            </div>
          )}
          {preview ? (
            <>
              {previewStage && (
                <div className="preview-loading" role="status">
                  <span>{previewStage}</span>
                  <progress aria-label="作品加载进度" />
                  <small>首次加载后，保存修改会自动更新；声音按需准备。</small>
                </div>
              )}
              <iframe
                key={playerKey}
                ref={bindPlayer}
                title="作品播放器"
                src={previewFrameUrl()}
                onLoad={() => {
                  sendPlayer("configure-view", {
                    preferences: playerPreferences.current,
                  });
                  sendPlayer("configure-work", {
                    context: workContext.current,
                  });
                }}
                sandbox="allow-scripts allow-downloads"
                allow="autoplay; fullscreen"
                allowFullScreen
              />
            </>
          ) : (
            <div className="preview-placeholder">
              <Play size={44} />
              {running.length > 0 && <progress aria-label="准备作品预览" />}
              <p>{previewStage || "实时预览暂不可用"}</p>
              <ErrorNote error={previewQuery.error || taskQuery.error} />
              <Button
                icon={RefreshCw}
                disabled={browserBusy}
                onClick={() => void updatePreview()}
              >
                重新连接实时预览
              </Button>
            </div>
          )}
        </div>
        {dockOpen && (
          <ResizeHandle
            axis="vertical"
            value={ratio}
            min={35}
            max={80}
            containerRef={split}
            onChange={setRatio}
            onDragChange={setDragging}
            label="调整播放器和工作面板大小"
          />
        )}
        {dockOpen && (
          <button
            className="chat-scrim"
            aria-label="收起工作面板"
            onClick={closeChat}
            tabIndex={-1}
          />
        )}
        <WorkDock
          tool={tool}
          compact={compact}
          expanded={tool === "ai" && aiExpanded}
          onClose={() => {
            setAiExpanded(false);
            closeTool();
          }}
        >
          {visited["preview-media"] && (
            <div
              className="work-tool-pane"
              data-dock-pane="preview-media"
              hidden={tool !== "preview-media"}
            >
              <PreviewMediaPanel
                state={mediaSession.state}
                disabled={browserBusy}
                onCommand={mediaSession.command}
              />
            </div>
          )}
          <div
            className="work-tool-pane chat-tool-pane"
            data-dock-pane="ai"
            hidden={!chatOpen}
          >
            <AiChat
              key={id}
              work={work}
              reload={taskQuery.refresh}
              notify={notify}
              position={position}
              previewReference={previewReference}
              selectedAssets={assets}
              onAddAssets={() => openTool("materials")}
              onPausePreview={() => sendPlayer("pause")}
              suggestion={suggestion}
              visible={chatOpen}
              onClose={() => {
                setAiExpanded(false);
                closeChat();
              }}
              compact={compact}
              expanded={aiExpanded}
              onExpand={() => setAiExpanded((value) => !value)}
              onPreviewWork={(reference) => {
                setAiExpanded(false);
                if (reference) showMessageReference(reference);
              }}
              onRemoveAsset={(id) =>
                setAssets((old) => old.filter((a) => a.id !== id))
              }
            />
          </div>
          {visited.audio && (
            <div
              className="work-tool-pane dock-content"
              data-dock-pane="audio"
              hidden={tool !== "audio"}
            >
              <Suspense fallback={<Loading />}>
                <AudioEditor
                  work={work}
                  visible={tool === "audio"}
                  position={position}
                  disabled={browserBusy}
                  onDirtyChange={onAudioDirtyChange}
                  onSeek={(time) => sendPlayer("seek", { time })}
                  onSaved={() => {
                    syncQuery.refresh();
                    previewQuery.refresh();
                  }}
                />
              </Suspense>
            </div>
          )}
          {visited.composition && (
            <div
              className="work-tool-pane dock-content"
              data-dock-pane="composition"
              hidden={tool !== "composition"}
            >
              <Suspense fallback={<Loading />}>
                <CompositionEditor
                  work={work}
                  visible={tool === "composition"}
                  position={position}
                  disabled={browserBusy}
                  onDirtyChange={onCompositionDirtyChange}
                  onSeek={(time) => sendPlayer("seek", { time })}
                  onSaved={() => {
                    syncQuery.refresh();
                    previewQuery.refresh();
                  }}
                />
              </Suspense>
            </div>
          )}
          {visited.materials && (
            <div
              className="work-tool-pane dock-content"
              data-dock-pane="materials"
              hidden={tool !== "materials"}
            >
              <Materials
                work={work}
                visible={tool === "materials"}
                notify={notify}
                selectedAssets={assets}
                onSelect={addAsset}
                onDone={() => {
                  openTool("ai");
                }}
              />
            </div>
          )}
          {visited.voice && (
            <div
              className="work-tool-pane dock-content"
              data-dock-pane="voice"
              hidden={tool !== "voice"}
            >
              <Voice
                work={work}
                notify={notify}
                position={position}
                onAdopt={(asset, review) => {
                  if (
                    assets.length >= 20 &&
                    !assets.some((a) => a.id === asset.id)
                  ) {
                    notify(
                      "当前已引用 20 个素材，请先移除部分引用再添加配音",
                      "error",
                    );
                    return;
                  }
                  addAsset(asset);
                  setSuggestion({
                    id: randomUUID(),
                    text:
                      "请将配音资源“" +
                      asset.name +
                      "”编排到作品中，保持声画与字幕同步。",
                    review: { ...review, ...previewReference },
                  });
                  openTool("ai");
                }}
              />
            </div>
          )}
          <div
            className="work-tool-pane dock-content"
            data-dock-pane="tasks"
            hidden={tool !== "tasks"}
          >
            <ErrorNote error={taskQuery.error} />
            {taskQuery.error && (
              <Button onClick={taskQuery.refresh}>重试读取任务</Button>
            )}
            {browserJob && (
              <section
                className="export-item local-export"
                aria-label="本机导出任务"
              >
                <div className="row">
                  <strong>本机 WebM</strong>
                  <span>{exportState(browserJob)}</span>
                </div>
                {browserBusy && (
                  <ExportProgress
                    value={browserJob.progress}
                    label="本机导出进度"
                  />
                )}
                <ErrorNote error={browserJob.error} />
                <p>
                  本机导出依赖当前标签页；收起面板不会停止，关闭标签页会中断。
                </p>
                <Button onClick={() => setPanel("exports")}>
                  查看导出详情
                </Button>
              </section>
            )}
            <div className="task-dialog-list">
              <p>
                关闭浏览器后任务继续运行。AI
                创作显示当前阶段；可计量的处理显示实际进度。
              </p>
              {!tasks.length && <p>暂无后台任务</p>}
              {tasks.map((task) => (
                <div className="task-dialog-row" key={task.id}>
                  <div className="row">
                    <strong>{kinds[task.kind] || task.kind}</strong>
                    <span>{states[task.state]}</span>
                    <small>{date(task.created)}</small>
                  </div>
                  <p>{task.progress?.stage || states[task.state]}</p>
                  {active(task) && (
                    <progress
                      aria-label="后台任务进度"
                      max={task.progress?.total || 1}
                      value={
                        task.progress?.total
                          ? task.progress.completed
                          : undefined
                      }
                    />
                  )}
                  {task.progress?.total && (
                    <small>
                      {Math.round(
                        (task.progress.completed / task.progress.total) * 100,
                      )}
                      % · {task.progress.completed}/{task.progress.total}
                    </small>
                  )}
                  {task.error && <ErrorNote error={task.error} />}
                  {task.monitor && (
                    <ErrorNote
                      error={"监控暂时不可用：" + task.monitor.message}
                    />
                  )}
                  {task.state === "publish_failed" && (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await api("task_retry_publish", { id: task.id });
                          taskQuery.refresh();
                        })
                      }
                    >
                      重试保存结果
                    </Button>
                  )}
                  {cancellable(task) && (
                    <Button
                      disabled={busy}
                      icon={Square}
                      onClick={() =>
                        run(async () => {
                          await api("task_cancel", { id: task.id });
                          taskQuery.refresh();
                        })
                      }
                    >
                      停止任务
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
          {visited.sync && (
            <div
              className="work-tool-pane scm-pane"
              data-dock-pane="sync"
              hidden={tool !== "sync"}
            >
              <Suspense fallback={<Loading />}>
                <SourceControl
                  work={work}
                  notify={notify}
                  visible={tool === "sync"}
                  currentPreview={preview?.url}
                  position={position}
                  onPause={() => sendPlayer("pause")}
                  onChange={({ reloadWork = false } = {}) => {
                    syncQuery.refresh();
                    previewQuery.refresh();
                    if (reloadWork) query.refresh();
                    taskQuery.refresh();
                  }}
                />
              </Suspense>
            </div>
          )}
        </WorkDock>
      </div>
      {panel && (
        <Modal
          title={title}
          onClose={() => setPanel("")}
          wide={panel === "exports"}
        >
          {panel === "details" ? (
            <Details work={work} notify={notify} onSave={query.refresh} />
          ) : (
            <Exports
              work={work}
              notify={notify}
              position={position}
              previewReference={previewReference}
              unsavedEditors={Object.entries(editorDirty)
                .filter(([, dirty]) => dirty)
                .map(([key]) => key)}
              onReturnToEditor={(key) => {
                setPanel("");
                openTool(key);
              }}
              previewReady={!!preview && !previewStage && !!position.duration}
              browserJob={browserJob}
              onBrowserExport={(options) => {
                if (browserBusy || !preview || previewStage)
                  throw new Error("请等待播放器就绪或当前导出完成");
                browserExport.start(options, previewReference);
              }}
              onBrowserCancel={browserExport.cancel}
              onBrowserDownload={browserExport.download}
              onSnapshot={() => sendPlayer("snapshot")}
              onSubtitles={() => sendPlayer("subtitles")}
            />
          )}
        </Modal>
      )}
    </div>
  );
}
