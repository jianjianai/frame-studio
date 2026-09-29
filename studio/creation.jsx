import { WorkChat } from "./work-chat";
import { useEffect, useRef, useState } from "react";
import { PREVIEW_VERSION } from "../server/preview-version.mjs";
import { previewCacheBridge } from "./preview-cache";
import { ResizeHandle } from "../src/ui/ResizeHandle";
import {
  readPreference,
  writePreference,
  boundedPreference,
} from "../src/ui/view-preferences";
import {
  ArrowUp,
  Square,
  Plus,
  MessageSquare,
  ChevronDown,
  X,
  Play,
  RefreshCw,
  MoreHorizontal,
  PanelRightClose,
  History,
  Image,
  Download,
  Info,
  Mic,
  GitPullRequest,
  Sparkles,
  ListTodo,
} from "lucide-react";
import {
  api,
  request,
  useQuery,
  useAction,
  Button,
  Field,
  Modal,
  ErrorNote,
  Loading,
  active,
  states,
  kinds,
  date,
  go,
  useMediaQuery,
} from "./ui";
import {
  Materials,
  SyncPanel,
  Versions,
  Details,
  Voice,
  Exports,
} from "./work-panels";

export function Creation({ id, notify }) {
  const query = useQuery("works_open", { id }),
    taskQuery = useQuery("works_tasks", { id }, 2000),
    syncQuery = useQuery("works_sync_status", { id }, 1),
    tasks = taskQuery.data || [],
    iframe = useRef(null),
    split = useRef(null);
  const [preview, setPreview] = useState(null),
    [previewStage, setPreviewStage] = useState("正在获取作品…"),
    [panel, setPanel] = useState(""),
    [chatOpen, setChatOpen] = useState(() =>
      readPreference("frame.chat-open", window.innerWidth > 900),
    ),
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
  const chatToggle = useRef(null);
  const playerPreferences = useRef(readPreference("frame.player-view", {}));
  const sendPlayer = (command, extra = {}) =>
    iframe.current?.contentWindow?.postMessage(
      { type: "frame-player-command", command, ...extra },
      "*",
    );
  const closeChat = () => {
    setChatOpen(false);
    chatToggle.current?.focus();
  };
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
  const latest = tasks.find(
      (t) =>
        t.kind === "build" &&
        !t.input?.version &&
        t.state === "succeeded" &&
        t.result?.previewVersion === PREVIEW_VERSION &&
        !t.cleaned,
    ),
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
      latest ||
      tasks.some(active) ||
      buildRequested.current
    )
      return;
    buildRequested.current = true;
    api("works_task", { id, kind: "build" })
      .then(taskQuery.refresh)
      .catch((e) => notify(e.message, "error"));
  }, [taskQuery.data, latest?.id, id]);
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
      if (e.data?.type === "frame-player-ready")
        sendPlayer("configure-view", {
          preferences: playerPreferences.current,
        });
      if (e.data?.type === "frame-player-preferences") {
        playerPreferences.current = e.data.preferences;
        writePreference("frame.player-view", e.data.preferences);
      }
      if (e.data?.type === "frame-preview-loading")
        setPreviewStage(e.data.message || "");
      if (
        e.data?.type === "frame-player-state" &&
        typeof e.data.time === "number"
      )
        setPosition(e.data);
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
    writePreference("frame.workspace-split", ratio);
  }, [chatOpen, ratio]);
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
                error: "播放器没有确认导出请求，请刷新预览后重试",
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
      materials: "素材",
      voice: "配音",
      versions: "版本管理",
      exports: "导出",
      details: "作品资料",
      sync: "同步状态",
      tasks: "后台任务",
    }[panel];
  return (
    <div className="creation">
      <header className="creation-toolbar">
        <div className="work-identity">
          <span className="breadcrumb">{work.repository?.name}</span>
          <h1 title={work.title}>{work.title}</h1>
        </div>
        <div className="creation-actions">
          <Button
            icon={GitPullRequest}
            className={
              syncQuery.error || syncQuery.data?.error
                ? "sync-error"
                : syncQuery.data?.ahead ||
                    syncQuery.data?.behind ||
                    syncQuery.data?.dirty
                  ? "sync-attention"
                  : "sync-status"
            }
            aria-label="查看同步状态"
            title={
              syncQuery.error ||
              syncQuery.data?.error ||
              "查看作品保存与同步状态"
            }
            onClick={() => setPanel("sync")}
          >
            {syncQuery.error || syncQuery.data?.error
              ? "同步需处理"
              : syncQuery.data?.dirty
                ? "有未保存修改"
                : syncQuery.data?.behind
                  ? "有远端更新"
                  : syncQuery.data?.ahead
                    ? "待同步 " + syncQuery.data.ahead
                    : syncQuery.data
                      ? syncQuery.data.remote
                        ? "已同步"
                        : "保存在服务器"
                      : "正在检查"}
          </Button>
          <Button
            icon={ListTodo}
            aria-label="后台任务"
            onClick={() => setPanel("tasks")}
          >
            任务{running.length ? " · " + running.length : ""}
          </Button>
          <Button
            icon={MessageSquare}
            ref={chatToggle}
            aria-label={chatOpen ? "关闭 AI 对话" : "打开 AI 对话"}
            aria-controls="work-chat"
            aria-expanded={chatOpen}
            onClick={() => setChatOpen(!chatOpen)}
          >
            AI 对话
          </Button>
          <details className="work-more">
            <summary aria-label="更多作品操作">
              <MoreHorizontal size={19} /> 更多
            </summary>
            <div className="work-more-menu">
              <Button
                icon={RefreshCw}
                disabled={busy || running.some((t) => t.kind === "build")}
                onClick={(event) => {
                  event.currentTarget.closest("details").open = false;
                  void run(async () => {
                    await api("works_task", { id, kind: "build" });
                    taskQuery.refresh();
                  });
                }}
              >
                刷新预览
              </Button>
              {[
                ["materials", Image, "素材"],
                ["voice", Mic, "配音"],
                ["versions", History, "版本"],
                ["details", Info, "作品资料"],
              ].map(([key, Icon, label]) => (
                <Button
                  key={key}
                  icon={Icon}
                  onClick={(event) => {
                    event.currentTarget.closest("details").open = false;
                    setPanel(key);
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>
          </details>
          <Button
            className="primary"
            icon={Download}
            onClick={() => setPanel("exports")}
          >
            {browserBusy ? "正在本机导出" : "导出"}
          </Button>
        </div>
      </header>
      <div
        ref={split}
        className={`creation-split ${chatOpen ? "chat-open" : "chat-closed"} ${dragging ? "dragging" : ""}`}
        style={{
          "--video-share": ratio + "fr",
          "--chat-share": 100 - ratio + "fr",
        }}
      >
        <div
          className="preview-pane"
          inert={compact && chatOpen ? true : undefined}
        >
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
                onLoad={() =>
                  sendPlayer("configure-view", {
                    preferences: playerPreferences.current,
                  })
                }
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
        {chatOpen && (
          <ResizeHandle
            axis="vertical"
            value={ratio}
            min={35}
            max={80}
            containerRef={split}
            onChange={setRatio}
            onDragChange={setDragging}
            label="调整播放器和 AI 区域大小"
          />
        )}
        {chatOpen && (
          <button
            className="chat-scrim"
            aria-label="收起 AI 对话"
            onClick={closeChat}
            tabIndex={-1}
          />
        )}
        <WorkChat
          key={id}
          work={work}
          tasks={tasks}
          reload={taskQuery.refresh}
          notify={notify}
          position={position}
          selectedAssets={assets}
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
          onClearAssets={() => setAssets([])}
        />
      </div>
      {panel && (
        <Modal
          title={title}
          onClose={() => setPanel("")}
          wide={["materials", "exports", "versions"].includes(panel)}
        >
          {panel === "tasks" ? (
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
                  {active(task) && (
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
          ) : panel === "materials" ? (
            <Materials
              work={work}
              notify={notify}
              selectedAssets={assets}
              onSelect={addAsset}
              onDone={() => {
                setPanel("");
                setChatOpen(true);
              }}
            />
          ) : panel === "voice" ? (
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
                setPanel("");
                setChatOpen(true);
              }}
            />
          ) : panel === "versions" ? (
            <Versions
              work={work}
              notify={notify}
              onRestore={() => {
                taskQuery.refresh();
                query.refresh();
              }}
              currentPreview={preview?.url}
              position={position}
              onPause={() => sendPlayer("pause")}
            />
          ) : panel === "details" ? (
            <Details work={work} notify={notify} onSave={query.refresh} />
          ) : panel === "sync" ? (
            <SyncPanel
              work={work}
              notify={notify}
              onChange={syncQuery.refresh}
            />
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
