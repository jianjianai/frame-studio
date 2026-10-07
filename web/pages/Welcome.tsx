import { useEffect, useMemo, useRef, useState } from "react";
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
  HardDriveDownload,
  Copy,
  Send,
  Lock,
  ImageUp,
} from "lucide-react";
import { api, del, formatBytes, timeAgo, useServerEvent } from "../lib/api";
import { coverUrl, uploadCover } from "../lib/covers";
import { Dialog, useAction, useConfirm, useContextMenu, usePrompt, useToast } from "../lib/ui";
import type { Repo, WorkSummary } from "../lib/types";
import { navigate } from "../App";
import { GithubIcon } from "../components/icons";
import { NewWorkDialog } from "../components/NewWorkDialog";
import { RepoDialog } from "../components/RepoDialog";
import { SettingsView } from "../settings/SettingsView";
import "./pages.css";

const openWork = (work: Pick<WorkSummary, "repo" | "id">) => navigate(`/work/${encodeURIComponent(work.repo)}/${encodeURIComponent(work.id)}`);

export function WorkCard({ work, onMenu, remote }: { work: WorkSummary; onMenu?: (event: React.MouseEvent) => void; remote?: boolean }) {
  const cover = work.cover ? coverUrl(work.repo, work.id, work.cover) : "";
  const [broken, setBroken] = useState("");
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
          <span>{work.title.slice(0, 1)}</span>
          {cover && cover !== broken && <img src={cover} alt="" loading="lazy" onError={() => setBroken(cover)} />}
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
          {work.publishedAt && (
            <span className="badge accent" title={`发布于 ${new Date(work.publishedAt).toLocaleString()}，只能查看`}>
              {" "}
              <Lock size={9} /> 已发布
            </span>
          )}
          {work.deleteRequest && (
            <span className="badge danger" title={`AI 请求删除${work.deleteRequest.reason ? "：" + work.deleteRequest.reason : ""}。在首页上方确认删除或保留。`}>
              {" "}
              AI 请求删除
            </span>
          )}
          {work.location === "remote" && <span className="badge"> 仅 GitHub</span>}
          {remote && work.location === "local" && <span className="badge"> 仅本机</span>}
          {remote && work.location === "both" && !work.synced && (
            <span className="badge warn" title="本机有还没同步到 GitHub 的版本">
              {" "}
              未同步
            </span>
          )}
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
  const toast = useToast();
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
  // Files of a work changed (the AI or another window at work): list again once it calms down,
  // which also has the server make that work's cover anew.
  const later = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(later.current), []);
  useServerEvent((event) => {
    if (["works", "repos"].includes(event.type)) void load();
    if (event.type === "work-files") {
      clearTimeout(later.current);
      later.current = setTimeout(() => void load(), 4000);
    }
    // A cover made in the background: only that card changes.
    if (event.type === "work-cover") {
      const patch = (list: WorkSummary[]) =>
        list.map((work) => (work.repo === event.repo && work.id === event.work ? { ...work, cover: String(event.cover || "") } : work));
      setWorks(patch);
      setRecent(patch);
    }
  });

  const filtered = useMemo(() => works.filter((work) => !query || work.title.toLowerCase().includes(query.toLowerCase())), [works, query]);
  const byRepo = useMemo(() => repos.map((repo) => ({ repo, works: filtered.filter((work) => work.repo === repo.id) })), [repos, filtered]);

  const remoteOf = (work: WorkSummary) => Boolean(repos.find((repo) => repo.id === work.repo)?.remote);
  // An AI may only ask: the user moves the work to the recycle bin or keeps it.
  const requested = works.filter((work) => work.deleteRequest);
  // The list is reloaded here too, not only on the server's event (a slow or dropped connection).
  const confirmDelete = (work: WorkSummary) => run(() => del(`/api/works/${work.repo}/${work.id}`).then(load), `已把「${work.title}」移到回收站`);
  const keepWork = (work: WorkSummary) => run(() => del(`/api/works/${work.repo}/${work.id}/delete-request`).then(load), `已保留「${work.title}」`);
  const workMenu = (work: WorkSummary) => (event: React.MouseEvent) =>
    openMenu(event, [
      { label: "打开", onClick: () => openWork(work) },
      ...(work.deleteRequest ? [{ label: "保留（不删除）", icon: <Undo2 size={14} />, onClick: () => keepWork(work) }] : []),
      ...(work.checkedOut && !work.publishedAt
        ? [
            {
              label: "上传封面图片…",
              icon: <ImageUp size={14} />,
              onClick: () => run(async () => (await uploadCover(work.repo, work.id)) && toast("封面已更换", "ok")),
            },
          ]
        : []),
      {
        label: "创建副本",
        icon: <Copy size={14} />,
        onClick: async () => {
          const title = await prompt("副本名称", `${work.title}（副本）`);
          if (title?.trim())
            await run(() => api(`/api/works/${work.repo}/${work.id}/duplicate`, { body: { title: title.trim() } }), `已创建副本「${title.trim()}」`);
        },
      },
      work.publishedAt
        ? {
            label: "取消发布",
            icon: <Send size={14} />,
            onClick: () => run(() => api(`/api/works/${work.repo}/${work.id}/unpublish`, { method: "POST" }), "已取消发布，可以继续修改"),
          }
        : {
            label: "发布",
            icon: <Send size={14} />,
            onClick: async () => {
              if (await confirm(`发布「${work.title}」？发布后只能查看，不能再修改（随时可以取消发布）。当前所有修改会保存为一个版本。`, { confirm: "发布" }))
                await run(() => api(`/api/works/${work.repo}/${work.id}/publish`, { method: "POST" }), "已发布");
            },
          },
      ...(work.location === "both"
        ? [
            {
              label: "释放本地空间",
              icon: <HardDriveDownload size={14} />,
              disabled: !work.synced,
              onClick: async () => {
                if (
                  await confirm(
                    <>
                      删除本机上的「{work.title}」，只保留 GitHub 上的。
                      <br />
                      以后打开时会从 GitHub 重新下载。
                    </>,
                    { confirm: "释放空间" },
                  )
                ) {
                  const result = await run(() => api<{ freed: number }>(`/api/works/${work.repo}/${work.id}/free`, { method: "POST" }));
                  if (result) toast(`已释放 ${formatBytes(result.freed)}，作品保留在 GitHub 上`, "ok");
                }
              },
            },
          ]
        : []),
      "separator",
      {
        label: "移到回收站",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: async () => {
          const where = work.location === "local" ? "" : "本机和 GitHub 上";
          if (
            await confirm(`把「${work.title}」移到回收站？${where}的分支会改名为 trash/${work.id}，可以在回收站中恢复。`, {
              confirm: "移到回收站",
              danger: true,
            })
          )
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
                  <small>设置画幅和时长，然后和 AI 一起制作</small>
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

          {requested.length > 0 && (
            <section className="delete-requests">
              <h2>
                <Trash2 size={15} /> AI 请求删除
              </h2>
              <p className="muted small-text">AI 不能直接删除作品，只能提出请求。确认删除会把作品移到回收站（可以恢复）；不想删就保留。</p>
              {requested.map((work) => (
                <div className="delete-request" key={work.repo + work.id}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <strong className="ellipsis" title={work.title}>
                      {work.title}
                    </strong>
                    <div className="muted small-text">
                      {work.deleteRequest!.reason || "（AI 没有说明原因）"} · {timeAgo(work.deleteRequest!.at)}
                    </div>
                  </div>
                  <button className="btn small" onClick={() => openWork(work)}>
                    打开
                  </button>
                  <button className="btn small" onClick={() => keepWork(work)}>
                    保留
                  </button>
                  <button className="btn small danger" onClick={() => confirmDelete(work)}>
                    确认删除
                  </button>
                </div>
              ))}
            </section>
          )}

          {recent.length > 0 && (
            <section>
              <h2>
                <Clock size={15} /> 最近打开
              </h2>
              <div className="work-grid">
                {recent.map((work) => (
                  <WorkCard key={work.repo + work.id} work={work} onMenu={workMenu(work)} remote={remoteOf(work)} />
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
                      <WorkCard key={work.id} work={work} onMenu={workMenu(work)} remote={Boolean(repo.remote)} />
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

const WHERE = { both: "本机和 GitHub", remote: "仅 GitHub", local: "仅本机" } as const;

/**
 * The recycle bin: works whose branch was renamed to trash/<id> (here and on GitHub).
 * Restoring renames it back; deleting removes it here and on GitHub.
 */
function TrashDialog({ repos, onClose }: { repos: Repo[]; onClose: () => void }) {
  const [items, setItems] = useState<WorkSummary[] | null>(null);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const load = () => Promise.all(repos.map((repo) => api<WorkSummary[]>(`/api/repos/${repo.id}/trash`))).then((lists) => setItems(lists.flat()));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useServerEvent((event) => {
    if (event.type === "works") void load();
  });
  const freed = (bytes: number) => (bytes > 0 ? `，释放了 ${formatBytes(bytes)}` : "");
  const purge = async (work: WorkSummary) => {
    const where = work.location === "local" ? "本机上的分支" : work.location === "remote" ? "GitHub 上的分支" : "本机和 GitHub 上的分支";
    if (!(await confirm(`永久删除「${work.title}」？${where}、导出的视频和 AI 对话都会删除，无法恢复。`, { confirm: "永久删除", danger: true }))) return;
    const result = await run(() => del<{ freed: number }>(`/api/trash/${work.repo}/${work.id}`));
    if (result) toast(`已永久删除「${work.title}」${freed(result.freed)}`, "ok");
  };
  const empty = async () => {
    if (!items?.length) return;
    if (!(await confirm(`永久删除回收站里的 ${items.length} 个作品？本机和 GitHub 上的分支都会删除，无法恢复。`, { confirm: "清空回收站", danger: true }))) return;
    let total = 0;
    for (const repo of repos.filter((repo) => items.some((item) => item.repo === repo.id))) {
      const result = await run(() => del<{ freed: number }>(`/api/trash/${repo.id}`));
      if (!result) return;
      total += result.freed;
    }
    toast(`回收站已清空${freed(total)}`, "ok");
  };
  const repoName = (id: string) => repos.find((repo) => repo.id === id)?.name ?? id;
  return (
    <Dialog
      onClose={onClose}
      title="回收站"
      width={640}
      footer={
        <>
          <span className="faint small-text grow">移到回收站的作品分支改名为 trash/&lt;id&gt;，本机和 GitHub 上一起改。</span>
          <button className="btn danger" disabled={busy || !items?.length} onClick={empty}>
            <Trash2 size={13} /> 清空回收站
          </button>
        </>
      }
    >
      {items === null && <div className="empty">正在读取…</div>}
      {items?.length === 0 && <div className="empty">回收站是空的</div>}
      {items?.map((work) => (
        <div className="trash-row" key={work.repo + work.id}>
          <div className="grow trash-info">
            <strong className="ellipsis" title={work.title}>
              {work.title}
            </strong>
            <span className="faint small-text">
              {repos.length > 1 ? repoName(work.repo) + " · " : ""}
              {WHERE[work.location]} · {timeAgo(work.updatedAt)}修改 · trash/{work.id}
            </span>
          </div>
          <button
            className="btn small"
            disabled={busy}
            onClick={() => run(() => api(`/api/works/${work.repo}/${work.id}/restore`, { method: "POST" }), `已恢复「${work.title}」`)}
          >
            <Undo2 size={13} /> 恢复
          </button>
          <button className="btn small danger" disabled={busy} onClick={() => purge(work)}>
            永久删除
          </button>
        </div>
      ))}
    </Dialog>
  );
}
