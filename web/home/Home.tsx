import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Clock,
  Copy,
  ExternalLink,
  FolderInput,
  FolderOutput,
  HardDriveDownload,
  ImageUp,
  KeyRound,
  LayoutGrid,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings as SettingsIcon,
  SquareCheck,
  Trash2,
  TriangleAlert,
  Undo2,
  Unlink,
  CloudUpload,
} from "lucide-react";
import { api, del, formatBytes, useServerEvent } from "../lib/api";
import { uploadCover } from "../lib/covers";
import { useAction, useConfirm, useContextMenu, usePersistent, usePrompt, useToast, type MenuItem } from "../lib/ui";
import type { Repo, WorkSummary } from "../lib/types";
import { NewWorkDialog } from "../components/NewWorkDialog";
import { RepoDialog } from "../components/RepoDialog";
import { MoveWorkDialog, type MovableWork } from "../components/MoveWorkDialog";
import { SettingsView } from "../settings/SettingsView";
import { HomeSidebar, type RepoState } from "./Sidebar";
import { WorkCard, WorkListHead, WorkRow } from "./WorkItems";
import { Attention, AttentionBanner, Empty, RepoHead, SelectionBar, Toolbar, Welcome, openWork } from "./Parts";
import { TrashView, type BinnedLibrary } from "./TrashView";
import { PageHead } from "./PageHead";
import { AccountDialog, UnlinkDialog, type Account } from "./RepoDialogs";
import {
  FILTERS,
  conflicted,
  githubPage,
  matches,
  needsAttention,
  parseScope,
  repoName,
  scopeKey,
  sortWorks,
  workKey,
  type Filter,
  type Scope,
  type Sort,
} from "./model";
import "../pages/pages.css";
import "./home.css";

/** Menus open under the button that asked for them, or where the right click was. */
const menuPoint = (event: React.MouseEvent) => {
  if (event.type === "contextmenu" || !(event.currentTarget instanceof HTMLElement)) return event;
  const rect = event.currentTarget.getBoundingClientRect();
  return { clientX: rect.left, clientY: rect.bottom + 4, preventDefault: () => event.preventDefault() };
};

type DialogState =
  | null
  | { kind: "new"; repo?: string }
  | { kind: "connect" }
  | { kind: "publish" }
  | { kind: "unlink"; repo: Repo }
  | { kind: "account"; repo: Repo }
  | { kind: "move"; works: MovableWork[] };

/**
 * The home page: works of every connected repository with search, filters, sorting, a grid or
 * a list and batch actions; the repositories themselves (connect, account, 取消链接); the
 * recycle bin and the settings.
 */
