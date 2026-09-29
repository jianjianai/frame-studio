import { previewMessageSchema } from "../src/contracts/platform.mjs";
import { WorkChat } from "./work-chat";
import { WorkTools } from "./work-tools";
import { WorkDock } from "./work-dock";
import { ExportProgress, exportState } from "./exports";
import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { previewCacheBridge } from "./preview-cache";
import { ResizeHandle } from "../src/ui/ResizeHandle";
import {
  readPreference,
  writePreference,
  boundedPreference,
} from "../src/ui/view-preferences";
import { Square, Play, RefreshCw } from "lucide-react";
import {
  api,
  request,
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
  const [preview, setPreview] = useState(null),
    [previewStage, setPreviewStage] = useState("正在获取作品…"),
    [panel, setPanel] = useState(""),
    [tool, setTool] = useState(() => {
      const fallback = readPreference(
        "frame.chat-open",
        window.innerWidth > 900,
      )
        ? "ai"
        : "";
      const saved = readPreference("frame.work-tool", fallback);
      return ["ai", "materials", "voice", "tasks", "sync", ""].includes(saved)
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
    [requestingBuild, setRequestingBuild] = useState(false),
    [suggestion, setSuggestion] = useState(null),
    [browserJob, setBrowserJob] = useState(null),
    [run, busy] = useAction(notify);
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
  const browserRequest = useRef(null);
  const browserFile = useRef(null);
  useEffect(
    () => () => {
      if (browserFile.current) URL.revokeObjectURL(browserFile.current.url);
    },
    [],
  );
  const browserBusy = ["queued", "running", "cancelling"].includes(
    browserJob?.state,
  );
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
  const playerPreferences = useRef(readPreference("frame.player-view", {}));
  const sendPlayer = (command, extra = {}) =>
    iframe.current?.contentWindow?.postMessage(
      { type: "frame-player-command", command, ...extra },
      "*",
    );
  const closeChat = closeTool;
  const building = tasks.some((task) => task.kind === "build" && active(task));
  const buildRequestPending = useRef(false);
  const updatePreview = async () => {
    if (buildRequestPending.current || busy || building || browserBusy) return;
    buildRequestPending.current = true;
    setRequestingBuild(true);
    try {
      await run(async () => {
        await api("works_task", { id, kind: "build" });
        taskQuery.refresh();
        previewQuery.refresh();
      });
    } finally {
      buildRequestPending.current = false;
      setRequestingBuild(false);
    }
  };
  const updatePreviewRef = useRef(updatePreview);
  updatePreviewRef.current = updatePreview;
  const workContext = useRef(null);
  workContext.current = {
    title: query.data?.title || "作品",
    compact,
    previewStatus:
      building || requestingBuild
        ? "building"
        : previewQuery.error
          ? "unknown"
          : previewQuery.data?.stale
            ? "stale"
            : "ready",
    updateDisabled: busy || building || requestingBuild || browserBusy,
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
  const latest = previewQuery.data?.latest,
    lastPreview = useRef(""),
    buildRequested = useRef(false);
  useEffect(() => {
    if (!latest || latest.id === lastPreview.current || browserBusy) return;
    let cancelled = false;
    request(`/api/tasks/${latest.id}/preview`, { method: "POST" })
      .then((link) => {
        if (!cancelled) {
          setPreview({ ...link, id: latest.id });
          setPreviewStage("正在下载播放器…");
          lastPreview.current = latest.id;
        }
      })
      .catch((e) => notify(e.message, "error"));
    return () => {
      cancelled = true;
    };
  }, [latest?.id, browserBusy]);
  useEffect(() => {
    if (
      !taskQuery.data ||
      !previewQuery.data ||
      latest ||
      tasks.some((t) => t.state === "publish_failed") ||
      tasks.some(active) ||
      buildRequested.current
    )
      return;
    buildRequested.current = true;
    api("works_task", { id, kind: "build" })
      .then(taskQuery.refresh)
      .catch((e) => notify(e.message, "error"));
  }, [taskQuery.data, previewQuery.data, latest?.id, id]);
  useEffect(() => {
    const check = () => previewQuery.refresh();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [id]);
  useEffect(() => {
    const receive = (e) => {
      if (e.source !== iframe.current?.contentWindow) return;
      if (
        e.data?.type === "frame-export-state" &&
        e.data.id === browserRequest.current
      ) {
        const { type, blob, ...state } = e.data;
        if (blob instanceof Blob && state.state === "succeeded") {
          if (browserFile.current) URL.revokeObjectURL(browserFile.current.url);
          browserFile.current = {
            url: URL.createObjectURL(blob),
            name: state.filename,
          };
        }
        setBrowserJob(state);
        if (state.state === "failed")
          notify(state.error || "本机导出失败", "error");
      }
      if (e.data?.type === "frame-download-error")
        notify(e.data.message, "error");
      if (e.data?.type === "frame-player-ready") {
        sendPlayer("configure-view", {
          preferences: playerPreferences.current,
        });
        sendPlayer("configure-work", { context: workContext.current });
      }
      if (e.data?.type === "frame-player-preferences") {
        playerPreferences.current = e.data.preferences;
        writePreference("frame.player-view", e.data.preferences);
      }
      const message = previewMessageSchema.safeParse(e.data);
      if (
        message.success &&
        message.data.type === "frame-preview-update-request"
      )
        void updatePreviewRef.current();
      if (message.success && message.data.type === "frame-preview-loading")
        setPreviewStage(message.data.message);
      if (message.success && message.data.type === "frame-player-state")
        setPosition(message.data);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(
    () => (preview ? previewCacheBridge(iframe, preview.url) : undefined),
    [preview?.url],
  );
  useEffect(() => {
    writePreference("frame.chat-open", chatOpen);
    writePreference("frame.work-tool", tool);
    writePreference("frame.workspace-split", ratio);
  }, [tool, ratio]);
  useEffect(() => {
    if (!latest || browserBusy) return;
    let cancelled = false;
    const timer = setInterval(
      () =>
        request("/api/tasks/" + latest.id + "/preview", { method: "POST" })
          .then((link) => {
            if (!cancelled) setPreview({ ...link, id: latest.id });
          })
          .catch(() => {}),
      20 * 60000,
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [latest?.id, browserBusy]);
  useEffect(() => {
    if (!browserBusy) return;
    const protect = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [browserBusy]);
  useEffect(() => {
    if (browserJob?.state !== "queued") return;
    const id = browserJob.id;
    const timer = setTimeout(
      () =>
        setBrowserJob((previous) =>
          previous?.id === id && previous.state === "queued"
            ? {
                ...previous,
                state: "failed",
                error: "播放器没有确认导出请求，请更新预览后重试",
              }
            : previous,
        ),
      15000,
    );
    return () => clearTimeout(timer);
  }, [browserJob?.id, browserJob?.state]);
  if (query.loading && !query.data) return <Loading />;
  if (query.error) return <ErrorNote error={query.error} />;
  const work = query.data;
  if (!work) return null;
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
          {preview && Number(latest?.result?.previewVersion || 0) < 9 && (
            <div className="preview-version-note" role="status">
              当前预览使用旧版播放器。
              <Button
                icon={RefreshCw}
                disabled={busy || building || requestingBuild || browserBusy}
                onClick={() => void updatePreview()}
              >
                {building || requestingBuild ? "正在更新预览" : "更新预览"}
              </Button>
            </div>
          )}
          {preview ? (
            <>
              {previewStage && (
                <div className="preview-loading" role="status">
                  <span>{previewStage}</span>
                  <progress aria-label="作品加载进度" />
                  <small>首次打开需要下载画面资源，请稍候。</small>
                </div>
              )}
              <iframe
                ref={iframe}
                title="作品播放器"
                src={preview.url}
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
              <p>
                {running.length ? "正在准备作品预览…" : "还没有可播放的预览"}
              </p>
              <ErrorNote error={previewQuery.error || taskQuery.error} />
              <Button
                icon={RefreshCw}
                disabled={busy || building || requestingBuild || browserBusy}
                onClick={() => void updatePreview()}
              >
                {building || requestingBuild ? "正在更新预览" : "更新预览"}
              </Button>
              {tasks.find(
                (t) => t.kind === "build" && t.state === "failed",
              ) && (
                <ErrorNote
                  error={
                    tasks.find(
                      (t) => t.kind === "build" && t.state === "failed",
                    ).error
                  }
                />
              )}
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
        <WorkDock tool={tool} compact={compact} onClose={closeTool}>
          <div
            className="work-tool-pane chat-tool-pane"
            data-dock-pane="ai"
            hidden={!chatOpen}
          >
            <WorkChat
              embedded
              key={id}
              work={work}
              tasks={tasks}
              reload={taskQuery.refresh}
              notify={notify}
              position={position}
              selectedAssets={assets}
              onAddAssets={() => openTool("materials")}
              onPausePreview={() => sendPlayer("pause")}
              suggestion={suggestion}
              visible={chatOpen}
              onClose={closeChat}
              compact={compact}
              onRecall={(context) => {
                sendPlayer("seek", {
                  time: context.start ?? context.time ?? 0,
                  ...(context.end > context.start
                    ? { selection: { start: context.start, end: context.end } }
                    : {}),
                });
                if (compact) closeChat();
              }}
              onRemoveAsset={(id) =>
                setAssets((old) => old.filter((a) => a.id !== id))
              }
              onClearAssets={(ids) =>
                setAssets((current) =>
                  ids ? current.filter((asset) => !ids.includes(asset.id)) : [],
                )
              }
            />
          </div>
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
                    id: crypto.randomUUID(),
                    text:
                      "请将配音资源“" +
                      asset.name +
                      "”编排到作品中，保持声画与字幕同步。",
                    review,
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
                  <p>
                    {task.progress?.stage ||
                      (task.kind === "agent" && active(task)
                        ? "AI 正在分析和制作作品"
                        : states[task.state])}
                  </p>
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
              previewReady={!!preview && !previewStage && !!position.duration}
              browserJob={browserJob}
              onBrowserExport={(options) => {
                if (browserBusy || !preview || previewStage)
                  throw new Error("请等待播放器就绪或当前导出完成");
                const id = crypto.randomUUID();
                browserRequest.current = id;
                setBrowserJob({ id, state: "queued" });
                sendPlayer("export-start", { id, options });
              }}
              onBrowserCancel={() => {
                sendPlayer("export-cancel");
                setBrowserJob((previous) => ({
                  ...previous,
                  state: "cancelling",
                }));
              }}
              onBrowserDownload={() => {
                if (browserFile.current) {
                  const a = document.createElement("a");
                  a.href = browserFile.current.url;
                  a.download = browserFile.current.name;
                  a.click();
                } else
                  notify("本机导出文件已不在当前标签页中，请重新导出", "error");
              }}
              onSnapshot={() => sendPlayer("snapshot")}
              onSubtitles={() => sendPlayer("subtitles")}
            />
          )}
        </Modal>
      )}
    </div>
  );
}
