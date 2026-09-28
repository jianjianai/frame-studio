import React, { useState, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  Clapperboard,
  FolderGit2,
  Images,
  AudioLines,
  MessagesSquare,
  ListChecks,
  Settings,
  Plus,
  LogOut,
  Play,
  Upload,
  RefreshCw,
  ArrowUpRight,
  Download,
  Trash2,
  Check,
  ChevronRight,
  Film,
} from "lucide-react";
import "./style.css";
async function request(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error || "请求失败");
  return v;
}
const api = (name, args = {}) =>
  request("/api/action", {
    method: "POST",
    body: JSON.stringify({ name, args }),
  });
const time = (v) =>
  v ? new Date(v).toLocaleString("zh-CN", { hour12: false }) : "—";
const bytes = (v) =>
  Number(v) > 1048576
    ? (Number(v) / 1048576).toFixed(1) + " MB"
    : (Number(v) / 1024).toFixed(1) + " KB";
const labels = {
  queued: "排队中",
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  cancelling: "取消中",
  interrupted: "中断",
};
const kinds = {
  new: "创建项目",
  validate: "检查项目",
  frame: "关键帧",
  storyboard: "分镜",
  render: "导出视频",
  build: "交互预览",
  agent: "AI 创作",
  "tools-update": "工具升级",
};
function Button({ children, icon: Icon, ...props }) {
  return (
    <button {...props}>
      {Icon && <Icon size={16} />} {children}
    </button>
  );
}
function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Empty({ children }) {
  return (
    <div className="empty">
      <Film size={32} />
      <p>{children}</p>
    </div>
  );
}
function readableAgentEvents(events) {
  const output = [];
  for (const line of events
    .filter((e) => e.kind === "log")
    .map((e) => e.data.text)
    .join("")
    .split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v.type === "item.completed" && v.item?.type === "agent_message")
        output.push(v.item.text);
      else if (
        v.type === "item.started" &&
        v.item?.type === "command_execution"
      )
        output.push("执行：" + v.item.command);
      else if (v.type === "assistant") {
        for (const c of v.message?.content || [])
          if (c.type === "text") output.push(c.text);
          else if (c.type === "tool_use") output.push("使用工具：" + c.name);
      } else if (v.type === "error")
        output.push(v.message || v.error?.message || "AI 返回错误");
    } catch {
      if (!line.startsWith("{")) output.push(line);
    }
  }
  return output.join("\n\n");
}
function App() {
  const [signed, setSigned] = useState(null),
    [page, setPage] = useState("projects"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [repos, setRepos] = useState([]),
    [tasks, setTasks] = useState([]),
    [repo, setRepo] = useState(""),
    [project, setProject] = useState(""),
    [modal, setModal] = useState(null),
    [selectedTask, setSelectedTask] = useState(null),
    [events, setEvents] = useState([]),
    [preview, setPreview] = useState("");
  const run = async (fn) => {
    setError("");
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const refresh = useCallback(async () => {
    const [r, t] = await Promise.all([
      api("repositories_list"),
      api("tasks_list"),
    ]);
    setRepos(r);
    setTasks(t);
    setRepo((v) => v || r[0]?.id || "");
  }, []);
  useEffect(() => {
    request("/api/me")
      .then(() => setSigned(true))
      .catch(() => setSigned(false));
  }, []);
  useEffect(() => {
    if (!signed) return;
    refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => refresh().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [signed, refresh]);
  useEffect(() => {
    const r = repos.find((r) => r.id === repo);
    if (!r?.projects.some((p) => p.id === project))
      setProject(r?.projects[0]?.id || "");
  }, [repo, repos, project]);
  useEffect(() => {
    if (!selectedTask) return;
    let gone = false;
    let after = 0;
    setEvents([]);
    const load = async () => {
      try {
        const v = await api("task_get", { id: selectedTask, after });
        if (gone) return;
        if (v.events.length) {
          after = Number(v.events.at(-1).id);
          setEvents((old) => [...old, ...v.events].slice(-500));
        }
      } catch {}
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [selectedTask]);
  const projects = repos.flatMap((r) =>
    r.projects.map((p) => ({ ...p, repo: r.id, repoName: r.name })),
  );
  const current = projects.find((p) => p.repo === repo && p.id === project);
  const start = (kind) =>
    run(async () => {
      const task = await api("task_create", {
        repo,
        project,
        kind,
        input:
          kind === "frame"
            ? { time: 0, width: 640 }
            : kind === "render"
              ? { width: 1280 }
              : {},
      });
      setSelectedTask(task.id);
      setPage("tasks");
      await refresh();
    });
  if (signed === null)
    return (
      <div className="login">
        <h1>
          FRAME<span>·</span>
        </h1>
      </div>
    );
  if (!signed)
    return (
      <div className="login">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await request("/api/login", {
                method: "POST",
                body: JSON.stringify({
                  password: new FormData(e.currentTarget).get("password"),
                }),
              });
              setSigned(true);
            });
          }}
        >
          <div className="brand">
            <Clapperboard /> FRAME<span>·</span>
          </div>
          <h1>让想法开始动起来。</h1>
          <p>登录你的私人动画创作工作台</p>
          <Field label="管理员密码">
            <input
              autoFocus
              type="password"
              name="password"
              required
              autoComplete="current-password"
            />
          </Field>
          {error && <div className="error">{error}</div>}
          <Button className="primary" disabled={busy}>
            进入工作台 <ArrowUpRight size={17} />
          </Button>
          <small>私人空间 · 项目、素材与 AI 创作</small>
        </form>
      </div>
    );
  const nav = [
    ["projects", FolderGit2, "项目"],
    ["assets", Images, "素材库"],
    ["speech", AudioLines, "语音工作室"],
    ["chats", MessagesSquare, "AI 创作"],
    ["tasks", ListChecks, "任务"],
    ["settings", Settings, "设置"],
  ];
  const selectors = (
    <div className="selectors">
      <select
        aria-label="仓库"
        value={repo}
        onChange={(e) => setRepo(e.target.value)}
      >
        <option value="">选择仓库</option>
        {repos.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <select
        aria-label="项目"
        value={project}
        onChange={(e) => setProject(e.target.value)}
      >
        <option value="">选择项目</option>
        {repos
          .find((r) => r.id === repo)
          ?.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
      </select>
    </div>
  );
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <Clapperboard size={23} /> FRAME<span>·</span>
        </div>
        <div className="workspace-label">PRIVATE STUDIO</div>
        <nav>
          {nav.map(([id, Icon, title]) => (
            <button
              key={id}
              className={page === id ? "active" : ""}
              onClick={() => setPage(id)}
            >
              <Icon size={19} />
              {title}
              {id === "tasks" &&
                tasks.some((t) => ["queued", "running"].includes(t.state)) && (
                  <i />
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="avatar">F</div>
          <div>
            私人工作台<small>管理员</small>
          </div>
          <button
            aria-label="退出"
            onClick={() =>
              run(async () => {
                await request("/api/logout", { method: "POST", body: "{}" });
                setSigned(false);
              })
            }
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            工作台 <ChevronRight size={13} />{" "}
            {nav.find((n) => n[0] === page)?.[2]}
          </div>
          <span className="online">
            <i /> 服务在线
          </span>
        </header>
        <div className="content">
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => setError("")}>×</button>
            </div>
          )}
          {notice && (
            <div className="notice">
              {notice}
              <button onClick={() => setNotice("")}>×</button>
            </div>
          )}
          {page === "projects" && (
            <>
              <div className="heading">
                <div>
                  <span className="eyebrow">YOUR CREATIVE SPACE</span>
                  <h1>每一个想法，都有自己的舞台。</h1>
                  <p>在版本可追溯的项目中，组织画面、声音与素材。</p>
                </div>
                <Button
                  icon={Plus}
                  className="primary"
                  onClick={() => setModal("repo")}
                >
                  添加仓库
                </Button>
              </div>
              <div className="stats">
                <div>
                  <b>{repos.length}</b>
                  <span>内容仓库</span>
                </div>
                <div>
                  <b>{projects.length}</b>
                  <span>动画项目</span>
                </div>
                <div>
                  <b>
                    {
                      tasks.filter((t) =>
                        ["queued", "running"].includes(t.state),
                      ).length
                    }
                  </b>
                  <span>正在进行</span>
                </div>
              </div>
              <div className="section-head">
                <h2>项目空间</h2>
                <div className="row">
                  {selectors}
                  <Button
                    icon={Plus}
                    disabled={!repo}
                    onClick={() => setModal("project")}
                  >
                    新建项目
                  </Button>
                  <Button onClick={() => setModal("git")} disabled={!repo}>
                    仓库同步
                  </Button>
                </div>
              </div>
              {!projects.length ? (
                <Empty>添加仓库并创建你的第一部动画。</Empty>
              ) : (
                <div className="project-grid">
                  {projects.map((p) => (
                    <button
                      key={p.repo + p.id}
                      className={
                        "project-card " +
                        (p.id === project && p.repo === repo ? "chosen" : "")
                      }
                      onClick={() => {
                        setRepo(p.repo);
                        setProject(p.id);
                      }}
                    >
                      <div className="poster">
                        <Clapperboard size={46} />
                        <span>{p.renderer?.toUpperCase()}</span>
                      </div>
                      <div className="card-body">
                        <small>{p.repoName}</small>
                        <h3>{p.title}</h3>
                        <div>
                          {p.duration}s <span>·</span> {p.fps} FPS{" "}
                          <span className="project-id">{p.id}</span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {current && (
                <div className="panel project-actions">
                  <div>
                    <h2>{current.title}</h2>
                    <p>
                      {current.repoName} / {current.id}
                    </p>
                  </div>
                  <div className="row">
                    <Button disabled={busy} onClick={() => setModal("editor")}>
                      查看 / 编辑源码
                    </Button>
                    <Button disabled={busy} onClick={() => start("validate")}>
                      检查
                    </Button>
                    <Button disabled={busy} onClick={() => start("storyboard")}>
                      分镜
                    </Button>
                    <Button
                      icon={Play}
                      disabled={busy}
                      onClick={() => start("build")}
                    >
                      预览
                    </Button>
                    <Button
                      className="primary"
                      icon={Download}
                      disabled={busy}
                      onClick={() => start("render")}
                    >
                      导出视频
                    </Button>
                  </div>
                </div>
              )}
              {repos.some((r) => r.errors.length > 0) && (
                <div className="error">
                  部分项目元数据无法读取：
                  {repos
                    .flatMap((r) => r.errors.map((e) => e.id + ": " + e.error))
                    .join("；")}
                </div>
              )}
            </>
          )}
          {page === "assets" && (
            <AssetsPage {...{ run, repo, project, selectors, setNotice }} />
          )}
          {page === "speech" && (
            <SpeechPage {...{ run, repo, project, selectors, setNotice }} />
          )}
          {page === "chats" && (
            <ChatsPage
              {...{
                run,
                repo,
                project,
                selectors,
                tasks,
                setSelectedTask,
                setPage,
              }}
            />
          )}
          {page === "tasks" && (
            <>
              <div className="heading">
                <div>
                  <span className="eyebrow">WORK IN PROGRESS</span>
                  <h1>任务中心</h1>
                  <p>关闭页面后，服务器会继续完成已提交的任务。</p>
                </div>
                <Button icon={RefreshCw} onClick={() => run(refresh)}>
                  刷新
                </Button>
              </div>
              <div className="task-layout">
                <div className="panel task-list">
                  {!tasks.length ? (
                    <Empty>还没有任务</Empty>
                  ) : (
                    tasks.map((t) => (
                      <button
                        className={selectedTask === t.id ? "selected" : ""}
                        onClick={() => setSelectedTask(t.id)}
                        key={t.id}
                      >
                        <div>
                          <strong>{kinds[t.kind] || t.kind}</strong>
                          <span className={"badge " + t.state}>
                            {labels[t.state] || t.state}
                          </span>
                        </div>
                        <p>
                          {t.project || t.input.provider} · {time(t.created)}
                        </p>
                      </button>
                    ))
                  )}
                </div>
                <div className="panel task-detail">
                  {selectedTask ? (
                    (() => {
                      const t = tasks.find((t) => t.id === selectedTask);
                      return (
                        <>
                          <div className="section-head">
                            <h2>{kinds[t?.kind] || "任务详情"}</h2>
                            {t && ["queued", "running"].includes(t.state) && (
                              <Button
                                onClick={() =>
                                  run(async () => {
                                    await api("task_cancel", { id: t.id });
                                    await refresh();
                                  })
                                }
                              >
                                取消任务
                              </Button>
                            )}
                          </div>
                          {t?.error && <div className="error">{t.error}</div>}
                          {t?.kind === "build" && t.state === "succeeded" && (
                            <Button
                              className="primary"
                              icon={Play}
                              onClick={() =>
                                run(async () =>
                                  setPreview(
                                    (
                                      await request(
                                        "/api/tasks/" + t.id + "/preview",
                                        { method: "POST", body: "{}" },
                                      )
                                    ).url,
                                  ),
                                )
                              }
                            >
                              打开交互预览
                            </Button>
                          )}
                          <div className="artifacts">
                            {t?.result?.artifacts
                              ?.filter(
                                (a) =>
                                  !a.name.includes("/assets/") &&
                                  !a.name.endsWith(".json"),
                              )
                              .map((a) => (
                                <a
                                  key={a.path}
                                  href={
                                    "/api/tasks/" + t.id + "/file/" + a.path
                                  }
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  <Download size={15} />
                                  {a.name}
                                  <small>{bytes(a.bytes)}</small>
                                </a>
                              ))}
                          </div>
                          <pre className="logs">
                            {events
                              .map((e) =>
                                e.kind === "log"
                                  ? e.data.text
                                  : JSON.stringify(e.data),
                              )
                              .join("\n") || "等待任务输出…"}
                          </pre>
                        </>
                      );
                    })()
                  ) : (
                    <Empty>选择任务查看进度与结果</Empty>
                  )}
                </div>
              </div>
            </>
          )}
          {page === "settings" && <SettingsPage {...{ run, setNotice }} />}
        </div>
        <footer>
          FRAME · 从一句想法，到每一帧画面。<span>服务器工作台 / 2.0</span>
        </footer>
      </main>
      {modal && (
        <div className="modal-backdrop">
          <div
            className={
              "modal " + (["editor", "git"].includes(modal) ? "wide" : "")
            }
          >
            <button className="close" onClick={() => setModal(null)}>
              ×
            </button>
            {modal === "repo" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = Object.fromEntries(new FormData(e.currentTarget));
                  run(async () => {
                    const r = await api("repositories_add", f);
                    setRepo(r.id);
                    setModal(null);
                    await refresh();
                  });
                }}
              >
                <h2>添加内容仓库</h2>
                <p>可以新建本地空间，或从 GitHub 拉取已有作品。</p>
                <Field label="名称">
                  <input name="name" required />
                </Field>
                <Field label="GitHub HTTPS 地址（留空创建本地空间）">
                  <input
                    name="url"
                    placeholder="https://github.com/owner/repository"
                  />
                </Field>
                <Field label="分支">
                  <input name="branch" defaultValue="main" required />
                </Field>
                <Button className="primary" disabled={busy}>
                  添加仓库
                </Button>
              </form>
            )}
            {modal === "project" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = Object.fromEntries(new FormData(e.currentTarget));
                  run(async () => {
                    const t = await api("task_create", {
                      repo,
                      project: f.id,
                      kind: "new",
                      input: {
                        title: f.title,
                        renderer: f.renderer,
                        duration: Number(f.duration),
                      },
                    });
                    setSelectedTask(t.id);
                    setModal(null);
                    setPage("tasks");
                    await refresh();
                  });
                }}
              >
                <h2>新建动画项目</h2>
                <Field label="项目 ID">
                  <input
                    name="id"
                    pattern="[a-z][a-z0-9-]*"
                    placeholder="my-film"
                    required
                  />
                </Field>
                <Field label="标题">
                  <input name="title" required />
                </Field>
                <Field label="画面引擎">
                  <select name="renderer">
                    <option value="canvas">Canvas</option>
                    <option value="pixi">PixiJS</option>
                    <option value="three">Three.js</option>
                  </select>
                </Field>
                <Field label="时长（秒）">
                  <input
                    name="duration"
                    type="number"
                    min="1"
                    max="3600"
                    defaultValue="12"
                  />
                </Field>
                <Button className="primary" disabled={busy}>
                  创建项目
                </Button>
              </form>
            )}
            {modal === "git" && <GitPanel {...{ repo, run }} />}
            {modal === "editor" && (
              <Editor {...{ repo, project, run, setNotice }} />
            )}
          </div>
        </div>
      )}
      {preview && (
        <div className="modal-backdrop">
          <div className="modal preview">
            <button className="close" onClick={() => setPreview("")}>
              ×
            </button>
            <iframe
              title="动画交互预览"
              src={preview}
              sandbox="allow-scripts allow-downloads"
            />
          </div>
        </div>
      )}
    </div>
  );
}
function GitPanel({ repo, run }) {
  const [s, setS] = useState(null),
    [message, setMessage] = useState("更新动画作品");
  const load = () => api("repositories_status", { repo }).then(setS);
  useEffect(() => {
    run(load);
  }, [repo]);
  return (
    <>
      <h2>仓库同步</h2>
      <p>
        {s?.remote || "本地内容仓库"} · {s?.branch}
      </p>
      {!s?.remote && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const url = new FormData(e.currentTarget).get("url");
            run(async () => {
              await api("repositories_remote", { repo, url });
              await load();
            });
          }}
        >
          <input
            name="url"
            type="url"
            placeholder="https://github.com/owner/repository"
            required
          />
          <Button>关联 GitHub 仓库</Button>
        </form>
      )}
      <div className="row">
        <Button
          onClick={() =>
            run(async () => {
              await api("repositories_sync", { repo, action: "fetch" });
              await load();
            })
          }
        >
          获取远程状态
        </Button>
        <Button
          onClick={() =>
            run(async () => {
              await api("repositories_sync", { repo, action: "pull" });
              await load();
            })
          }
        >
          拉取
        </Button>
        <Button
          onClick={() =>
            run(async () => {
              await api("repositories_sync", { repo, action: "push" });
              await load();
            })
          }
        >
          推送（含 LFS）
        </Button>
      </div>
      <pre>{s?.changes || "工作区无改动"}</pre>
      <div className="row">
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          aria-label="提交说明"
        />
        <Button
          className="primary"
          onClick={() =>
            run(async () => {
              await api("repositories_sync", {
                repo,
                action: "commit",
                message,
              });
              await load();
            })
          }
        >
          提交改动
        </Button>
      </div>
      <details>
        <summary>源码差异</summary>
        <pre>{s?.diff || "无差异"}</pre>
      </details>
      <pre>{s?.history}</pre>
    </>
  );
}
function Editor({ repo, project, run, setNotice }) {
  const [files, setFiles] = useState([]),
    [file, setFile] = useState(""),
    [content, setContent] = useState(""),
    [sha, setSha] = useState(null);
  useEffect(() => {
    run(async () => setFiles(await api("project_files", { repo, project })));
  }, [repo, project]);
  const open = (f) =>
    run(async () => {
      const r = await api("project_read", { repo, project, path: f });
      setFile(f);
      setContent(r.content);
      setSha(r.sha256);
    });
  return (
    <>
      <h2>项目源码</h2>
      <div className="row">
        <select value={file} onChange={(e) => open(e.target.value)}>
          <option value="">选择文件</option>
          {files
            .filter((f) => /\.(ts|tsx|js|json|md|svg|css|txt)$/.test(f.path))
            .map((f) => (
              <option key={f.path}>{f.path}</option>
            ))}
        </select>
        <Button
          disabled={!file}
          className="primary"
          onClick={() =>
            run(async () => {
              const r = await api("project_write", {
                repo,
                project,
                path: file,
                expectedSha256: sha,
                content,
              });
              setSha(r.sha256);
              setNotice("源码已保存");
            })
          }
        >
          保存
        </Button>
      </div>
      <textarea
        className="code-editor"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck="false"
        aria-label="文件内容"
      />
    </>
  );
}
function AssetsPage({ run, repo, project, selectors, setNotice }) {
  const [items, setItems] = useState([]),
    [filter, setFilter] = useState("all"),
    [search, setSearch] = useState("");
  const load = () =>
    api("assets_list", {
      unused: filter === "unused",
      deleted: filter === "trash",
      search,
    }).then(setItems);
  useEffect(() => {
    run(load);
  }, [filter, search]);
  return (
    <>
      <div className="heading">
        <div>
          <span className="eyebrow">MATERIAL LIBRARY</span>
          <h1>素材库</h1>
          <p>集中管理素材，使用时保存到项目所属仓库。</p>
        </div>
      </div>
      <form
        className="panel upload-form"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          run(async () => {
            await request("/api/upload", {
              method: "POST",
              body: new FormData(form),
            });
            form.reset();
            await load();
            setNotice("素材上传完成");
          });
        }}
      >
        <Field label="文件">
          <input type="file" name="file" required />
        </Field>
        <Field label="来源 / 许可">
          <input
            name="license"
            required
            placeholder="例如：原创 / CC0 / 已购买授权"
          />
        </Field>
        <Field label="标签">
          <input name="tags" placeholder="人物、背景、音效" />
        </Field>
        <Button className="primary" icon={Upload}>
          上传素材
        </Button>
      </form>
      <div className="section-head">
        <div className="tabs">
          {[
            ["all", "全部素材"],
            ["unused", "未关联项目"],
            ["trash", "回收站"],
          ].map(([v, l]) => (
            <button
              className={filter === v ? "active" : ""}
              onClick={() => setFilter(v)}
              key={v}
            >
              {l}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索名称或标签"
        />
      </div>
      <div className="row attach-target">
        <span>使用到</span>
        {selectors}
      </div>
      {!items.length ? (
        <Empty>这里还没有素材</Empty>
      ) : (
        <div className="asset-grid">
          {items.map((a) => (
            <div className="panel asset" key={a.id}>
              <div className="asset-visual">
                {a.mime.startsWith("image/") && !a.deleted ? (
                  <img src={"/api/assets/" + a.id + "/file"} alt={a.name} />
                ) : a.mime.startsWith("audio/") ? (
                  <AudioLines size={35} />
                ) : (
                  <Images size={35} />
                )}
              </div>
              <h3>{a.name}</h3>
              <p>
                {bytes(a.bytes)} · {a.refs.length} 个项目
              </p>
              <small>
                {a.license} {a.tags && " · " + a.tags}
              </small>
              <details>
                <summary>编辑名称和标签</summary>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const values = Object.fromEntries(
                      new FormData(e.currentTarget),
                    );
                    run(async () => {
                      await api("assets_update", { id: a.id, ...values });
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
                  <Button>保存资料</Button>
                </form>
              </details>
              {a.mime.startsWith("audio/") && !a.deleted && (
                <audio controls src={"/api/assets/" + a.id + "/file"} />
              )}
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
                        if (
                          window.confirm(
                            "永久删除这份未关联素材？此操作无法撤销。",
                          )
                        )
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
                      disabled={!repo || !project}
                      onClick={() =>
                        run(async () => {
                          const r = await api("assets_attach", {
                            id: a.id,
                            repo,
                            project,
                          });
                          await load();
                          setNotice("已保存到项目：" + r.path);
                        })
                      }
                    >
                      使用到项目
                    </Button>
                    <a
                      className="button"
                      href={"/api/assets/" + a.id + "/file"}
                    >
                      <Download size={16} />
                    </a>
                    <Button
                      aria-label="移入回收站"
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
                      <Trash2 size={16} />
                    </Button>
                  </>
                )}
              </div>
              {a.refs.map((r) => (
                <div className="asset-ref" key={r.repo + r.project}>
                  {r.project}
                  <button
                    onClick={() =>
                      run(async () => {
                        await api("assets_detach", {
                          id: a.id,
                          repo: r.repo,
                          project: r.project,
                        });
                        await load();
                        setNotice("已解除素材库关联，项目中的文件保留");
                      })
                    }
                  >
                    解除关联
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <p className="help">
        “未关联项目”按素材关联清单统计。解除关联保留项目文件，避免破坏动态路径引用。
      </p>
    </>
  );
}
function SpeechPage({ run, repo, project, selectors, setNotice }) {
  const [engines, setEngines] = useState([]),
    [engine, setEngine] = useState(""),
    [text, setText] = useState(
      "你好，欢迎来到 FRAME。让每一个想法，都有自己的声音。",
    ),
    [result, setResult] = useState(null),
    [models, setModels] = useState([]),
    [show, setShow] = useState(false),
    [editing, setEditing] = useState(null);
  const load = async () => {
    const e = await api("engines_list");
    setEngines(e);
    setEngine((v) => v || e[0]?.id || "");
  };
  useEffect(() => {
    run(async () => {
      await load();
      setModels(await api("models_list"));
    });
  }, []);
  return (
    <>
      <div className="heading">
        <div>
          <span className="eyebrow">VOICE STUDIO</span>
          <h1>为故事，找到合适的声音。</h1>
          <p>本地中文合成与外部引擎，在同一个工作室中试听。</p>
        </div>
        <Button
          icon={Plus}
          onClick={() => {
            setEditing(null);
            setShow(!show);
          }}
        >
          添加外部引擎
        </Button>
      </div>
      {show && (
        <form
          className="panel form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            const f = Object.fromEntries(new FormData(e.currentTarget));
            run(async () => {
              await api("engines_save", {
                ...f,
                ...(editing ? { id: editing.id } : {}),
                enabled: f.enabled === "true",
              });
              setShow(false);
              await load();
            });
          }}
        >
          {[
            ["name", "名称", ""],
            ["url", "兼容 API 基础地址", "https://api.openai.com/v1"],
            ["model", "模型", ""],
            ["voice", "声线", ""],
            ["apiKey", "API Key", ""],
          ].map(([name, label, placeholder]) => (
            <Field key={name} label={label}>
              <input
                name={name}
                key={(editing?.id || "new") + name}
                defaultValue={
                  name === "name"
                    ? editing?.name
                    : name === "apiKey"
                      ? ""
                      : editing?.config?.[name] || ""
                }
                type={name === "apiKey" ? "password" : "text"}
                placeholder={placeholder}
                required={name !== "apiKey"}
              />
            </Field>
          ))}
          <Field label="状态">
            <select
              name="enabled"
              defaultValue={String(editing?.enabled ?? true)}
              key={editing?.id || "new"}
            >
              <option value="true">启用</option>
              <option value="false">停用</option>
            </select>
          </Field>
          <Button className="primary">保存引擎</Button>
        </form>
      )}
      <div className="two-columns">
        <div className="panel">
          <h2>语音试听</h2>
          <Button
            className="text-button"
            disabled={!engine}
            onClick={() => {
              setEditing(engines.find((e) => e.id === engine));
              setShow(true);
            }}
          >
            编辑所选引擎
          </Button>
          <Field label="语音引擎">
            <select value={engine} onChange={(e) => setEngine(e.target.value)}>
              {engines.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.enabled ? "" : "（已停用）"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="合成文本">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows="7"
            />
          </Field>
          <div className="row">
            <Button
              className="primary"
              icon={Play}
              disabled={!engine}
              onClick={() =>
                run(async () =>
                  setResult(await api("speech_test", { engine, text })),
                )
              }
            >
              生成并试听
            </Button>
            <Button
              disabled={!engine || !project}
              onClick={() =>
                run(async () => {
                  setResult(
                    await api("speech_test", { engine, text, repo, project }),
                  );
                  setNotice("配音已保存到目标项目素材目录");
                })
              }
            >
              生成到项目
            </Button>
          </div>
          {selectors}
          {result && (
            <div className="speech-result">
              <audio
                controls
                autoPlay
                src={"/api/assets/" + result.asset.id + "/file"}
              />
              <p>
                耗时 {(result.elapsedMs / 1000).toFixed(1)} 秒 · 已存入素材库
              </p>
            </div>
          )}
        </div>
        <div className="panel">
          <h2>本地模型</h2>
          <p>支持 Kokoro 权重、配置和声线文件。内置模型使用 CPU。</p>
          {models.map((m) => (
            <div className="model" key={m.id}>
              <div>
                <strong>{m.id}</strong>
                <span className="badge">
                  {m.ready ? "文件就绪" : "等待上传"}
                </span>
              </div>
              <small>{m.voices?.join(" · ") || "暂无声线"}</small>
              <div className="row">
                <Button
                  disabled={!m.ready || !m.voices?.length}
                  onClick={() =>
                    run(async () => {
                      const v = await api("engines_save", {
                        name: "Kokoro · " + m.id,
                        url: "http://speech:8000/v1",
                        model: m.id,
                        voice: m.voices[0],
                      });
                      await load();
                      setEngine(v.id);
                      setNotice("已添加本地语音引擎");
                    })
                  }
                >
                  添加为语音引擎
                </Button>
                {m.id !== "builtin" && (
                  <Button
                    onClick={() =>
                      run(async () => {
                        await api("models_delete", { id: m.id });
                        setModels(await api("models_list"));
                      })
                    }
                  >
                    删除模型
                  </Button>
                )}
              </div>
            </div>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const id = new FormData(e.currentTarget).get("id");
              run(async () => {
                await api("models_create", { id });
                setModels(await api("models_list"));
              });
            }}
            className="row"
          >
            <input name="id" placeholder="新模型 ID，如 my-voice" required />
            <Button icon={Plus}>新建</Button>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget),
                id = f.get("id");
              f.delete("id");
              run(async () => {
                await request("/api/models/" + id + "/upload", {
                  method: "POST",
                  body: f,
                });
                setModels(await api("models_list"));
                setNotice("模型文件上传完成");
              });
            }}
          >
            <Field label="上传到模型">
              <select name="id">
                {models
                  .filter((m) => m.id !== "builtin")
                  .map((m) => (
                    <option key={m.id}>{m.id}</option>
                  ))}
              </select>
            </Field>
            <Field label="模型内路径">
              <input
                name="path"
                placeholder="config.json / model.pth / voices/zf_custom.pt"
                required
              />
            </Field>
            <input type="file" name="file" required />
            <Button icon={Upload}>上传模型文件</Button>
          </form>
        </div>
      </div>
    </>
  );
}
function ChatsPage({
  run,
  repo,
  project,
  selectors,
  tasks,
  setSelectedTask,
  setPage,
}) {
  const [chats, setChats] = useState([]),
    [chat, setChat] = useState(""),
    [provider, setProvider] = useState("codex"),
    [prompt, setPrompt] = useState(""),
    [stream, setStream] = useState({});
  const load = () => api("chats_list").then(setChats);
  useEffect(() => {
    run(load);
  }, []);
  const turns = tasks.filter((t) => t.chat === chat).reverse();
  useEffect(() => {
    if (!chat) return;
    const update = async () => {
      const active = tasks.filter((t) => t.chat === chat);
      const entries = await Promise.all(
        active.slice(0, 10).map(async (t) => {
          let after = 0;
          const events = [];
          for (;;) {
            const page = (await api("task_get", { id: t.id, after })).events;
            events.push(...page);
            if (page.length < 100) break;
            after = Number(page.at(-1).id);
          }
          return [t.id, events];
        }),
      );
      setStream(Object.fromEntries(entries));
    };
    update().catch(() => {});
    const timer = setInterval(() => update().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [chat, tasks.length]);
  return (
    <>
      <div className="heading">
        <div>
          <span className="eyebrow">CREATE TOGETHER</span>
          <h1>把想法交给 AI，一起完成。</h1>
          <p>对话保存在服务器，离开页面后创作仍会继续。</p>
        </div>
      </div>
      <div className="chat-layout">
        <div className="panel">
          <h2>创作会话</h2>
          {selectors}
          <select
            aria-label="AI 工具"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
          <Button
            className="primary"
            icon={Plus}
            disabled={!project}
            onClick={() =>
              run(async () => {
                const c = await api("chats_create", {
                  repo,
                  project,
                  provider,
                  title:
                    project +
                    " · " +
                    (provider === "codex" ? "Codex" : "Claude"),
                });
                await load();
                setChat(c.id);
              })
            }
          >
            新建对话
          </Button>
          <div className="chat-list">
            {chats.map((c) => (
              <button
                key={c.id}
                className={chat === c.id ? "selected" : ""}
                onClick={() => setChat(c.id)}
              >
                <MessagesSquare size={16} />
                {c.title}
              </button>
            ))}
          </div>
        </div>
        <div className="panel conversation">
          {!chat ? (
            <Empty>选择项目和 AI，开始新的创作对话。</Empty>
          ) : (
            <>
              <div className="messages">
                {!turns.length && (
                  <Empty>描述你想制作的动画、画面风格和时长。</Empty>
                )}
                {turns.map((t) => (
                  <div className="turn" key={t.id}>
                    <div className="user-message">{t.input.prompt}</div>
                    <div className="agent-message">
                      <span className={"badge " + t.state}>
                        {labels[t.state]}
                      </span>
                      {t.error && <p className="error">{t.error}</p>}
                      <pre>
                        {readableAgentEvents(stream[t.id] || []) ||
                          (t.state === "succeeded"
                            ? "创作已完成。"
                            : "AI 正在准备工作…")}
                      </pre>
                      <button
                        className="text-button"
                        onClick={() => {
                          setSelectedTask(t.id);
                          setPage("tasks");
                        }}
                      >
                        查看任务和作品结果 <ArrowUpRight size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    await api("chats_send", { id: chat, prompt });
                    setPrompt("");
                  });
                }}
              >
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="描述下一个镜头，或继续修改…"
                  rows="3"
                  required
                />
                <div>
                  <small>AI 仅编辑所选项目 · 文件与对话持续保存</small>
                  <Button
                    className="primary"
                    disabled={
                      !prompt.trim() ||
                      turns.some((t) => ["queued", "running"].includes(t.state))
                    }
                  >
                    开始创作 <ArrowUpRight size={16} />
                  </Button>
                </div>
              </form>
            </>
          )}
        </div>
      </div>
    </>
  );
}
function SettingsPage({ run, setNotice }) {
  const [settings, setSettings] = useState(null),
    [tokens, setTokens] = useState([]),
    [newToken, setNewToken] = useState("");
  const load = async () => {
    setSettings(await api("settings_get"));
    setTokens(await api("tokens_list"));
  };
  useEffect(() => {
    run(load);
  }, []);
  return (
    <>
      <div className="heading">
        <div>
          <span className="eyebrow">MAKE IT YOURS</span>
          <h1>工作台设置</h1>
          <p>连接创作工具、管理访问凭据与工具版本。</p>
        </div>
      </div>
      <div className="settings-grid">
        {["codex", "claude", "github"].map((provider) => (
          <form
            className="panel"
            key={provider}
            onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget));
              run(async () => {
                await api("settings_save", { provider, ...f });
                e.target?.reset?.();
                await load();
                setNotice("配置已加密保存");
              });
            }}
          >
            <div className="section-head">
              <h2>
                {provider === "github"
                  ? "GitHub"
                  : provider === "codex"
                    ? "Codex"
                    : "Claude"}
              </h2>
              <span className="badge">
                {settings?.[provider]?.configured ? "已配置" : "待配置"}
              </span>
            </div>
            <Field label={provider === "github" ? "访问令牌" : "API Key"}>
              <input
                type="password"
                name="secret"
                placeholder="留空保留已有密钥"
                autoComplete="off"
              />
            </Field>
            {provider !== "github" && (
              <>
                <Field label="API 地址（留空使用默认）">
                  <input
                    name="baseUrl"
                    defaultValue={settings?.[provider]?.baseUrl}
                    key={"url" + (settings?.[provider]?.baseUrl || "")}
                    placeholder={
                      provider === "codex"
                        ? "https://api.openai.com/v1"
                        : "https://api.anthropic.com"
                    }
                  />
                </Field>
                <Field label="模型（留空使用默认）">
                  <input
                    name="model"
                    defaultValue={settings?.[provider]?.model}
                    key={"model" + (settings?.[provider]?.model || "")}
                  />
                </Field>
              </>
            )}
            <Button className="primary">保存连接</Button>
          </form>
        ))}
      </div>
      <div className="two-columns">
        <div className="panel">
          <h2>AI 工具独立升级</h2>
          <p>
            指定版本安装。已有任务使用启动时选择的版本，新任务使用更新版本。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget));
              run(async () => {
                await api("tools_update", f);
                setNotice("升级任务已提交，可在任务中心查看");
              });
            }}
          >
            <Field label="工具">
              <select name="provider">
                <option value="codex">Codex CLI</option>
                <option value="claude">Claude Code CLI</option>
              </select>
            </Field>
            <Field label="版本号">
              <input
                name="version"
                placeholder="填写明确版本号"
                required
                pattern="[0-9]+\.[0-9]+\.[0-9]+.*"
              />
            </Field>
            <Button>安装 / 切换版本</Button>
          </form>
          {settings?.tools?.map((t, i) => (
            <p key={i}>
              {t.input.provider} {t.input.version} · {labels[t.state]} {t.error}
            </p>
          ))}
        </div>
        <div className="panel">
          <h2>API / MCP 访问令牌</h2>
          <p>
            MCP 地址：<code>{location.origin}/mcp</code>
          </p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              const name = new FormData(e.currentTarget).get("name");
              run(async () => {
                setNewToken((await api("tokens_create", { name })).token);
                await load();
              });
            }}
          >
            <input name="name" placeholder="令牌名称" required />
            <Button icon={Plus}>创建</Button>
          </form>
          {newToken && (
            <div className="token">
              <strong>仅显示一次，请妥善保存</strong>
              <textarea readOnly value={newToken} />
            </div>
          )}
          {tokens.map((t) => (
            <div className="token-row" key={t.id}>
              <span>
                {t.name}
                <small>{time(t.created)}</small>
              </span>
              <Button
                onClick={() =>
                  run(async () => {
                    await api("tokens_revoke", { id: t.id });
                    await load();
                  })
                }
              >
                撤销
              </Button>
            </div>
          ))}
        </div>
      </div>
      <form
        className="panel password-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = Object.fromEntries(new FormData(e.currentTarget));
          run(async () => {
            await api("password_change", f);
            location.reload();
          });
        }}
      >
        <h2>修改登录密码</h2>
        <div className="row">
          <input
            name="current"
            type="password"
            placeholder="当前密码"
            required
          />
          <input
            name="password"
            type="password"
            minLength="14"
            placeholder="新密码，至少 14 位"
            required
          />
          <Button>修改并重新登录</Button>
        </div>
      </form>
    </>
  );
}
createRoot(document.getElementById("root")).render(<App />);
