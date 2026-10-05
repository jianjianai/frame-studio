import { useEffect, useMemo, useState } from "react";
import {
  Plus,
  Settings as SettingsIcon,
  RefreshCw,
  Search,
  Trash2,
  MoreHorizontal,
  CloudUpload,
  FolderGit2,
  Clock,
  Sun,
  Moon,
  Undo2,
  FolderInput,
} from "lucide-react";
import { api, del, timeAgo, useServerEvent } from "../lib/api";
import { Dialog, useAction, useConfirm, useContextMenu, usePrompt } from "../lib/ui";
import type { Repo, WorkSummary } from "../lib/types";
import { navigate } from "../App";
import { GithubIcon } from "../components/icons";
import { NewWorkDialog } from "../components/NewWorkDialog";
import { RepoDialog } from "../components/RepoDialog";
import { SettingsView } from "../settings/SettingsView";
import "./pages.css";

const openWork = (work: Pick<WorkSummary, "repo" | "id">) => navigate(`/work/${encodeURIComponent(work.repo)}/${encodeURIComponent(work.id)}`);

export function WorkCard({ work, onMenu }: { work: WorkSummary; onMenu?: (event: React.MouseEvent) => void }) {
  const poster = work.checkedOut && work.poster?.startsWith("films/") ? `/files/${work.repo}/${work.id}/${work.poster}` : "";
  const ratio = work.width && work.height ? `${work.width} / ${work.height}` : "16 / 9";
  return (
    <div
      className="work-card"
      role="button"
      tabIndex={0}
      onClick={() => openWork(work)}
      onKeyDown={(event) => event.key === "Enter" && openWork(work)}
      onContextMenu={onMenu}
    >
      <div className="work-thumb" style={{ "--accent": work.accent || "var(--accent)" } as React.CSSProperties}>
        <div className="work-thumb-frame" style={{ aspectRatio: ratio }}>
          {poster ? (
            <img src={poster} alt="" loading="lazy" onError={(event) => ((event.target as HTMLImageElement).style.display = "none")} />
          ) : (
            <span>{work.title.slice(0, 1)}</span>
          )}
        </div>
      </div>
      <div className="work-info">
        <div className="row">
          <strong className="ellipsis grow" title={work.title}>
            {work.title}
          </strong>
          {onMenu && (
            <button
              className="icon-btn"
              aria-label="更多"
              onClick={(event) => {
                event.stopPropagation();
                onMenu(event);
              }}
            >
              <MoreHorizontal size={15} />
            </button>
          )}
        </div>
        <div className="muted small-text">
          {work.duration ? `${Math.round(work.duration)} 秒 · ` : ""}
          {work.width}×{work.height} · {timeAgo(work.openedAt || work.updatedAt)}
          {work.location === "remote" && <span className="badge"> 仅 GitHub</span>}
        </div>
      </div>
    </div>
  );
}

