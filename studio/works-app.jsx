import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Film,
  Images,
  Settings,
  Plus,
  LogOut,
  ArrowLeft,
  ArrowUpRight,
  Play,
  RefreshCw,
  Copy,
  Trash2,
  Download,
  FolderGit2,
  AudioLines,
  ListChecks,
  Search,
  X,
} from "lucide-react";
import {
  request,
  api,
  time,
  bytes,
  labels,
  kinds,
  Button,
  Field,
  Empty,
  readableAgentEvents,
  GitPanel,
  Editor,
  SpeechPage,
  SettingsPage,
} from "./components";
import "./style.css";
import "./works.css";
const statusNames = { draft: "制作中", review: "待审片", finished: "已完成" };
const active = (t) => ["queued", "running", "cancelling"].includes(t.state);
const route = () => location.hash.slice(2).split("/");
const go = (value) => {
  location.hash = "/" + value;
};

function App() {
  const [signed, setSigned] = useState(null),
    [parts, setParts] = useState(route),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(0),
    [works, setWorks] = useState([]),
    [tasks, setTasks] = useState([]),
    [modal, setModal] = useState(false);
  const run = async (fn) => {
    setError("");
    setBusy((n) => n + 1);
    try {
      return await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy((n) => n - 1);
    }
  };
  const refresh = useCallback(async () => {
    const [w, t] = await Promise.all([api("works_list"), api("tasks_list")]);
    setWorks(w);
    setTasks(t);
  }, []);
  useEffect(() => {
    request("/api/me")
      .then(() => setSigned(true))
      .catch(() => setSigned(false));
    const on = () => setParts(route());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    if (!signed) return;
    refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => refresh().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [signed, refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);
  if (signed === null)
    return (
      <div className="login">
        <p>正在打开作品库…</p>
      </div>
    );
  if (!signed)
    return (
      <div className="login">
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            const password = new FormData(e.currentTarget).get("password");
            run(async () => {
              await request("/api/login", {
                method: "POST",
                body: JSON.stringify({ password }),
              });
              setSigned(true);
            });
          }}
        >
          <div className="brand">
            <span>◒</span> FRAME
          </div>
          <h1>每一个想法，都是作品的开始。</h1>
          <p>登录你的私人创作空间。</p>
          <Field label="管理员密码">
            <input
              name="password"
              aria-label="管理员密码"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <Button className="primary" disabled={busy > 0}>
            进入作品库 <ArrowUpRight size={16} />
          </Button>
        </form>
      </div>
    );
  const [page = "works", id] = parts,
    w = works.find((w) => w.id === id);
  return (
    <div className="shell">
      <aside className="platform-sidebar">
        <a className="brand" href="#/works">
          <span>◒</span> FRAME
        </a>
        <span className="workspace-label">我的创作空间</span>
        <nav>
          {[
            ["works", "作品库", Film],
            ["assets", "素材库", Images],
            ["tasks", "后台任务", ListChecks],
            ["settings", "设置", Settings],
          ].map(([key, label, Icon]) => (
            <button
              key={key}
              className={
                page === key || (page === "work" && key === "works")
                  ? "active"
                  : ""
              }
              onClick={() => go(key)}
            >
              <Icon size={18} />
              {label}
              {key === "tasks" && tasks.some(active) && <i />}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="avatar">F</div>
          <div>
            私人工作室<small>单用户空间</small>
          </div>
          <Button
            aria-label="退出登录"
            onClick={() =>
              run(async () => {
                await request("/api/logout", { method: "POST" });
                setSigned(false);
              })
            }
          >
            <LogOut size={16} />
          </Button>
        </div>
      </aside>
      <main className={page === "work" ? "work-main" : ""}>
        <header className="platform-header">
          <div className="breadcrumb">
            <span>工作室 /</span>
            <strong>
              {page === "work"
                ? w?.title || "作品"
                : {
                    works: "作品库",
                    assets: "素材库",
                    tasks: "后台任务",
                    settings: "设置",
                  }[page] || "作品库"}
            </strong>
          </div>
          <span className="online">
            <i />
            {tasks.filter(active).length
              ? `${tasks.filter(active).length} 项工作正在继续`
              : "随时开始创作"}
          </span>
        </header>
        {error && (
          <div className="banner error" role="alert">
            {error}
            <button aria-label="关闭错误" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="banner notice" role="status">
            {notice}
          </div>
        )}
        <div className="content">
          {(page === "works" ||
            !["work", "assets", "settings", "tasks"].includes(page)) && (
            <WorksLibrary
              works={works}
              run={run}
              refresh={refresh}
              setModal={setModal}
              setNotice={setNotice}
            />
          )}
          {page === "work" &&
            (w ? (
              <WorkStudio
                key={id}
                work={w}
                run={run}
                refresh={refresh}
                setNotice={setNotice}
              />
            ) : (
              <Empty>
                正在载入作品；回收站中的作品需恢复后打开。
                <Button onClick={() => go("works")}>返回作品库</Button>
              </Empty>
            ))}
          {page === "assets" && (
            <Materials run={run} setNotice={setNotice} works={works} />
          )}
          {page === "settings" && (
            <PlatformSettings
              run={run}
              setNotice={setNotice}
              refresh={refresh}
            />
          )}
          {page === "tasks" && (
            <>
              <div className="heading">
                <div>
                  <span className="eyebrow">BACKGROUND WORK</span>
                  <h1>后台任务</h1>
                  <p>关闭浏览器后，服务器上的工作仍会继续。</p>
                </div>
              </div>
              <TaskResults
                tasks={tasks}
                run={run}
                refresh={refresh}
                works={works}
              />
            </>
          )}
        </div>
      </main>
      {modal && (
        <div className="overlay">
          <div className="modal">
            <div className="section-head">
              <h2>新建作品</h2>
              <Button aria-label="关闭" onClick={() => setModal(false)}>
                <X size={18} />
              </Button>
            </div>
            <NewWork
              run={run}
              onCreate={async (work) => {
                setModal(false);
                await refresh();
                go("work/" + work.id);
                setNotice("作品已创建，写下你的想法开始创作。");
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
function WorkStudio({ work, run, refresh, setNotice }) {
  const previewElement = useRef(null);
  const [previewHeight, setPreviewHeight] = useState(750);
  useEffect(() => {
    const resize = (event) => {
      if (
        event.source === previewElement.current?.contentWindow &&
        event.data?.type === "frame-preview-height" &&
        Number.isFinite(event.data.height)
      )
        setPreviewHeight(Math.min(2500, Math.max(400, event.data.height)));
    };
    window.addEventListener("message", resize);
    return () => window.removeEventListener("message", resize);
  }, []);
  const [tasks, setTasks] = useState([]),
    [tab, setTab] = useState("materials"),
    [preview, setPreview] = useState(""),
    [previewTask, setPreviewTask] = useState("");
  const load = useCallback(
    () => api("works_tasks", { id: work.id }).then(setTasks),
    [work.id],
  );
  useEffect(() => {
    load().catch(() => {});
    const t = setInterval(() => load().catch(() => {}), 2500);
    return () => clearInterval(t);
  }, [load]);
  const latest = tasks.find(
    (t) =>
      t.kind === "build" &&
      t.state === "succeeded" &&
      t.result?.previewVersion === 3,
  );
  useEffect(() => {
    if (!latest || latest.id === previewTask) return;
    let disposed = false;
    request("/api/tasks/" + latest.id + "/preview", { method: "POST" })
      .then((v) => {
        if (!disposed) {
          setPreview(v.url);
          setPreviewTask(latest.id);
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [latest?.id]);
  const createTask = async (kind, input = {}) => {
    await api("works_task", { id: work.id, kind, input });
    await load();
  };
  useEffect(() => {
    api("works_tasks", { id: work.id })
      .then((ts) => {
        if (
          !ts.some(active) &&
          !ts.some(
            (t) =>
              t.kind === "build" &&
              t.state === "succeeded" &&
              t.result?.previewVersion === 3,
          )
        )
          return run(() => createTask("build"));
      })
      .catch(() => {});
  }, []);
  const pending = tasks.find(active),
    changed = latest && new Date(work.modified) > new Date(latest.started);
  return (
    <>
      <div className="work-heading">
        <div>
          <button className="text-button" onClick={() => go("works")}>
            <ArrowLeft size={15} /> 作品库
          </button>
          <h1>
            {work.title}
            <span className={"badge " + work.status}>
              {statusNames[work.status]}
            </span>
          </h1>
          <p>
            {work.category || "未分类"} · {work.duration}s · {work.fps} fps
          </p>
        </div>
        <div className="row">
          <Button
            icon={RefreshCw}
            disabled={!!pending}
            onClick={() => run(() => createTask("build"))}
          >
            更新预览
          </Button>
          <Button
            className="primary"
            icon={Download}
            onClick={() => setTab("exports")}
          >
            导出作品
          </Button>
        </div>
      </div>
      <div className="creation-layout">
        <section className="creation-work">
          <div className="preview-surface">
            <div className="preview-caption">
              <span>作品预览</span>
              <small>
                {pending
                  ? `${kinds[pending.kind]} · ${labels[pending.state]}`
                  : changed
                    ? "内容已更新，可重新生成预览"
                    : latest
                      ? "最新预览 · " + time(latest.finished)
                      : "正在准备画面"}
              </small>
            </div>
            {preview ? (
              <iframe
                ref={previewElement}
                style={{ height: previewHeight }}
                className="work-preview-frame"
                title={"作品预览：" + work.title}
                src={preview}
                sandbox="allow-scripts"
                allow="autoplay; fullscreen"
              />
            ) : (
              <div className="preview-empty">
                <Film size={42} />
                <p>{pending ? "正在为作品准备画面…" : "预览尚未生成"}</p>
                {!pending && (
                  <Button onClick={() => run(() => createTask("build"))}>
                    生成预览
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="work-tabs tabs">
            {[
              ["materials", "素材"],
              ["voice", "配音"],
              ["exports", "导出"],
              ["versions", "版本"],
              ["details", "作品资料"],
              ["source", "源码"],
            ].map(([v, l]) => (
              <button
                key={v}
                className={tab === v ? "active" : ""}
                onClick={() => setTab(v)}
              >
                {l}
              </button>
            ))}
          </div>
          <div className="work-tab-content">
            {tab === "materials" && (
              <Materials work={work} run={run} setNotice={setNotice} />
            )}
            {tab === "voice" && (
              <WorkVoice work={work} run={run} setNotice={setNotice} />
            )}
            {tab === "exports" && (
              <>
                <div className="section-head">
                  <div>
                    <h2>导出与审片</h2>
                    <p>任务在后台完成，结果保存在作品中。</p>
                  </div>
                </div>
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    run(() =>
                      createTask(f.get("kind"), {
                        width: Number(f.get("width")),
                      }),
                    );
                  }}
                >
                  <select name="kind" aria-label="导出内容">
                    <option value="render">MP4 视频</option>
                    <option value="storyboard">分镜预览</option>
                    <option value="frame">首帧图片</option>
                  </select>
                  <select name="width" aria-label="导出分辨率">
                    <option value="1280">720p</option>
                    <option value="1920">1080p</option>
                    <option value="3840">4K</option>
                  </select>
                  <Button className="primary" disabled={!!pending}>
                    开始导出
                  </Button>
                </form>
                <TaskResults
                  tasks={tasks.filter((t) =>
                    ["render", "storyboard", "frame", "validate"].includes(
                      t.kind,
                    ),
                  )}
                  run={run}
                  refresh={load}
                />
              </>
            )}
            {tab === "versions" && (
              <Versions
                work={work}
                run={run}
                setNotice={setNotice}
                refresh={async () => {
                  await refresh();
                  await load();
                }}
              />
            )}
            {tab === "details" && (
              <WorkDetails
                work={work}
                run={run}
                refresh={refresh}
                setNotice={setNotice}
              />
            )}
            {tab === "source" && (
              <Editor
                repo={work.repo}
                project={work.project}
                run={run}
                setNotice={setNotice}
              />
            )}
          </div>
        </section>
        <WorkChat
          work={work}
          tasks={tasks}
          run={run}
          reload={load}
          setNotice={setNotice}
        />
      </div>
    </>
  );
}
function WorkChat({ work, tasks, run, reload, setNotice }) {
  const [chats, setChats] = useState([]),
    [chat, setChat] = useState(""),
    [provider, setProvider] = useState("codex"),
    [prompt, setPrompt] = useState(""),
    [stream, setStream] = useState({}),
    [sending, setSending] = useState(false),
    [configured, setConfigured] = useState({});
  const cache = useRef({});
  const load = async () => {
    const rows = await api("works_chats", { id: work.id });
    setChats(rows);
  };
  useEffect(() => {
    api("works_chats", { id: work.id })
      .then((rows) => {
        setChats(rows);
        setChat(rows[0]?.id || "");
      })
      .catch(() => {});
    api("settings_get")
      .then(setConfigured)
      .catch(() => {});
  }, [work.id]);
  const turns = tasks.filter((t) => t.chat === chat).toReversed();
  useEffect(() => {
    let done = false;
    const update = async () => {
      for (const t of tasks.filter((t) => t.chat === chat).slice(0, 20)) {
        const c = cache.current[t.id] || {
          after: 0,
          events: [],
          finished: false,
        };
        if (c.finished) continue;
        let page;
        do {
          page = (await api("task_get", { id: t.id, after: c.after })).events;
          c.events.push(...page);
          c.after = Number(c.events.at(-1)?.id || 0);
        } while (page.length === 100);
        c.finished = !active(t);
        cache.current[t.id] = c;
      }
      if (!done)
        setStream(
          Object.fromEntries(
            Object.entries(cache.current).map(([id, c]) => [id, c.events]),
          ),
        );
    };
    update().catch(() => {});
    const timer = setInterval(() => update().catch(() => {}), 2500);
    return () => {
      done = true;
      clearInterval(timer);
    };
  }, [chat, tasks.map((t) => t.id + t.state).join(",")]);
  const chosen = chats.find((c) => c.id === chat)?.provider || provider,
    running = tasks.find(active);
  return (
    <section className="work-chat panel">
      <div className="section-head">
        <h2>一起创作</h2>
        <span className="badge">AI</span>
      </div>
      <div className="row">
        <select
          aria-label="创作工具"
          value={chosen}
          disabled={!!chat}
          onChange={(e) => setProvider(e.target.value)}
        >
          <option value="codex">Codex</option>
          <option value="claude">Claude Code</option>
        </select>
        <Button
          aria-label="新对话"
          onClick={() => {
            setChat("");
            setPrompt("");
          }}
        >
          新对话
        </Button>
      </div>
      {chats.length > 0 && (
        <select
          aria-label="作品对话"
          value={chat}
          onChange={(e) => setChat(e.target.value)}
        >
          <option value="">新的创作对话</option>
          {chats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      )}
      <div className="messages">
        {!turns.length && (
          <div className="chat-welcome">
            <Film size={30} />
            <h3>这个作品，你想怎样开始？</h3>
            <p>
              描述画面、角色和故事。也可以先上传参考素材，再让 AI 使用它们。
            </p>
            {!configured[chosen]?.configured && (
              <a href="#/settings">
                先在设置中连接 {chosen === "codex" ? "Codex" : "Claude Code"} →
              </a>
            )}
          </div>
        )}
        {turns.map((t) => (
          <div className="turn" key={t.id}>
            <div className="user-message">{t.input.prompt}</div>
            <div className="agent-message">
              <span className={"badge " + t.state}>{labels[t.state]}</span>
              <pre>
                {readableAgentEvents(stream[t.id] || []) ||
                  (active(t) ? "正在准备创作…" : "")}
              </pre>
              {t.error && <p className="error">{t.error}</p>}
            </div>
          </div>
        ))}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          setSending(true);
          run(async () => {
            let id = chat;
            if (!id) {
              const c = await api("works_chat_create", {
                id: work.id,
                provider,
                title: prompt.slice(0, 40),
              });
              id = c.id;
              setChat(id);
              await load();
            }
            await api("chats_send", { id, prompt });
            setPrompt("");
            await reload();
            setNotice("创作已在服务器开始，关闭浏览器后仍会继续。");
          }).finally(() => setSending(false));
        }}
      >
        <textarea
          aria-label="创作要求"
          rows="4"
          placeholder="描述想法，或告诉 AI 继续怎样修改…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
        />
        <div className="row">
          <small>对话和工作进度持续保存</small>
          {running ? (
            <Button
              type="button"
              onClick={() =>
                run(async () => {
                  await api("task_cancel", { id: running.id });
                  await reload();
                })
              }
            >
              停止任务
            </Button>
          ) : (
            <Button
              className="primary"
              disabled={
                sending || !prompt.trim() || !configured[chosen]?.configured
              }
            >
              开始创作 <ArrowUpRight size={15} />
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
function Materials({ work, works = [], run, setNotice }) {
  const [items, setItems] = useState([]),
    [filter, setFilter] = useState(work ? "work" : "all"),
    [search, setSearch] = useState(""),
    [target, setTarget] = useState("");
  const load = async () =>
    setItems(
      await api(
        work && filter === "work" ? "works_assets" : "assets_list",
        work && filter === "work"
          ? { id: work.id }
          : {
              unused: filter === "unused",
              deleted: filter === "trash",
              search,
            },
      ),
    );
  useEffect(() => {
    run(load);
  }, [filter, search, work?.id]);
  const targetId = work?.id || target;
  return (
    <>
      <div className="section-head">
        <div>
          {!work && <span className="eyebrow">MATERIAL LIBRARY</span>}
          {work ? <h2>作品素材</h2> : <h1>素材库</h1>}
          <p>
            {work
              ? "这里的素材会随作品一起保存和同步。"
              : "统一管理素材，查看它们被哪些作品使用。"}
          </p>
        </div>
      </div>
      <form
        className="panel upload-form"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          run(async () => {
            const a = await request("/api/upload", {
              method: "POST",
              body: new FormData(form),
            });
            if (work)
              await api("works_use_asset", { id: work.id, asset: a.id });
            form.reset();
            await load();
            setNotice(work ? "素材已上传到当前作品" : "素材已上传");
          });
        }}
      >
        <Field label="文件">
          <input type="file" name="file" required />
        </Field>
        <Field label="来源 / 许可">
          <input name="license" placeholder="原创 / 已获授权" required />
        </Field>
        <Field label="标签">
          <input name="tags" placeholder="人物、背景、音效" />
        </Field>
        <Button className="primary">上传素材</Button>
      </form>
      <div className="works-toolbar">
        <div className="tabs">
          {[
            ...(work ? [["work", "当前作品"]] : []),
            ["all", "全部素材"],
            ["unused", "未被作品引用"],
            ["trash", "回收站"],
          ].map(([v, l]) => (
            <button
              key={v}
              className={filter === v ? "active" : ""}
              onClick={() => setFilter(v)}
            >
              {l}
            </button>
          ))}
        </div>
        <input
          aria-label="搜索素材"
          placeholder="搜索素材或标签"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {!work && (
        <Field label="使用到作品">
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">选择作品</option>
            {works.map((w) => (
              <option key={w.id} value={w.id}>
                {w.title}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!items.length ? (
        <Empty>
          {filter === "work"
            ? "上传参考图、配音或音乐，让故事更具体。"
            : "没有符合条件的素材"}
        </Empty>
      ) : (
        <div className="asset-grid">
          {items
            .filter((a) => !search || (a.name + " " + a.tags).includes(search))
            .map((a) => (
              <article className="panel asset" key={a.id}>
                <div className="asset-visual">
                  {a.mime.startsWith("image/") && !a.deleted ? (
                    <img src={"/api/assets/" + a.id + "/file"} alt={a.name} />
                  ) : a.mime.startsWith("audio/") ? (
                    <AudioLines size={32} />
                  ) : (
                    <Images size={32} />
                  )}
                </div>
                <h3>{a.name}</h3>
                <small>
                  {bytes(a.bytes)} · {a.license}
                </small>
                {a.mime.startsWith("audio/") && !a.deleted && (
                  <audio controls src={"/api/assets/" + a.id + "/file"} />
                )}
                <div className="asset-references">
                  {a.refs.length ? (
                    a.refs.map((r) => (
                      <a
                        key={r.repo + r.project}
                        href={
                          r.work && !r.deleted ? "#/work/" + r.work : undefined
                        }
                      >
                        {r.title}
                        {r.deleted ? "（回收站）" : ""}
                      </a>
                    ))
                  ) : (
                    <small>未被作品引用</small>
                  )}
                </div>
                <details>
                  <summary>名称与标签</summary>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = Object.fromEntries(
                        new FormData(e.currentTarget),
                      );
                      run(async () => {
                        await api("assets_update", { id: a.id, ...f });
                        await load();
                      });
                    }}
                  >
                    <Field label="名称">
                      <input name="name" defaultValue={a.name} required />
                    </Field>
                    <Field label="标签">
                      <input name="tags" defaultValue={a.tags} />
                    </Field>
                    <Button>保存</Button>
                  </form>
                </details>
                <div className="row">
                  {a.deleted ? (
                    <>
                      <Button
                        onClick={() =>
                          run(async () => {
                            await api("assets_trash", {
                              id: a.id,
                              deleted: false,
                            });
                            await load();
                          })
                        }
                      >
                        恢复
                      </Button>
                      <Button
                        onClick={() => {
                          if (confirm("永久删除这份未引用素材？"))
                            run(async () => {
                              await api("assets_purge", { id: a.id });
                              await load();
                            });
                        }}
                      >
                        永久删除
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        disabled={
                          !targetId || a.refs.some((r) => r.work === targetId)
                        }
                        onClick={() =>
                          run(async () => {
                            await api("works_use_asset", {
                              id: targetId,
                              asset: a.id,
                            });
                            await load();
                            setNotice("素材已保存到作品");
                          })
                        }
                      >
                        {a.refs.some((r) => r.work === targetId)
                          ? "已在作品中"
                          : "用于作品"}
                      </Button>
                      <a
                        className="button"
                        aria-label={"下载 " + a.name}
                        href={"/api/assets/" + a.id + "/file"}
                      >
                        <Download size={15} />
                      </a>
                      <Button
                        aria-label={"回收素材 " + a.name}
                        disabled={a.refs.length > 0}
                        onClick={() =>
                          run(async () => {
                            await api("assets_trash", {
                              id: a.id,
                              deleted: true,
                            });
                            await load();
                          })
                        }
                      >
                        <Trash2 size={15} />
                      </Button>
                    </>
                  )}
                </div>
              </article>
            ))}
        </div>
      )}
      <p className="help">
        引用按作品中实际保存的素材文件统计，包含回收站中的作品。
      </p>
    </>
  );
}
function WorkVoice({ work, run, setNotice }) {
  const [engines, setEngines] = useState([]),
    [engine, setEngine] = useState(""),
    [text, setText] = useState(""),
    [result, setResult] = useState(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api("engines_list")
      .then((rows) => {
        setEngines(rows.filter((e) => e.enabled));
        setEngine(rows.find((e) => e.enabled)?.id || "");
      })
      .catch(() => {});
  }, []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        run(async () => {
          setResult(await api("works_speech", { id: work.id, engine, text }));
          setNotice("配音已加入作品素材，告诉 AI 将它安排到合适的镜头。");
        }).finally(() => setBusy(false));
      }}
    >
      <h2>为作品配音</h2>
      <p>生成的声音自动存入当前作品和素材库。</p>
      <Field label="语音引擎">
        <select value={engine} onChange={(e) => setEngine(e.target.value)}>
          {engines.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="配音文本">
        <textarea
          rows="5"
          value={text}
          onChange={(e) => setText(e.target.value)}
          required
          maxLength="4000"
          placeholder="写下这个镜头的旁白…"
        />
      </Field>
      <Button className="primary" disabled={busy || !engine}>
        {busy ? "正在合成…" : "生成配音"}
      </Button>
      {result && (
        <div className="speech-result">
          <audio controls src={"/api/assets/" + result.asset.id + "/file"} />
          <p>已加入作品 · 耗时 {(result.elapsedMs / 1000).toFixed(1)} 秒</p>
        </div>
      )}
    </form>
  );
}
function Versions({ work, run, setNotice, refresh }) {
  const [versions, setVersions] = useState([]);
  const load = () => api("works_versions", { id: work.id }).then(setVersions);
  useEffect(() => {
    run(load);
  }, [work.id]);
  return (
    <>
      <h2>作品版本</h2>
      <p>保存源码与素材快照。恢复前会自动保留当前版本。</p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const name = new FormData(e.currentTarget).get("name");
          run(async () => {
            await api("works_checkpoint", { id: work.id, name });
            await load();
            setNotice("作品版本已保存");
          });
        }}
      >
        <input name="name" required placeholder="例如：第一版分镜" />
        <Button className="primary">保存版本</Button>
      </form>
      {versions.map((v) => (
        <div className="version-row" key={v.id}>
          <div>
            <strong>{v.name}</strong>
            <p>{time(v.created)}</p>
          </div>
          <Button
            onClick={() => {
              if (confirm("恢复到这个版本？当前版本会先自动备份。"))
                run(async () => {
                  await api("works_restore", { id: work.id, version: v.id });
                  await load();
                  await refresh();
                  setNotice("已恢复作品，更新预览即可查看。");
                });
            }}
          >
            恢复此版本
          </Button>
        </div>
      ))}
    </>
  );
}
function WorkDetails({ work, run, refresh, setNotice }) {
  return (
    <form
      key={work.updated}
      onSubmit={(e) => {
        e.preventDefault();
        const values = Object.fromEntries(new FormData(e.currentTarget));
        run(async () => {
          await api("works_update", { id: work.id, ...values });
          await refresh();
          setNotice("作品资料已保存");
        });
      }}
    >
      <h2>作品资料</h2>
      <Field label="作品名称">
        <input
          name="title"
          defaultValue={work.title}
          required
          maxLength="150"
        />
      </Field>
      <Field label="分类">
        <input name="category" defaultValue={work.category} />
      </Field>
      <Field label="制作状态">
        <select name="status" defaultValue={work.status}>
          {Object.entries(statusNames).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Field>
      <Field label="作品简介">
        <textarea name="description" rows="3" defaultValue={work.description} />
      </Field>
      <Button className="primary">保存资料</Button>
      <p>
        存储：{work.storage_name}{" "}
        {work.remote ? "· 已连接 GitHub" : "· 服务器本地保存"}
      </p>
      <a href="#/settings">管理同步设置 →</a>
    </form>
  );
}
function TaskResults({ tasks, run, refresh, works = [] }) {
  const [detail, setDetail] = useState(null),
    [events, setEvents] = useState([]);
  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    const load = async () => {
      const r = await api("task_get", { id: detail });
      if (!cancelled) setEvents(r.events);
    };
    load().catch(() => {});
    const t = setInterval(() => load().catch(() => {}), 2500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [detail]);
  return (
    <div className="work-results">
      {!tasks.length && <Empty>还没有任务结果</Empty>}
      {tasks.map((t) => {
        const w = works.find(
          (w) => w.repo === t.repo && w.project === t.project,
        );
        return (
          <article className="result-row" key={t.id}>
            <div className="section-head">
              <strong>
                {kinds[t.kind] || t.kind}{" "}
                {w && <a href={"#/work/" + w.id}>· {w.title}</a>}
              </strong>
              <span className={"badge " + t.state}>{labels[t.state]}</span>
            </div>
            <small>{time(t.created)}</small>
            {t.error && <p className="error">{t.error}</p>}
            <div className="row">
              {(t.result?.artifacts || [])
                .filter((a) => /\.(mp4|webm|png|wav|srt)$/.test(a.name))
                .slice(0, 16)
                .map((a) => (
                  <a
                    key={a.path}
                    className="button"
                    href={"/api/tasks/" + t.id + "/file/" + a.path}
                  >
                    <Download size={14} />
                    {a.name.split("/").at(-1)} · {bytes(a.bytes)}
                  </a>
                ))}
              {active(t) && (
                <Button
                  onClick={() =>
                    run(async () => {
                      await api("task_cancel", { id: t.id });
                      await refresh();
                    })
                  }
                >
                  停止
                </Button>
              )}
              <button
                className="text-button"
                onClick={() => setDetail(detail === t.id ? null : t.id)}
              >
                任务详情
              </button>
            </div>
            {detail === t.id && (
              <pre>
                {events
                  .map((e) => e.data.text || JSON.stringify(e.data))
                  .join("\n")}
              </pre>
            )}
          </article>
        );
      })}
    </div>
  );
}
function PlatformSettings({ run, setNotice, refresh }) {
  const [tab, setTab] = useState("connections"),
    [repos, setRepos] = useState([]),
    [selected, setSelected] = useState("");
  const load = async () => {
    const r = await api("repositories_list");
    setRepos(r);
    setSelected((v) => v || r[0]?.id || "");
  };
  useEffect(() => {
    if (tab === "storage") run(load);
  }, [tab]);
  return (
    <>
      <div className="tabs settings-tabs">
        {[
          ["connections", "AI 与账户"],
          ["speech", "语音引擎"],
          ["storage", "GitHub 同步"],
        ].map(([v, l]) => (
          <button
            key={v}
            className={tab === v ? "active" : ""}
            onClick={() => setTab(v)}
          >
            {l}
          </button>
        ))}
      </div>
      {tab === "connections" && (
        <SettingsPage run={run} setNotice={setNotice} />
      )}
      {tab === "speech" && <SpeechPage run={run} setNotice={setNotice} />}
      {tab === "storage" && (
        <>
          <div className="heading">
            <div>
              <span className="eyebrow">CONTENT STORAGE</span>
              <h1>作品存储与同步</h1>
              <p>一个仓库可以存放多个作品。源码和关联素材一起同步到 GitHub。</p>
            </div>
          </div>
          <div className="two-columns">
            <section className="panel">
              <h2>内容库</h2>
              {repos.map((r) => (
                <div className="storage-row" key={r.id}>
                  <button
                    className={selected === r.id ? "selected" : ""}
                    onClick={() => setSelected(r.id)}
                  >
                    <FolderGit2 size={17} />
                    <strong>{r.name}</strong>
                    <small>{r.projects.length} 个作品</small>
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      run(async () => {
                        await api("repositories_default", { repo: r.id });
                        setNotice("新作品将自动存入 " + r.name);
                      })
                    }
                  >
                    设为默认
                  </button>
                </div>
              ))}
              <details>
                <summary>添加内容库 / 导入 GitHub 作品</summary>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = Object.fromEntries(new FormData(e.currentTarget));
                    run(async () => {
                      const r = await api("repositories_add", f);
                      await load();
                      setSelected(r.id);
                      await refresh();
                    });
                  }}
                >
                  <Field label="内容库名称">
                    <input name="name" required />
                  </Field>
                  <Field label="GitHub 仓库（留空则本地保存）">
                    <input
                      name="url"
                      placeholder="https://github.com/你的账号/作品库"
                    />
                  </Field>
                  <Field label="分支">
                    <input name="branch" defaultValue="main" required />
                  </Field>
                  <Button className="primary">添加内容库</Button>
                </form>
              </details>
            </section>
            <section className="panel">
              {selected ? (
                <GitPanel key={selected} repo={selected} run={run} />
              ) : (
                <Empty>创建作品时会自动准备内容库</Empty>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}
function NewWork({ run, onCreate }) {
  const [repos, setRepos] = useState([]),
    [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    api("repositories_list")
      .then(setRepos)
      .catch(() => {});
  }, []);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.currentTarget));
        setSubmitting(true);
        run(async () => {
          await onCreate(
            await api("works_create", {
              title: f.title,
              category: f.category,
              renderer: f.renderer,
              duration: Number(f.duration),
              ...(f.repo ? { repo: f.repo } : {}),
            }),
          );
        }).finally(() => setSubmitting(false));
      }}
    >
      <Field label="作品名称">
        <input
          name="title"
          autoFocus
          required
          maxLength={150}
          placeholder="给这个故事起个名字"
        />
      </Field>
      <Field label="分类">
        <input
          name="category"
          maxLength={80}
          placeholder="例如：短片、产品介绍、科普"
        />
      </Field>
      <div className="two-columns">
        <Field label="时长（秒）">
          <input
            name="duration"
            type="number"
            min="1"
            max="3600"
            defaultValue="12"
            required
          />
        </Field>
        <Field label="画面类型">
          <select name="renderer" defaultValue="canvas">
            <option value="canvas">二维动画</option>
            <option value="pixi">精灵与分层动画</option>
            <option value="three">三维动画</option>
          </select>
        </Field>
      </div>
      <details>
        <summary>存储位置</summary>
        <Field label="作品内容库">
          <select name="repo">
            <option value="">自动使用默认内容库</option>
            {repos.map((r) => (
              <option value={r.id} key={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <p>可以稍后在设置中连接 GitHub。</p>
      </details>
      <Button className="primary" disabled={submitting}>
        {submitting ? "正在创建…" : "创建作品"}
      </Button>
    </form>
  );
}
function WorksLibrary({ works, run, refresh, setModal, setNotice }) {
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState(""),
    [status, setStatus] = useState(""),
    [trash, setTrash] = useState(false),
    [recycled, setRecycled] = useState([]);
  const loadTrash = () =>
    api("works_list", { deleted: true }).then(setRecycled);
  useEffect(() => {
    if (trash) run(loadTrash);
  }, [trash]);
  const all = trash ? recycled : works,
    filtered = all.filter(
      (w) =>
        (!query ||
          (w.title + " " + w.description)
            .toLowerCase()
            .includes(query.toLowerCase())) &&
        (!category || w.category === category) &&
        (!status || w.status === status),
    );
  return (
    <>
      <div className="heading">
        <div>
          <span className="eyebrow">YOUR STORIES, IN MOTION</span>
          <h1>作品库</h1>
          <p>继续一个故事，或让新的想法开始发生。</p>
        </div>
        <Button icon={Plus} className="primary" onClick={() => setModal(true)}>
          新建作品
        </Button>
      </div>
      <div className="works-toolbar">
        <div className="tabs">
          <button
            className={!trash ? "active" : ""}
            onClick={() => setTrash(false)}
          >
            全部作品 <small>{works.length}</small>
          </button>
          <button
            className={trash ? "active" : ""}
            onClick={() => setTrash(true)}
          >
            回收站
          </button>
        </div>
        <div className="row">
          <label className="search-field">
            <Search size={16} />
            <input
              aria-label="搜索作品"
              placeholder="搜索作品"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <select
            aria-label="作品分类"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">所有分类</option>
            {[...new Set(all.map((w) => w.category).filter(Boolean))].map(
              (c) => (
                <option key={c}>{c}</option>
              ),
            )}
          </select>
          <select
            aria-label="制作状态"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">所有状态</option>
            {Object.entries(statusNames).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>
      {!filtered.length ? (
        <Empty>
          {trash ? "回收站是空的" : "这里还没有作品，创建你的第一个故事。"}
        </Empty>
      ) : (
        <div className="works-grid">
          {filtered.map((w, i) => (
            <article className="work-card" key={w.id}>
              <button
                className={"work-cover tone-" + (i % 4)}
                aria-label={"打开 " + w.title}
                disabled={trash || w.unavailable}
                onClick={() => go("work/" + w.id)}
              >
                {w.cover ? (
                  <img src={w.cover} alt={w.title} />
                ) : (
                  <>
                    <Film size={44} strokeWidth={1} />
                    <span>{w.title}</span>
                  </>
                )}
                <span className="cover-play">
                  <Play size={18} />
                </span>
              </button>
              <div className="work-card-body">
                <div className="row">
                  <span className={"badge " + w.status}>
                    {statusNames[w.status]}
                  </span>
                  {w.category && <small>{w.category}</small>}
                  <small className="duration">
                    {w.duration || 0}s · {w.fps || 30} fps
                  </small>
                </div>
                <h2>
                  <button
                    className="title-button"
                    disabled={trash}
                    onClick={() => go("work/" + w.id)}
                  >
                    {w.title}
                  </button>
                </h2>
                <p className="work-description">
                  {w.description || "从一个想法，到一段值得留下的画面。"}
                </p>
                <div className="work-card-foot">
                  <small>
                    {w.activity && active(w.activity)
                      ? labels[w.activity.state] +
                        " · " +
                        kinds[w.activity.kind]
                      : time(w.modified)}
                  </small>
                  <div className="row">
                    {trash ? (
                      <Button
                        onClick={() =>
                          run(async () => {
                            await api("works_trash", {
                              id: w.id,
                              deleted: false,
                            });
                            await refresh();
                            await loadTrash();
                          })
                        }
                      >
                        恢复作品
                      </Button>
                    ) : (
                      <>
                        <Button
                          aria-label={"复制 " + w.title}
                          onClick={() =>
                            run(async () => {
                              const copy = await api("works_duplicate", {
                                id: w.id,
                                title: w.title + " · 副本",
                              });
                              await refresh();
                              go("work/" + copy.id);
                            })
                          }
                        >
                          <Copy size={15} />
                        </Button>
                        <Button
                          aria-label={"回收 " + w.title}
                          onClick={() =>
                            run(async () => {
                              await api("works_trash", {
                                id: w.id,
                                deleted: true,
                              });
                              await refresh();
                              setNotice("作品已移入回收站，可以随时恢复。");
                            })
                          }
                        >
                          <Trash2 size={15} />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
createRoot(document.getElementById("root")).render(<App />);
