import { subscribe } from "./realtime";
import { useEffect, useRef, useState } from "react";
import { PREVIEW_VERSION } from "../server/preview-version.mjs";
import { previewCacheBridge } from "./preview-cache";
import {
  ArrowUp,
  Square,
  Plus,
  MessageSquare,
  ChevronDown,
  X,
  Play,
  RefreshCw,
  PanelLeftClose,
  Columns2,
  Rows2,
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
} from "./ui";
import {
  Materials,
  SyncPanel,
  Versions,
  Details,
  Voice,
  Exports,
} from "./work-panels";

function useEvents(tasks, chat) {
  const cache = useRef({}),
    [events, setEvents] = useState({}),
    [error, setError] = useState("");
  const signature = tasks
    .filter((t) => t.chat === chat)
    .map((t) => t.id + ":" + t.state)
    .join(",");
  useEffect(() => {
    const stops = tasks
      .filter((t) => t.chat === chat)
      .map((task) => {
        const c = (cache.current[task.id] ||= { after: 0, rows: [] });
        return subscribe(
          "task_get",
          { id: task.id, after: c.after },
          ({ result, error }) => {
            if (error) {
              setError(error);
              return;
            }
            const rows = new Map(c.rows.map((row) => [row.id, row]));
            for (const row of result.events) rows.set(row.id, row);
            c.rows = [...rows.values()];
            c.after = Number(c.rows.at(-1)?.id || 0);
            setEvents(
              Object.fromEntries(
                Object.entries(cache.current).map(([id, v]) => [
                  id,
                  [...v.rows],
                ]),
              ),
            );
            setError("");
          },
        );
      });
    const connection = (e) =>
      setError(
        e.detail === "connected"
          ? ""
          : "连接暂时中断，正在重新连接；服务器上的创作会继续。",
      );
    window.addEventListener("frame-connection", connection);
    return () => {
      stops.forEach((stop) => stop());
      window.removeEventListener("frame-connection", connection);
    };
  }, [chat, signature]);
  return { events, error };
}
function Turn({ task, events, onRetry, onStop }) {
  const messages = new Map(),
    activities = new Map();
  let delta = "";
  for (const row of events || []) {
    const e = row.data;
    if (row.kind === "message") {
      messages.set(e.id || row.id, e.text);
      delta = "";
    } else if (row.kind === "summary" && e.text) {
      if (![...messages.values()].includes(e.text))
        messages.set("summary", e.text);
      delta = "";
    } else if (row.kind === "delta") delta += e.text;
    else if (row.kind === "activity") {
      const previous = activities.get(e.id);
      activities.set(e.id || row.id, {
        ...previous,
        ...e,
        text: e.tool === "result" && previous ? previous.text : e.text,
      });
    }
  }
  return (
    <article className="chat-turn">
      <div className="human-message">
        {task.input.prompt}
        {task.input.context?.time !== undefined && (
          <small>审片位置 {task.input.context.time.toFixed(2)} 秒</small>
        )}
      </div>
      <div className="assistant-message">
        <div className="assistant-label">
          <Sparkles size={14} />
          <strong>{states[task.state]}</strong>
          <span>{date(task.created)}</span>
        </div>
        {[...messages].map(([id, text]) => (
          <div className="message-text" key={id}>
            {text}
          </div>
        ))}
        {delta && <div className="message-text streaming">{delta}</div>}
        {activities.size > 0 && (
          <details className="activity-list">
            <summary>
              {active(task) ? "查看正在进行的工作" : "查看制作过程"} ·{" "}
              {activities.size} 项
            </summary>
            {[...activities].slice(-30).map(([id, e]) => (
              <div key={id}>
                <span>
                  {e.phase === "done" ? "✓" : "·"} {e.text}
                </span>
                {e.output && <pre>{e.output}</pre>}
              </div>
            ))}
          </details>
        )}
        {!messages.size && !delta && active(task) && (
          <p className="quiet">
            {task.state === "queued"
              ? "已排队，前一项工作结束后自动开始。"
              : "AI 正在制作作品…"}
          </p>
        )}
        {task.error && (
          <p role="alert" className="error">
            {task.error}
          </p>
        )}
        <div className="row">
          {task.state === "failed" && (
            <Button onClick={() => onRetry(task.input.prompt)}>
              保留上下文重试
            </Button>
          )}
          {active(task) && (
            <Button icon={Square} onClick={() => onStop(task.id)}>
              停止本次创作
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}
export function WorkChat({
  work,
  tasks,
  reload,
  notify,
  position,
  selectedAssets,
  onClearAssets,
}) {
  const chats = useQuery("works_chats", { id: work.id }),
    connections = useQuery("connections_list"),
    [chat, setChat] = useState(""),
    [connection, setConnection] = useState(""),
    [prompt, setPrompt] = useState(
      () => sessionStorage.getItem("draft:" + work.id) || "",
    ),
    [usePosition, setUsePosition] = useState(false),
    [run, busy] = useAction(notify);
  const initialized = useRef(false),
    requestKey = useRef(null),
    messages = useRef(null),
    follow = useRef(true);
  const currentTurns = useQuery(
    chat ? "works_chat_turns" : null,
    { id: work.id, chat, limit: 30 },
    1500,
  );
  const [older, setOlder] = useState([]),
    [more, setMore] = useState(true);
  useEffect(() => {
    setOlder([]);
    setMore(true);
  }, [chat]);
  useEffect(() => {
    if (!initialized.current && chats.data) {
      setChat(chats.data[0]?.id || "");
      initialized.current = true;
    }
  }, [chats.data]);
  useEffect(() => {
    if (!connection && connections.data?.length)
      setConnection(
        connections.data.find((c) => c.configured)?.id ||
          connections.data[0].id,
      );
  }, [connections.data, connection]);
  useEffect(() => {
    sessionStorage.setItem("draft:" + work.id, prompt);
    requestKey.current = null;
  }, [prompt, work.id]);
  const conversationTasks = [
    ...new Map(
      [...older, ...(currentTurns.data || []), ...tasks]
        .filter((t) => t.chat === chat)
        .map((t) => [t.id, t]),
    ).values(),
  ].sort((a, b) => new Date(b.created) - new Date(a.created));
  const stream = useEvents(conversationTasks, chat),
    turns = conversationTasks.toReversed(),
    selected = chats.data?.find((c) => c.id === chat),
    chosen = selected?.connection || connection;
  useEffect(() => {
    if (follow.current && messages.current)
      messages.current.scrollTop = messages.current.scrollHeight;
  }, [stream.events, tasks]);
  const send = async (text = prompt) => {
    requestKey.current ||= crypto.randomUUID();
    await run(async () => {
      let id = chat;
      if (!id) {
        const c = await api("works_chat_create", {
          id: work.id,
          connection: chosen,
          title: text.slice(0, 60),
        });
        id = c.id;
        setChat(id);
        chats.refresh();
      }
      await api("works_chat_send", {
        id: work.id,
        chat: id,
        prompt: text,
        requestKey: requestKey.current,
        context: {
          ...(usePosition ? { time: position.time || 0 } : {}),
          ...(usePosition &&
          position.selection?.start !== undefined &&
          position.selection?.end > position.selection.start
            ? { start: position.selection.start, end: position.selection.end }
            : {}),
          ...(selectedAssets.length
            ? { assets: selectedAssets.map((a) => a.id) }
            : {}),
        },
      });
      requestKey.current = null;
      setPrompt("");
      onClearAssets();
      reload();
      follow.current = true;
    });
  };
  const stop = (id) =>
    run(async () => {
      await api("task_cancel", { id });
      reload();
    });
  return (
    <section className="creation-chat">
      <header className="chat-header">
        <div className="row">
          <MessageSquare size={18} />
          <h2>AI 创作</h2>
        </div>
        <Button
          icon={Plus}
          aria-label="新对话"
          onClick={() => {
            setChat("");
            setPrompt("");
          }}
        >
          新对话
        </Button>
      </header>
      <div className="chat-selectors">
        <select
          aria-label="创作对话"
          value={chat}
          onChange={(e) => setChat(e.target.value)}
        >
          <option value="">新的创作对话</option>
          {chats.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <select
          aria-label="模型连接"
          value={chosen}
          disabled={!!chat}
          onChange={(e) => setConnection(e.target.value)}
        >
          <option value="">选择模型连接</option>
          {connections.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.configured ? "" : " · 未连接"}
            </option>
          ))}
        </select>
      </div>
      <ErrorNote error={chats.error || connections.error} />
      {stream.error && (
        <p className="reconnecting" role="status">
          {stream.error}
        </p>
      )}
      <div
        className="chat-messages"
        ref={messages}
        onScroll={(e) => {
          const t = e.currentTarget;
          follow.current = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
        }}
      >
        <ErrorNote error={currentTurns.error} />
        {more && conversationTasks.length >= 30 && (
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                const page = await api("works_chat_turns", {
                  id: work.id,
                  chat,
                  limit: 30,
                  before: turns[0].id,
                });
                follow.current = false;
                setOlder((previous) => [...previous, ...page]);
                setMore(page.length === 30);
              })
            }
          >
            加载更早的对话
          </Button>
        )}
        {!turns.length && (
          <div className="chat-intro">
            <Sparkles size={27} />
            <h3>从一个想法开始</h3>
            <p>告诉 AI 想表达什么。画面、分镜、声音与节奏，可以边看边调整。</p>
            <div className="suggestions">
              {[
                "先帮我设计这个作品的分镜与风格",
                "制作一段简洁、有节奏的开场动画",
              ].map((s) => (
                <button key={s} onClick={() => setPrompt(s)}>
                  {s}
                </button>
              ))}
            </div>
            {!connections.data?.some((c) => c.configured) && (
              <a href="#/settings">连接创作模型 →</a>
            )}
          </div>
        )}
        {turns.map((t) => (
          <Turn
            key={t.id}
            task={t}
            events={stream.events[t.id]}
            onRetry={send}
            onStop={stop}
          />
        ))}
      </div>
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {selectedAssets.length > 0 && (
          <div className="selected-assets">
            {selectedAssets.map((a) => (
              <span key={a.id}>{a.name}</span>
            ))}
            <Button
              icon={X}
              aria-label="清除素材引用"
              type="button"
              onClick={onClearAssets}
            />
          </div>
        )}
        <textarea
          aria-label="创作要求"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="描述想法，或告诉 AI 这一段怎样调整…"
          rows="4"
          required
          maxLength="40000"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              if (prompt.trim() && !busy) void send();
            }
          }}
        />
        <div className="composer-options">
          <label className="check">
            <input
              type="checkbox"
              checked={usePosition}
              onChange={(e) => setUsePosition(e.target.checked)}
            />
            附带当前画面 {Number(position.time || 0).toFixed(2)}s
          </label>
          <Button
            className="primary"
            icon={ArrowUp}
            disabled={busy || !prompt.trim() || !chosen}
          >
            {busy ? "发送中" : "发送"}
          </Button>
        </div>
        <small>关闭浏览器后继续制作 · Ctrl / ⌘ + Enter 发送</small>
      </form>
    </section>
  );
}

export function Creation({ id, notify, onToggleNav }) {
  const query = useQuery("works_open", { id }),
    taskQuery = useQuery("works_tasks", { id }, 2000),
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
  const latest = tasks.find(
      (t) =>
        t.kind === "build" &&
        t.state === "succeeded" &&
        t.result?.previewVersion === PREVIEW_VERSION &&
        !t.cleaned,
    ),
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
          onClearAssets={() => setAssets([])}
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