export function Home({ version, local }: { version: string; local: boolean }) {
  const [works, setWorks] = useState<WorkSummary[]>([]);
  const [trash, setTrash] = useState<WorkSummary[]>([]);
  // Material and experience libraries in the bin, of every repository.
  const [binned, setBinned] = useState<BinnedLibrary[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [prefs, setPrefs] = usePersistent<{ scope: string; view: "grid" | "list"; sort: Sort }>("home", { scope: "all", view: "grid", sort: "updated" });
  // The bin and the settings are passing visits: the page comes back to the list it showed.
  const [visit, setVisit] = useState<Scope | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [batch, setBatch] = useState("");
  const [refreshing, setRefreshing] = useState("");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [sideOpen, setSideOpen] = useState(false);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || "");
  const [run] = useAction();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();
  const [openMenu, menu] = useContextMenu();
  const search = useRef<HTMLInputElement>(null);
  const anchor = useRef("");
  const scope = visit ?? parseScope(prefs.scope, repos);

  // Only the newest answer counts when several loads overlap (events arrive in bursts).
  const loads = useRef(0);
  const load = async () => {
    const turn = ++loads.current;
    try {
      const [list, bin, repoList] = await Promise.all([api<WorkSummary[]>("/api/works"), api<WorkSummary[]>("/api/works?trash=1"), api<Repo[]>("/api/repos")]);
      const libraries = (
        await Promise.all(
          repoList
            .filter((repo) => repo.ready)
            .flatMap((repo) =>
              (["materials", "experience"] as const).map((kind) =>
                api<Omit<BinnedLibrary, "repo" | "kind">[]>(`/api/repos/${encodeURIComponent(repo.id)}/${kind}/trash`).then(
                  (items) => items.map((item) => ({ ...item, repo: repo.id, kind })),
                  () => [],
                ),
              ),
            ),
        )
      ).flat();
      if (turn !== loads.current) return;
      setWorks(list);
      setTrash(bin);
      setBinned(libraries);
      setRepos(repoList);
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      if (turn === loads.current) setLoading(false);
    }
  };
  const loadAccounts = () => api<Account[]>("/api/github/accounts").then(setAccounts, () => {});
  useEffect(() => {
    document.title = "FRAME Studio";
    void load();
    void loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Newer versions on GitHub (other devices) show on the cards: refresh what GitHub has, once per visit.
  const fetched = useRef(new Set<string>());
  useEffect(() => {
    for (const repo of repos)
      if (repo.remote && repo.ready && !fetched.current.has(repo.id) && Date.now() - Date.parse(repo.fetchedAt || "0") > 60000) {
        fetched.current.add(repo.id);
        void api(`/api/repos/${repo.id}/fetch`, { method: "POST" }).catch(() => {});
      }
  }, [repos]);
  // Files of a work changed (the AI or another window at work): list again once it calms down,
  // which also has the server make that work's cover anew.
  const later = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(later.current), []);
  useServerEvent((event) => {
    if (event.type === "works" || event.type === "repos") void load();
    // Libraries moved into or out of a bin, among other library changes.
    if (event.type === "work-files" || event.type === "materials" || event.type === "experience-files") {
      clearTimeout(later.current);
      later.current = setTimeout(() => void load(), 4000);
    }
    // A cover made in the background: only that card changes.
    if (event.type === "work-cover") {
      const patch = (list: WorkSummary[]) =>
        list.map((work) => (work.repo === event.repo && work.id === event.work ? { ...work, cover: String(event.cover || "") } : work));
      setWorks(patch);
      setTrash(patch);
    }
    if (event.type === "settings" && event.key === "github") void loadAccounts();
  });
  // A selection follows the list: works that left it (moved to the bin, deleted elsewhere) drop out.
  useEffect(() => {
    setSelected((current) => {
      const keys = new Set(works.map(workKey));
      const next = new Set([...current].filter((key) => keys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [works]);

  const go = (next: Scope) => {
    if (next.kind === "trash" || next.kind === "settings") setVisit(next);
    else {
      setVisit(null);
      setPrefs((current) => ({ ...current, scope: scopeKey(next) }));
    }
    setSelected(new Set());
    setSideOpen(false);
  };

  // ---- what the current view lists ----------------------------------------------------
  const repoOf = (work: WorkSummary) => repos.find((repo) => repo.id === work.repo);
  const attention = works.filter(needsAttention);
  const inScope =
    scope.kind === "recent"
      ? works.filter((work) => work.openedAt)
      : scope.kind === "attention"
        ? attention
        : scope.kind === "repo"
          ? works.filter((work) => work.repo === scope.repo)
          : works;
  const searched = inScope.filter((work) => matches(work, query));
  const filters = FILTERS.map((item) => ({ ...item, count: searched.filter(item.test).length })).filter(
    (item) => item.id === "all" || item.id === filter || item.count > 0,
  );
  const sort: Sort = scope.kind === "recent" ? "opened" : prefs.sort;
  const visible = sortWorks(searched.filter((FILTERS.find((item) => item.id === filter) ?? FILTERS[0]).test), sort);
  const showRepo = repos.length > 1 && scope.kind !== "repo";
  // Cards name repositories without the owner, unless two would read the same.
  const labels = new Map(
    repos.map((repo) => {
      const short = repoName(repo).name;
      return [repo.id, repos.filter((other) => repoName(other).name === short).length > 1 ? repo.name : short];
    }),
  );
  const states = new Map<string, RepoState>(
    repos.map((repo) => {
      const own = works.filter((work) => work.repo === repo.id);
      const conflicts = own.filter(conflicted).length;
      const unpushed = repo.remote
        ? own.filter((work) => work.location === "local" || (work.location === "both" && !work.synced && !work.remoteNewer)).length
        : 0;
      const issue = conflicts
        ? { tone: "danger" as const, text: `${conflicts} 个作品与 GitHub 冲突` }
        : unpushed
          ? { tone: "warn" as const, text: `${unpushed} 个作品还没同步到 GitHub` }
          : undefined;
      return [repo.id, { count: own.length, issue }];
    }),
  );

  // ---- selection ----------------------------------------------------------------------
  const flip = (key: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const toggle = (work: WorkSummary, event: React.MouseEvent | React.KeyboardEvent) => {
    const key = workKey(work);
    const keys = visible.map(workKey);
    const from = keys.indexOf(anchor.current);
    if (event.shiftKey && from >= 0) {
      const to = keys.indexOf(key);
      setSelected((current) => new Set([...current, ...keys.slice(Math.min(from, to), Math.max(from, to) + 1)]));
    } else flip(key);
    anchor.current = key;
  };
  const activate = (work: WorkSummary, event: React.MouseEvent | React.KeyboardEvent) => {
    if (selected.size || event.shiftKey || event.ctrlKey || event.metaKey) toggle(work, event);
    else openWork(work);
  };
  const listing = scope.kind === "all" || scope.kind === "recent" || scope.kind === "repo";
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (document.querySelector(".dialog-backdrop")) return;
      const target = event.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable;
      if (event.key === "Escape" && selected.size) setSelected(new Set());
      else if (!typing && event.key === "/" && listing) {
        event.preventDefault();
        search.current?.focus();
      } else if (!typing && listing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelected(new Set(visible.map(workKey)));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });

  // ---- actions on works -----------------------------------------------------------------
  // Works of the local repository (no GitHub) can move to another repository.
  const movable = (work: WorkSummary) => Boolean(repoOf(work) && !repoOf(work)?.remote);
  const moveWorks = (list: WorkSummary[]) => setDialog({ kind: "move", works: list.map(({ repo, id, title }) => ({ repo, id, title })) });
  // The list is reloaded here too, not only on the server's event (a slow or dropped connection).
  const keepWork = (work: WorkSummary) => run(() => del(`/api/works/${work.repo}/${work.id}/delete-request`).then(load), `已保留「${work.title}」`);
  const confirmDelete = (work: WorkSummary) => run(() => del(`/api/works/${work.repo}/${work.id}`).then(load), `已把「${work.title}」移到回收站`);
  const workMenu = (work: WorkSummary) => (event: React.MouseEvent) =>
    openMenu(menuPoint(event), [
      { label: "打开", onClick: () => openWork(work) },
      { label: selected.has(workKey(work)) ? "取消选择" : "选择", icon: <SquareCheck size={14} />, onClick: () => flip(workKey(work)) },
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
      ...(movable(work) ? [{ label: "迁移到作品库…", icon: <FolderOutput size={14} />, onClick: () => moveWorks([work]) }] : []),
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

  // Batch actions go one work at a time; failures are listed, the rest still happens.
  const chosen = works.filter((work) => selected.has(workKey(work)));
  const freeable = chosen.filter((work) => work.location === "both" && work.synced);
  const moving = chosen.filter(movable);
  const each = async (list: WorkSummary[], verb: string, action: (work: WorkSummary) => Promise<unknown>) => {
    const failed: string[] = [];
    for (const [index, work] of list.entries()) {
      setBatch(`正在${verb} ${index + 1}/${list.length}`);
      try {
        await action(work);
      } catch (error) {
        failed.push(`「${work.title}」：${(error as Error).message}`);
      }
    }
    setBatch("");
    setSelected(new Set());
    await load();
    return failed;
  };
  const trashChosen = async () => {
    const list = chosen;
    const ok = await confirm(
      <>
        把选中的 {list.length} 个作品移到回收站？
        <br />
        GitHub 上的分支也会改名为 trash/&lt;id&gt;，可以在回收站中恢复。
      </>,
      { confirm: "移到回收站", danger: true },
    );
    if (!ok) return;
    const failed = await each(list, "移到回收站", (work) => del(`/api/works/${work.repo}/${work.id}`));
    if (failed.length) toast(`${list.length - failed.length} 个已移到回收站，${failed.length} 个没有成功：\n${failed.join("\n")}`, "error");
    else toast(`已把 ${list.length} 个作品移到回收站`, "ok");
  };
  const freeChosen = async () => {
    const list = freeable;
    const skipped = chosen.length - list.length;
    const ok = await confirm(
      <>
        删除本机上的 {list.length} 个作品，只保留 GitHub 上的；以后打开时会重新下载。
        {skipped > 0 && (
          <>
            <br />
            另外 {skipped} 个只在本机、只在 GitHub 或有还没同步的版本，会跳过。
          </>
        )}
      </>,
      { confirm: "释放空间" },
    );
    if (!ok) return;
    let total = 0;
    const failed = await each(list, "释放", async (work) => {
      total += (await api<{ freed: number }>(`/api/works/${work.repo}/${work.id}/free`, { method: "POST" })).freed;
    });
    if (failed.length) toast(`释放了 ${formatBytes(total)}；${failed.length} 个没有成功：\n${failed.join("\n")}`, "error");
    else toast(`已释放 ${formatBytes(total)}，这些作品保留在 GitHub 上`, "ok");
  };

  // ---- actions on repositories --------------------------------------------------------
  const refresh = async (repo: Repo) => {
    setRefreshing(repo.id);
    await run(() => api(`/api/repos/${repo.id}/fetch`, { method: "POST" }), "已从 GitHub 刷新");
    setRefreshing("");
  };
  const importInto = async (repo: Repo) => {
    const source = await prompt("导入作品文件夹（本机路径，文件夹内需有 project.ts）", "", "/path/to/projects/my-film");
    if (source) await run(() => api<{ id: string; repo: string }>("/api/works/import", { body: { source, repo: repo.id } }).then(openWork), "已导入");
  };
  const repoMenu = (repo: Repo, event: React.MouseEvent) => {
    const page = githubPage(repo.remote);
    const items: MenuItem[] = [
      { label: "新建作品", icon: <Plus size={14} />, onClick: () => setDialog({ kind: "new", repo: repo.id }) },
      ...(repo.remote ? [{ label: "从 GitHub 刷新", icon: <RefreshCw size={14} />, onClick: () => refresh(repo) }] : []),
      ...(page ? [{ label: "在 GitHub 上打开", icon: <ExternalLink size={14} />, onClick: () => window.open(page, "_blank", "noopener") }] : []),
      ...(local ? [{ label: "导入作品文件夹…", icon: <FolderInput size={14} />, onClick: () => importInto(repo) }] : []),
      ...(repo.remote
        ? [{ label: "GitHub 账号…", icon: <KeyRound size={14} />, onClick: () => setDialog({ kind: "account", repo }) }]
        : [{ label: "发布到 GitHub…", icon: <CloudUpload size={14} />, onClick: () => setDialog({ kind: "publish" }) }]),
      ...(!repo.remote && works.some((work) => work.repo === repo.id)
        ? [{ label: "迁移全部作品到…", icon: <FolderOutput size={14} />, onClick: () => moveWorks(works.filter((work) => work.repo === repo.id)) }]
        : []),
      { label: "回收站", icon: <Trash2 size={14} />, onClick: () => go({ kind: "trash", repo: repo.id }) },
      ...(repo.id === "local"
        ? []
        : ["separator" as const, { label: "取消链接…", icon: <Unlink size={14} />, danger: true, onClick: () => setDialog({ kind: "unlink", repo }) }]),
    ];
    openMenu(menuPoint(event), items);
  };

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("frame:theme", next);
    setTheme(next);
  };

  // ---- the page ---------------------------------------------------------------------------
  const nav = () => setSideOpen(true);
  const newWork = (repo?: string) => setDialog({ kind: "new", repo });
  const unlinking = dialog?.kind === "unlink" ? dialog.repo : null;
  const account = dialog?.kind === "account" ? dialog.repo : null;

  let main: ReactNode;
  if (scope.kind === "trash")
    main = <TrashView items={trash} libraries={binned} repos={repos} repo={scope.repo} onRepo={(repo) => go({ kind: "trash", repo })} onChanged={load} onNav={nav} />;
  else if (scope.kind === "settings")
    main = (
      <>
        <PageHead icon={<SettingsIcon size={18} />} title="设置" onNav={nav} />
        <div className="home-content home-settings">
          <SettingsView initial={scope.section} key={scope.section} />
        </div>
      </>
    );
  else {
    const repo = scope.kind === "repo" ? repos.find((item) => item.id === scope.repo) : undefined;
    const head = repo ? (
      <RepoHead
        repo={repo}
        works={works.filter((work) => work.repo === repo.id)}
        accounts={accounts}
        refreshing={refreshing === repo.id}
        onRefresh={() => refresh(repo)}
        onNew={() => newWork(repo.id)}
        onMenu={(event) => repoMenu(repo, event)}
        onAccount={() => setDialog({ kind: "account", repo })}
        onNav={nav}
      />
    ) : (
      <PageHead
        icon={scope.kind === "recent" ? <Clock size={18} /> : scope.kind === "attention" ? <TriangleAlert size={18} /> : <LayoutGrid size={18} />}
        title={scope.kind === "recent" ? "最近打开" : scope.kind === "attention" ? "需要处理" : "全部作品"}
        meta={
          scope.kind === "recent" ? (
            <span>最近在这台电脑上打开过的作品</span>
          ) : scope.kind === "attention" ? (
            <span>AI 请求删除、和 GitHub 上的版本冲突或无法读取的作品</span>
          ) : (
            <>
              <span>{works.length} 个作品</span>
              {repos.length > 1 && <span>{repos.length} 个作品库</span>}
            </>
          )
        }
        actions={
          <button className="btn primary home-head-new" onClick={() => newWork()}>
            <Plus size={14} /> 新建
          </button>
        }
        onNav={nav}
      />
    );
    const pending = scope.kind === "attention" ? [] : inScope.filter(needsAttention);
    const itemProps = (work: WorkSummary) => ({
      work,
      repoLabel: showRepo ? labels.get(work.repo) : undefined,
      remote: Boolean(repoOf(work)?.remote),
      opened: scope.kind === "recent",
      selected: selected.has(workKey(work)),
      onActivate: (event: React.MouseEvent | React.KeyboardEvent) => activate(work, event),
      onToggle: (event: React.MouseEvent) => toggle(work, event),
      onMenu: workMenu(work),
    });
    main = (
      <>
        {head}
        {scope.kind !== "attention" && (inScope.length > 0 || query || filter !== "all") && (
          <Toolbar
            search={search}
            query={query}
            onQuery={setQuery}
            filters={filters}
            filter={filter}
            onFilter={setFilter}
            sort={scope.kind === "recent" ? undefined : prefs.sort}
            onSort={(sort) => setPrefs((current) => ({ ...current, sort }))}
            view={prefs.view}
            onView={(view) => setPrefs((current) => ({ ...current, view }))}
          />
        )}
        <div className={`home-content ${selected.size ? "selecting" : ""}`}>
          <AttentionBanner works={pending} onShow={() => go({ kind: "attention" })} />
          {loading ? (
            <div className="work-grid" aria-busy="true">
              {Array.from({ length: 8 }, (_, index) => (
                <div className="work-card skeleton" key={index} />
              ))}
            </div>
          ) : works.length === 0 && trash.length === 0 && scope.kind !== "repo" ? (
            <Welcome onNew={() => newWork()} onConnect={() => setDialog({ kind: "connect" })} onSettings={() => go({ kind: "settings", section: "ai" })} />
          ) : scope.kind === "attention" ? (
            <Attention works={visible} repoName={(work) => repoOf(work)?.name ?? work.repo} onKeep={keepWork} onDelete={confirmDelete} onMenu={workMenu} />
          ) : !visible.length ? (
            query || filter !== "all" ? (
              <Empty icon={<Search size={28} />} title="没有符合条件的作品">
                <button
                  className="btn"
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                  }}
                >
                  清除筛选
                </button>
              </Empty>
            ) : scope.kind === "recent" ? (
              <Empty icon={<Clock size={28} />} title="还没有在这台电脑上打开过作品">
                <button className="btn" onClick={() => go({ kind: "all" })}>
                  查看全部作品
                </button>
              </Empty>
            ) : (
              <Empty icon={<LayoutGrid size={28} />} title="这个作品库还没有作品">
                <div className="row">
                  <button className="btn primary" onClick={() => newWork(repo?.id)}>
                    <Plus size={14} /> 新建作品
                  </button>
                  {local && repo && (
                    <button className="btn" onClick={() => importInto(repo)}>
                      <FolderInput size={14} /> 导入作品文件夹
                    </button>
                  )}
                </div>
              </Empty>
            )
          ) : prefs.view === "list" ? (
            <div className={`work-list ${showRepo ? "with-repo" : ""}`}>
              <WorkListHead repo={showRepo} opened={scope.kind === "recent"} />
              {visible.map((work) => (
                <WorkRow key={workKey(work)} {...itemProps(work)} showRepo={showRepo} />
              ))}
            </div>
          ) : (
            <div className="work-grid">
              {visible.map((work) => (
                <WorkCard key={workKey(work)} {...itemProps(work)} />
              ))}
            </div>
          )}
        </div>
        {selected.size > 0 && (
          <SelectionBar
            count={chosen.length}
            total={visible.length}
            batch={batch}
            free={chosen.some((work) => repoOf(work)?.remote) ? freeable.length : null}
            move={moving.length || null}
            onAll={() => setSelected(new Set(visible.map(workKey)))}
            onFree={freeChosen}
            onMove={() => moveWorks(moving)}
            onTrash={trashChosen}
            onClear={() => setSelected(new Set())}
          />
        )}
      </>
    );
  }

  return (
    <div className="home">
      <HomeSidebar
        scope={scope}
        go={go}
        repos={repos}
        states={states}
        counts={{ all: works.length, recent: works.filter((work) => work.openedAt).length, attention: attention.length, trash: trash.length + binned.length }}
        version={version}
        theme={theme}
        onTheme={toggleTheme}
        onNew={() => newWork(scope.kind === "repo" ? scope.repo : undefined)}
        onConnect={() => setDialog({ kind: "connect" })}
        onRepoMenu={repoMenu}
        open={sideOpen}
        onClose={() => setSideOpen(false)}
      />
      <main className="home-main">{main}</main>
      {dialog?.kind === "new" && <NewWorkDialog defaultRepo={dialog.repo ?? "local"} onClose={() => setDialog(null)} />}
      {(dialog?.kind === "connect" || dialog?.kind === "publish") && (
        <RepoDialog
          mode={dialog.kind === "publish" ? "publish" : "clone"}
          linked={repos.map((repo) => repo.remote).filter(Boolean)}
          onClose={() => setDialog(null)}
          onDone={load}
        />
      )}
      {unlinking && (
        <UnlinkDialog
          repo={unlinking}
          onClose={() => setDialog(null)}
          onDone={() => {
            if (scope.kind === "repo" && scope.repo === unlinking.id) go({ kind: "all" });
            void load();
          }}
        />
      )}
      {dialog?.kind === "move" && (
        <MoveWorkDialog
          works={dialog.works}
          onClose={() => setDialog(null)}
          onMoved={() => {
            setSelected(new Set());
            void load();
          }}
          onConnect={() => setDialog({ kind: "connect" })}
        />
      )}
      {account && (
        <AccountDialog
          repo={account}
          accounts={accounts}
          onClose={() => setDialog(null)}
          onDone={load}
          onSettings={() => {
            setDialog(null);
            go({ kind: "settings", section: "github" });
          }}
        />
      )}
      {menu}
    </div>
  );
}