export function Welcome({ version }: { version: string }) {
  const [works, setWorks] = useState<WorkSummary[]>([]);
  const [recent, setRecent] = useState<WorkSummary[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<null | "new" | "repo" | "publish" | "settings" | "trash">(null);
  const [loading, setLoading] = useState(true);
  const [run] = useAction();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [openMenu, menu] = useContextMenu();
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || "");

  const load = async () => {
    const [list, recentList, repoList] = await Promise.all([api<WorkSummary[]>("/api/works"), api<WorkSummary[]>("/api/recent"), api<Repo[]>("/api/repos")]);
    setWorks(list);
    setRecent(recentList.slice(0, 8));
    setRepos(repoList);
    setLoading(false);
  };
  useEffect(() => {
    document.title = "FRAME Studio";
    void load();
  }, []);
  useServerEvent((event) => {
    if (["works", "repos"].includes(event.type)) void load();
  });

  const filtered = useMemo(() => works.filter((work) => !query || work.title.toLowerCase().includes(query.toLowerCase())), [works, query]);
  const byRepo = useMemo(() => repos.map((repo) => ({ repo, works: filtered.filter((work) => work.repo === repo.id) })), [repos, filtered]);

  const workMenu = (work: WorkSummary) => (event: React.MouseEvent) =>
    openMenu(event, [
      { label: "打开", onClick: () => openWork(work) },
      {
        label: "移到回收站",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: async () => {
          if (await confirm(`把「${work.title}」移到回收站？可以在回收站中恢复。`, { confirm: "移到回收站", danger: true }))
            await run(() => del(`/api/works/${work.repo}/${work.id}`), "已移到回收站");
        },
      },
    ]);

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("frame:theme", next);
    setTheme(next);
  };

  return (
    <div className="welcome">
      <header className="welcome-top">
        <div className="brand">
          <div className="brand-mark">F</div>
          <span>FRAME Studio</span>
          <span className="faint">{version}</span>
        </div>
        <div className="row">
          <button className="icon-btn" title="切换主题" onClick={toggleTheme}>
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
          <button className="icon-btn" title="设置" onClick={() => setDialog("settings")}>
            <SettingsIcon size={16} />
          </button>
        </div>
      </header>
      {dialog === "settings" ? (
        <div className="welcome-settings">
          <button className="btn ghost" onClick={() => setDialog(null)}>
            ← 返回
          </button>
          <SettingsView />
        </div>
      ) : (
        <main className="welcome-main">
          <section className="welcome-hero">
            <h1>用 AI 做视频</h1>
            <p className="muted">描述想要的画面，AI 写代码生成动画、配乐和配音；你在旁边实时预览、提意见、导出。</p>
            <div className="hero-actions">
              <button className="hero-card primary" onClick={() => setDialog("new")}>
                <Plus size={20} />
                <span>
                  <strong>新建作品</strong>
                  <small>描述需求交给 AI，或从空白开始</small>
                </span>
              </button>
              <button className="hero-card" onClick={() => setDialog("repo")}>
                <GithubIcon size={20} />
                <span>
                  <strong>连接 GitHub 作品库</strong>
                  <small>多台电脑同步作品与素材</small>
                </span>
              </button>
              <button className="hero-card" onClick={() => setDialog("settings")}>
                <SettingsIcon size={20} />
                <span>
                  <strong>设置 AI</strong>
                  <small>登录 Claude / ChatGPT，或添加自定义 API</small>
                </span>
              </button>
            </div>
          </section>

          {recent.length > 0 && (
            <section>
              <h2>
                <Clock size={15} /> 最近打开
              </h2>
              <div className="work-grid">
                {recent.map((work) => (
                  <WorkCard key={work.repo + work.id} work={work} onMenu={workMenu(work)} />
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="section-head">
              <h2>
                <FolderGit2 size={15} /> 全部作品
              </h2>
              <div className="search">
                <Search size={14} />
                <input placeholder="搜索作品" value={query} onChange={(event) => setQuery(event.target.value)} />
              </div>
            </div>
            {loading && <div className="empty">正在读取…</div>}
            {byRepo.map(({ repo, works: list }) => (
              <div className="repo-group" key={repo.id}>
                <div className="repo-head">
                  <strong>{repo.name}</strong>
                  {repo.remote ? <span className="badge accent">GitHub</span> : <span className="badge">本地</span>}
                  <span className="faint">{list.length} 个作品</span>
                  <span className="grow" />
                  {repo.remote ? (
                    <button className="btn small ghost" onClick={() => run(() => api(`/api/repos/${repo.id}/fetch`, { method: "POST" }), "已从 GitHub 刷新")}>
                      <RefreshCw size={13} /> 刷新
                    </button>
                  ) : (
                    <button className="btn small ghost" onClick={() => setDialog("publish")}>
                      <CloudUpload size={13} /> 发布到 GitHub
                    </button>
                  )}
                  <button
                    className="btn small ghost"
                    title="把电脑上含 project.ts 的作品文件夹导入为新作品"
                    onClick={async () => {
                      const source = await prompt("导入作品文件夹（本机路径，文件夹内需有 project.ts）", "", "/path/to/projects/my-film");
                      if (source)
                        await run(
                          () => api<{ id: string; repo: string }>("/api/works/import", { body: { source, repo: repo.id } }).then((work) => openWork(work)),
                          "已导入",
                        );
                    }}
                  >
                    <FolderInput size={13} /> 导入
                  </button>
                  <button className="btn small ghost" onClick={() => setDialog("trash")}>
                    <Trash2 size={13} /> 回收站
                  </button>
                </div>
                {list.length ? (
                  <div className="work-grid">
                    {list.map((work) => (
                      <WorkCard key={work.id} work={work} onMenu={workMenu(work)} />
                    ))}
                  </div>
                ) : (
                  <div className="empty small-text">{query ? "没有匹配的作品" : "还没有作品"}</div>
                )}
              </div>
            ))}
          </section>
        </main>
      )}
      {dialog === "new" && <NewWorkDialog onClose={() => setDialog(null)} />}
      {(dialog === "repo" || dialog === "publish") && (
        <RepoDialog mode={dialog === "publish" ? "publish" : "clone"} onClose={() => setDialog(null)} onDone={load} />
      )}
      {dialog === "trash" && <TrashDialog repos={repos} onClose={() => setDialog(null)} />}
      {menu}
    </div>
  );
}

function TrashDialog({ repos, onClose }: { repos: Repo[]; onClose: () => void }) {
  const [items, setItems] = useState<WorkSummary[]>([]);
  const [run] = useAction();
  const confirm = useConfirm();
  const load = () => Promise.all(repos.map((repo) => api<WorkSummary[]>(`/api/repos/${repo.id}/trash`))).then((lists) => setItems(lists.flat()));
  useEffect(() => {
    void load();
  }, []);
  return (
    <Dialog onClose={onClose} title="回收站" width={600}>
      {!items.length && <div className="empty">回收站是空的</div>}
      {items.map((work) => (
        <div className="trash-row" key={work.repo + work.id}>
          <span className="grow ellipsis">{work.title}</span>
          <span className="faint">{timeAgo(work.updatedAt)}</span>
          <button className="btn small" onClick={() => run(() => api(`/api/works/${work.repo}/${work.id}/restore`, { method: "POST" }).then(load), "已恢复")}>
            <Undo2 size={13} /> 恢复
          </button>
          <button
            className="btn small danger"
            onClick={async () => {
              if (
                await confirm(`永久删除「${work.title}」？本机的这个作品分支会被删除，无法恢复（GitHub 上的分支不受影响）。`, {
                  confirm: "永久删除",
                  danger: true,
                })
              )
                await run(() => del(`/api/trash/${work.repo}/${work.id}`).then(load), "已永久删除");
            }}
          >
            永久删除
          </button>
        </div>
      ))}
    </Dialog>
  );
}
