import { previewMessageSchema } from "../src/contracts/platform.mjs";

import { useEffect, useRef, useState } from "react";
import { previewCacheBridge } from "./preview-cache";
import { ArrowUp, Square, Play, RefreshCw, PanelLeftClose, Columns2, Rows2, History, Image, Download, Info, Mic, GitPullRequest, ListTodo } from "lucide-react";
import { api, request, useQuery, useAction, Button, Modal, ErrorNote, Loading, active, cancellable, states, kinds, date } from "./ui";
import { Materials, SyncPanel, Versions, Details, Voice, Exports } from "./work-panels";
import { WorkChat } from "./work-chat";
export { WorkChat } from "./work-chat";

export function Creation({ id, notify, onToggleNav }) {
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
    [layout, setLayout] = useState(
      () => localStorage.getItem("frame.layout") || "columns",
    ),
    [ratio, setRatio] = useState(() =>
      Number(localStorage.getItem("frame.ratio") || 62),
    ),
    [dragging, setDragging] = useState(false),
    [position, setPosition] = useState({ time: 0 }),
    [assets, setAssets] = useState([]),
    [run, busy] = useAction(notify);
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
    if (!latest || latest.id === lastPreview.current) return;
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
  }, [latest?.id]);
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
    const check = () => {
      if (!document.hidden) api("works_preview_status", { id, refresh: true })
        .then(previewQuery.refresh).catch(() => previewQuery.refresh());
    };
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [id]);
  useEffect(() => {
    const receive = (e) => {
      if (e.source !== iframe.current?.contentWindow) return;
      const message = previewMessageSchema.safeParse(e.data);
      if (!message.success) return;
      if (message.data.type === "frame-preview-loading") setPreviewStage(message.data.message);
      if (message.data.type === "frame-player-state") setPosition(message.data);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(
    () => (preview ? previewCacheBridge(iframe, preview.url) : undefined),
    [preview?.url],
  );
  useEffect(() => {
    localStorage.setItem("frame.layout", layout);
    localStorage.setItem("frame.ratio", String(ratio));
  }, [layout, ratio]);
  useEffect(() => {
    if (!latest) return;
    const timer = setInterval(
      () =>
        request("/api/tasks/" + latest.id + "/preview", { method: "POST" })
          .then((link) => setPreview({ ...link, id: latest.id }))
          .catch(() => {}),
      20 * 60000,
    );
    return () => clearInterval(timer);
  }, [latest?.id]);
  const drag = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const move = (e) => {
    if (!dragging) return;
    const rect = split.current.getBoundingClientRect();
    setRatio(
      Math.max(
        30,
        Math.min(
          78,
          layout === "columns" && window.innerWidth > 760
            ? ((e.clientX - rect.left) / rect.width) * 100
            : ((e.clientY - rect.top) / rect.height) * 100,
        ),
      ),
    );
  };
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
        <div className="row">
          <Button
            icon={PanelLeftClose}
            aria-label="收起或展开导航"
            onClick={onToggleNav}
          />
          <div>
            <a className="breadcrumb" href={"#/repository/" + work.repo}>
              {work.repository?.name}
            </a>
            <h1>{work.title}</h1>
          </div>
        </div>
        <div className="creation-actions">
          <Button
            icon={RefreshCw}
            disabled={busy || running.some((t) => t.kind === "build")}
            onClick={() =>
              run(async () => {
                await api("works_task", { id, kind: "build" });
                taskQuery.refresh();
              })
            }
          >
            刷新预览
          </Button>
          <Button icon={ListTodo} onClick={() => setPanel("tasks")}>
            后台任务{running.length ? ` · ${running.length}` : ""}
          </Button>

          {[
            ["sync", GitPullRequest, "同步"],
            ["materials", Image, "素材"],
            ["voice", Mic, "配音"],
            ["versions", History, "版本"],
            ["exports", Download, "导出"],
            ["details", Info, "资料"],
          ].map(([key, Icon, label]) => (
            <Button
              key={key}
              icon={Icon}
              title={
                key === "sync"
                  ? syncQuery.error || syncQuery.data?.error || label
                  : label
              }
              className={
                key === "sync" &&
                (syncQuery.data?.ahead ||
                  syncQuery.data?.behind ||
                  syncQuery.data?.dirty)
                  ? "sync-attention"
                  : undefined
              }
              onClick={() => setPanel(key)}
            >
              <span>
                {label}
                {key === "sync" && (
                  <>
                    {syncQuery.data?.ahead > 0 && ` ↑${syncQuery.data.ahead}`}
                    {syncQuery.data?.behind > 0 && ` ↓${syncQuery.data.behind}`}
                    {syncQuery.data?.dirty > 0 &&
                      ` 待保存 ${syncQuery.data.dirty}`}
                  </>
                )}
              </span>
            </Button>
          ))}
          <Button
            icon={layout === "columns" ? Rows2 : Columns2}
            aria-label="切换左右或上下布局"
            onClick={() => setLayout(layout === "columns" ? "rows" : "columns")}
          />
        </div>
      </header>
      <div
        ref={split}
        className={`creation-split ${layout} ${dragging ? "dragging" : ""}`}
        style={{ "--split": ratio + "%" }}
      >
        <div className="preview-pane">
          {(previewQuery.error || (preview && previewQuery.data?.stale)) && (
            <div className="preview-version-note" role="status">
              {previewQuery.error ? "暂时无法核对预览版本：" + previewQuery.error : "当前播放的是旧版本；最新修改尚未生成预览，请点击「刷新预览」。"}
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
        <div
          className="splitter"
          role="separator"
          aria-label="调整播放器和 AI 区域大小"
          aria-orientation={layout === "columns" ? "vertical" : "horizontal"}
          aria-valuenow={Math.round(ratio)}
          aria-valuemin={30}
          aria-valuemax={78}
          tabIndex="0"
          onPointerDown={drag}
          onPointerMove={move}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onKeyDown={(e) => {
            if (
              ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(
                e.key,
              )
            ) {
              e.preventDefault();
              setRatio((r) =>
                Math.max(
                  30,
                  Math.min(
                    78,
                    r + (["ArrowLeft", "ArrowUp"].includes(e.key) ? -2 : 2),
                  ),
                ),
              );
            }
          }}
        >
          <i />
        </div>
        <WorkChat
          key={id}
          work={work}
          tasks={tasks}
          reload={taskQuery.refresh}
          notify={notify}
          position={position}
          selectedAssets={assets}
          onClearAssets={(ids) => setAssets((current) => ids ? current.filter((asset) => !ids.includes(asset.id)) : [])}
        />
      </div>
      {panel && (
        <Modal
          title={title}
          onClose={() => setPanel("")}
          wide={["materials", "exports"].includes(panel)}
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
                  {task.monitor && <ErrorNote error={"监控暂时不可用：" + task.monitor.message} />}
                  {task.state === "publish_failed" && (
                    <Button disabled={busy} onClick={() => run(async () => { await api("task_retry_publish", { id: task.id }); taskQuery.refresh(); })}>重试保存结果</Button>
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
          ) : panel === "materials" ? (
            <Materials
              work={work}
              notify={notify}
              onSelect={(a) =>
                setAssets((old) =>
                  old.some((x) => x.id === a.id) ? old : [...old, a],
                )
              }
            />
          ) : panel === "voice" ? (
            <Voice work={work} notify={notify} />
          ) : panel === "versions" ? (
            <Versions
              work={work}
              notify={notify}
              onRestore={taskQuery.refresh}
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
              onBrowserExport={() => {
                iframe.current?.contentWindow?.postMessage(
                  { type: "frame-player-command", command: "export" },
                  "*",
                );
                setPanel("");
              }}
            />
          )}
        </Modal>
      )}
    </div>
  );
}
