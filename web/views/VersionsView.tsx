import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  BarChart3,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CloudUpload,
  FileDiff,
  GitBranch,
  History,
  Library,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Save,
  Undo2,
} from "lucide-react";
import { api, timeAgo, workPath, experiencePath, materialsPath, skillsPath, useServerEvent, type ApiError } from "../lib/api";
import { useAction, useConfirm, useContextMenu, usePersistent, useToast } from "../lib/ui";
import type { Version, WorkInfo, WorkStatus } from "../lib/types";
import { useWorkbench, type VersionSource } from "../workbench/store";
import { RepoDialog } from "../components/RepoDialog";
import { MoveWorkDialog } from "../components/MoveWorkDialog";
import { RemoteBar, useRemoteState } from "../workbench/RemoteBar";
import { reviewsPath } from "../lib/reviews";
import { ViewHeader } from "./ViewHeader";

const statusLabel: Record<string, string> = { M: "修改", A: "新增", D: "删除", "?": "新增", R: "重命名", U: "冲突", C: "复制", T: "类型改变" };
export const SOURCE_NAMES: Record<VersionSource, string> = { work: "作品", experience: "经验库", materials: "素材库", reviews: "复盘资料", skills: "技能" };
const SOURCE_ICONS: Record<VersionSource, typeof GitBranch> = { work: GitBranch, experience: BookOpen, materials: Library, reviews: BarChart3, skills: Puzzle };
/** Each library of these kinds is a branch of its own, with its own versions. */
type LibraryKind = "experience" | "materials";
const LIBRARY_KINDS: LibraryKind[] = ["experience", "materials"];
const isLibraryKind = (source: VersionSource): source is LibraryKind => source === "experience" || source === "materials";
/** Versions a history page shows; more on request. */
const PAGE = 50;

/** A library as the 版本与同步 view lists it (`<kind>/versions`). */
interface LibraryVersions {
  id: string;
  title: string;
  files: number;
  head: { commit: string; message: string; date: string } | null;
  ahead: number;
  behind: number;
}

/** The API base of what has versions: the work, one library (`library`), or the repository's reviews or skills. */
export const versionsBase = (source: VersionSource, repo: string, id: string, library?: string) =>
  isLibraryKind(source)
    ? `${source === "experience" ? experiencePath(repo) : materialsPath(repo)}${library ? `/libraries/${encodeURIComponent(library)}` : ""}`
    : source === "reviews"
      ? reviewsPath(repo)
      : source === "skills"
        ? skillsPath(repo)
        : workPath(repo, id);
/** The server's name of it in events: the work's id, a library's branch, the reviews' or skills' scope. */
export const scopeOf = (source: VersionSource, repo: string, id: string, library?: string) =>
  source === "work" ? id : isLibraryKind(source) ? `${source}/${library}` : `${source}-${repo}`;

/** The libraries of each kind this work links, by id. */
const linkedIds = (work: WorkInfo, kind: LibraryKind) => (kind === "experience" ? work.meta?.experiences : work.meta?.materials) ?? [];

/**
 * The libraries this work links (both kinds, in the work's order) with their unsaved changes
 * and last versions, kept up to date. The repository's other libraries are not listed here.
 */
function useLibraryVersions(refresh: number) {
  const { work } = useWorkbench();
  const [lists, setLists] = useState<Record<LibraryKind, LibraryVersions[] | null>>({ experience: null, materials: null });
  const load = (kind: LibraryKind) =>
    api<LibraryVersions[]>(`${versionsBase(kind, work.repo, work.id)}/versions`).then(
      (list) => setLists((current) => ({ ...current, [kind]: list })),
      () => setLists((current) => ({ ...current, [kind]: [] })),
    );
  useEffect(() => {
    void load("experience");
    void load("materials");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [work.repo, refresh]);
  useServerEvent(
    (event) => {
      if (event.type === "experience-files" && event.repo === work.repo) void load("experience");
      if (event.type === "materials" && event.repo === work.repo) void load("materials");
      if (event.type === "work-versions" || event.type === "repos")
        for (const kind of LIBRARY_KINDS) if (event.type === "repos" || String(event.work).startsWith(kind + "/")) void load(kind);
    },
    [work.repo],
  );
  const linked = (kind: LibraryKind) =>
    lists[kind] &&
    linkedIds(work, kind).flatMap((id) => {
      const library = lists[kind]!.find((item) => item.id === id);
      return library ? [library] : [];
    });
  return { experience: linked("experience"), materials: linked("materials") };
}

/**
 * 版本与同步, like VS Code's Source Control: what has versions — the work, each experience and
 * material library (a branch each, listed under their kind) and the repository's reviews and skills —
 * each with where it stands; the one picked shows its unsaved changes and history below (a
 * version opens to the files it changed, a file opens its change in a tab), saving and GitHub sync.
 */
export function VersionsView() {
  const { work, versionSource, versionLibrary, showVersions } = useWorkbench();
  const [refresh, setRefresh] = useState(0);
  // The review and skill branches exist once a review was recorded, a skill saved.
  const [reviews, setReviews] = useState(false);
  const [skills, setSkills] = useState(false);
  const libraries = useLibraryVersions(refresh);
  const [expanded, setExpanded] = usePersistent<Partial<Record<LibraryKind, boolean>>>("versions-expanded", { experience: true, materials: true });
  const source = (versionSource === "reviews" && !reviews) || (versionSource === "skills" && !skills) ? "work" : versionSource;
  // The library shown of a kind: the one picked last, else the first one.
  const libraryOf = (kind: LibraryKind) => {
    const list = libraries[kind] ?? [];
    return list.find((item) => item.id === versionLibrary[kind]) ?? list[0] ?? null;
  };
  const library = isLibraryKind(source) ? libraryOf(source) : null;
  const refreshAll = () => {
    const bases = [
      versionsBase("work", work.repo, work.id),
      ...(reviews ? [versionsBase("reviews", work.repo, work.id)] : []),
      ...(skills ? [versionsBase("skills", work.repo, work.id)] : []),
      ...LIBRARY_KINDS.flatMap((kind) => (libraries[kind] ?? []).map((item) => versionsBase(kind, work.repo, work.id, item.id))),
    ];
    return Promise.all(
      bases.flatMap((base) => [api(`${base}/sync`, { method: "POST" }), api(`${base}/remote/check`, { method: "POST" })].map((call) => call.catch(() => null))),
    ).then(() => setRefresh(Date.now()));
  };
  return (
    <div className="view">
      <ViewHeader title="版本与同步">
        <button className="icon-btn" title="刷新全部，并和 GitHub 比较" onClick={refreshAll}>
          <RefreshCw size={15} />
        </button>
      </ViewHeader>
      <div className="branch-list">
        <BranchRow source="work" selected={source === "work"} refresh={refresh} onSelect={() => showVersions("work")} />
        {LIBRARY_KINDS.map((kind) => (
          <LibraryGroup
            key={kind}
            kind={kind}
            list={libraries[kind]}
            expanded={expanded[kind] !== false}
            onToggle={() => setExpanded((current) => ({ ...current, [kind]: current[kind] === false }))}
            selected={source === kind ? (library?.id ?? null) : null}
            onSelect={(id) => showVersions(kind, id)}
          />
        ))}
        <BranchRow source="reviews" selected={source === "reviews"} refresh={refresh} onSelect={() => showVersions("reviews")} onPresence={setReviews} />
        <BranchRow source="skills" selected={source === "skills"} refresh={refresh} onSelect={() => showVersions("skills")} onPresence={setSkills} />
      </div>
      {isLibraryKind(source) ? (
        library ? (
          <VersionsPanel key={`${source}/${library.id}`} source={source} library={library.id} title={library.title} refresh={refresh} />
        ) : (
          <p className="view-hint">
            本作品没有{source === "materials" ? "引用" : "关联"}{SOURCE_NAMES[source]}。这里只列出本作品的{SOURCE_NAMES[source]}，在「{SOURCE_NAMES[source]}」选项卡（管理…）里{source === "materials" ? "引用" : "关联"}或新建，每个
            {SOURCE_NAMES[source]}有自己的版本。
          </p>
        )
      ) : (
        <VersionsPanel key={source} source={source} refresh={refresh} />
      )}
    </div>
  );
}

/** How a branch stands: unsaved changes or its last version. */
const standing = (changes: number, head: { date: string; message: string } | null) =>
  changes ? `${changes} 个未保存的修改` : head ? `${timeAgo(head.date)}保存 · ${head.message}` : "还没有版本";

/** Versions only here (↑) and only on GitHub (↓). */
function AheadBehind({ ahead, behind }: { ahead: number; behind: number }) {
  return (
    <>
      {ahead > 0 && (
        <span className="faint small-text" title="还没推送到 GitHub 的版本">
          <ArrowUp size={11} />
          {ahead}
        </span>
      )}
      {behind > 0 && (
        <span className="faint small-text" title="GitHub 上更新的版本">
          <ArrowDown size={11} />
          {behind}
        </span>
      )}
    </>
  );
}
const troubled = (state: { state: string } | null) => Boolean(state && ["behind", "diverged", "conflict", "error"].includes(state.state));

/** The work, the reviews or the skills: its name, unsaved changes or last version, versions to push or pull, trouble with GitHub. */
function BranchRow({
  source,
  selected,
  refresh,
  onSelect,
  onPresence,
}: {
  source: "work" | "reviews" | "skills";
  selected: boolean;
  refresh: number;
  onSelect: () => void;
  onPresence?: (present: boolean) => void;
}) {
  const { work } = useWorkbench();
  const base = versionsBase(source, work.repo, work.id);
  const scope = scopeOf(source, work.repo, work.id);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [remote] = useRemoteState(`${base}/remote`, work.repo, scope);
  const load = () => api<WorkStatus>(`${base}/status`).then(setStatus, () => setStatus(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, refresh]);
  useServerEvent((event) => {
    if ((event.type === "work-files" || event.type === "work-versions") && event.work === scope) void load();
    if (source !== "work" && event.type === source && event.repo === work.repo) void load();
  });
  // No review data or skills yet: no branch to show.
  const present = Boolean(status && (source === "work" || status.head || status.files.length));
  useEffect(() => onPresence?.(present), [present, onPresence]);
  if (!status || !present) return null;
  const Icon = SOURCE_ICONS[source];
  const changes = status.files.length;
  return (
    <div className={`branch-row ${selected ? "selected" : ""}`} title={`${SOURCE_NAMES[source]}的版本与同步`} onClick={onSelect}>
      <Icon size={14} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">{SOURCE_NAMES[source]}</div>
        <div className="faint small-text ellipsis">{standing(changes, status.head)}</div>
      </div>
      {changes > 0 && <span className="badge accent">{changes}</span>}
      <AheadBehind ahead={status.ahead} behind={status.behind} />
      {troubled(remote) && <AlertTriangle size={14} className="warn-text" aria-label="和 GitHub 不同步" />}
    </div>
  );
}

/** The experience or material libraries: a row for the kind (folding), and below it one row per library. */
function LibraryGroup({
  kind,
  list,
  expanded,
  onToggle,
  selected,
  onSelect,
}: {
  kind: LibraryKind;
  list: LibraryVersions[] | null;
  expanded: boolean;
  onToggle: () => void;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (!list) return null;
  const Icon = SOURCE_ICONS[kind];
  const changes = list.reduce((sum, item) => sum + item.files, 0);
  const open = expanded && list.length > 0;
  return (
    <>
      <div className="branch-row" title={`本作品${kind === "materials" ? "引用" : "关联"}的${SOURCE_NAMES[kind]}：每个是一个分支，版本、修改和同步各自独立`} onClick={onToggle}>
        <Icon size={14} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="ellipsis">{SOURCE_NAMES[kind]}</div>
          <div className="faint small-text ellipsis">
            {list.length
              ? `本作品的 ${list.length} 个${changes ? ` · ${changes} 个未保存的修改` : ""}`
              : `本作品没有${kind === "materials" ? "引用" : "关联"}${SOURCE_NAMES[kind]}`}
          </div>
        </div>
        {!open && changes > 0 && <span className="badge accent">{changes}</span>}
        {list.length > 0 && (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
      </div>
      {open && list.map((item) => <LibraryRow key={item.id} kind={kind} library={item} selected={item.id === selected} onSelect={() => onSelect(item.id)} />)}
    </>
  );
}

/** One library: its title (and id when they differ), unsaved changes or last version, versions to push or pull, trouble with GitHub. */
function LibraryRow({ kind, library, selected, onSelect }: { kind: LibraryKind; library: LibraryVersions; selected: boolean; onSelect: () => void }) {
  const { work } = useWorkbench();
  const [remote] = useRemoteState(`${versionsBase(kind, work.repo, work.id, library.id)}/remote`, work.repo, scopeOf(kind, work.repo, work.id, library.id));
  return (
    <div
      className={`branch-row branch-child ${selected ? "selected" : ""}`}
      title={`${SOURCE_NAMES[kind]}「${library.title}」的版本与同步（分支 ${kind}/${library.id}）`}
      onClick={onSelect}
    >
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">
          {library.title}
          {library.title !== library.id && <span className="faint small-text"> {library.id}</span>}
        </div>
        <div className="faint small-text ellipsis">{standing(library.files, library.head)}</div>
      </div>
      {library.files > 0 && <span className="badge accent">{library.files}</span>}
      <AheadBehind ahead={library.ahead} behind={library.behind} />
      {troubled(remote) && <AlertTriangle size={14} className="warn-text" aria-label="和 GitHub 不同步" />}
    </div>
  );
}

/**
 * Saving versions, unsaved changes, history and GitHub sync of the work, one library (its own
 * branch) or the repository's reviews (same API on another branch). Changes open as diff tabs.
 */
export function VersionsPanel({ source, library, title, refresh = 0 }: { source: VersionSource; library?: string; title?: string; refresh?: number }) {
  const { work, reload: reloadWork, openDiff, readOnly } = useWorkbench();
  // Shared branches use the work's version UI; the reviews and the skills save every change at once.
  const shared = source !== "work";
  const autosaved = source === "reviews" || source === "skills";
  // A published work keeps its history viewable and syncs, but takes no new versions.
  const locked = !shared && readOnly;
  const scope = scopeOf(source, work.repo, work.id, library);
  const reload = shared ? async () => {} : reloadWork;
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [history, setHistory] = useState<Version[]>([]);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [changes, setChanges] = useState<Record<string, { status: string; path: string }[]>>({});
  const [message, setMessage] = useState("");
  const [publish, setPublish] = useState(false);
  const [moving, setMoving] = useState(false);
  const [diverged, setDiverged] = useState(false);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const [openMenu, menu] = useContextMenu();
  const base = versionsBase(source, work.repo, work.id, library);
  const name = library ? `${SOURCE_NAMES[source]}「${title ?? library}」` : SOURCE_NAMES[source];
  // Paths come from the branch's root: a work's are shown as in its folder.
  const prefix = shared ? "" : `projects/${work.slug}/`;
  const short = (file: string) => file.replace(prefix, "");
  const load = async (count = Math.max(PAGE, history.length)) => {
    const [nextStatus, nextHistory] = await Promise.all([api<WorkStatus>(`${base}/status`), api<Version[]>(`${base}/history?limit=${count + 1}`)]);
    setStatus(nextStatus);
    setMore(nextHistory.length > count);
    setHistory(nextHistory.slice(0, count));
  };
  useEffect(() => {
    void load(PAGE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, refresh]);
  useServerEvent((event) => {
    if ((event.type === "work-files" || event.type === "work-versions") && event.work === scope) void load();
    if (source === "experience" && event.type === "experience-files" && event.repo === work.repo) void load();
    if (source === "materials" && event.type === "materials" && event.repo === work.repo) void load();
    if ((source === "reviews" || source === "skills") && event.type === source && event.repo === work.repo) void load();
  });
  const diff = (tab: string, query: string) => openDiff(tab, query, { source, library });

  const commit = () =>
    run(async () => {
      const result = await api<{ commit: string | null }>(`${base}/commit`, { body: { message: message.trim() || "手动保存" } });
      setMessage("");
      await load();
      return result;
    }, "已保存版本");
  const revert = async (version: Version) => {
    if (
      !(await confirm(`把${name}恢复成「${version.message}」时的样子？\n当前内容会先自动保存，恢复本身也会成为一个新版本，随时可以再恢复回来。`, {
        confirm: "恢复",
      }))
    )
      return;
    await run(async () => {
      await api(`${base}/revert`, { body: { commit: version.commit } });
      await load();
      await reload();
    }, "已恢复");
  };
  const discard = async (file?: string) => {
    if (!(await confirm(file ? `放弃对 ${short(file)} 的修改？` : "放弃所有未保存的修改，回到上一个版本？", { confirm: "放弃修改", danger: true }))) return;
    await run(async () => {
      await api(`${base}/discard`, { body: { files: file ? [file] : [] } });
      await load();
    });
  };
  const pull = async () => {
    try {
      await api(`${base}/pull`, { method: "POST" });
    } catch (error) {
      if ((error as ApiError).details && ((error as ApiError).details as { diverged?: boolean }).diverged) setDiverged(true);
      throw error;
    }
  };
  /** Like VS Code's sync: GitHub's newer versions first, then this machine's. */
  const syncNow = () =>
    run(async () => {
      let now = await api<WorkStatus>(`${base}/sync`, { method: "POST" });
      if (now.behind > 0) await pull();
      now = await api<WorkStatus>(`${base}/status`);
      if (now.ahead > 0) await api(`${base}/push`, { method: "POST" });
      await load();
      await reload();
      toast("已和 GitHub 同步", "ok");
    });
  const pullNow = () =>
    run(async () => {
      await pull();
      await load();
      await reload();
    }, "已从 GitHub 拉取");
  const refreshNow = () =>
    run(async () => {
      if (status?.remote) await Promise.all([api(`${base}/sync`, { method: "POST" }), api(`${base}/remote/check`, { method: "POST" }).catch(() => null)]);
      await load();
    });
  const resolve = (strategy: "merge" | "remote") =>
    run(
      async () => {
        await api(`${base}/resolve`, { body: { strategy } });
        setDiverged(false);
        await load();
        await reload();
      },
      strategy === "merge" ? "已合并" : "已采用 GitHub 的版本，本地版本已备份",
    );
  const toggle = (version: Version) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(version.commit)) next.delete(version.commit);
      else next.add(version.commit);
      return next;
    });
    if (!changes[version.commit])
      void api<{ status: string; path: string }[]>(`${base}/changes?commit=${version.commit}`).then(
        (list) => setChanges((map) => ({ ...map, [version.commit]: list })),
        () => setChanges((map) => ({ ...map, [version.commit]: [] })),
      );
  };
  const fileName = (file: string) => file.split("/").pop()!;
  const folderOf = (file: string) => short(file).split("/").slice(0, -1).join("/");

  return (
    <>
      {/* The work's own warning sits above the editor; the shared branches warn here. */}
      {shared && <RemoteBar base={`${base}/remote`} repo={work.repo} scope={scope} what={name} onSettled={() => void load()} />}
      {busy && <div className="view-progress" />}
      <section className="view-section">
        {autosaved ? (
          <p className="view-hint">
            {name}的每次修改都自动保存为一个版本{source === "skills" ? "（AI 的修改在每轮结束时保存）" : ""}。
          </p>
        ) : locked ? (
          <p className="view-hint">作品已发布，不再保存新版本。</p>
        ) : (
          <>
            <textarea
              className="textarea"
              rows={2}
              placeholder={`这个版本改了什么（Ctrl+Enter 保存）`}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && (event.ctrlKey || event.metaKey) && commit()}
            />
            <button className="btn primary versions-save" disabled={!status?.files.length} onClick={commit}>
              <Save size={14} /> 保存版本
            </button>
          </>
        )}
        <div className="row versions-actions">
          {status?.remote ? (
            <>
              <button className="btn small grow" title="和 GitHub 同步：先拉取 GitHub 上更新的版本，再推送本机的版本" onClick={syncNow}>
                <ArrowDownUp size={13} /> 同步{status.ahead || status.behind ? ` ${status.behind ? `↓${status.behind}` : ""}${status.ahead ? ` ↑${status.ahead}` : ""}` : ""}
              </button>
              <button className="btn small grow" title="从 GitHub 拉取" onClick={pullNow}>
                <ArrowDown size={13} /> 拉取
              </button>
            </>
          ) : (
            <button className="btn small grow" title="这个作品库还没有连接 GitHub" onClick={() => setPublish(true)}>
              <CloudUpload size={13} /> 发布到 GitHub
            </button>
          )}
          <button className="btn small grow" title={status?.remote ? "刷新，并和 GitHub 比较" : "刷新"} onClick={refreshNow}>
            <RefreshCw size={13} /> 刷新
          </button>
        </div>
        {!shared && status && !status.remote && (
          <p className="view-hint">
            作品在本地作品库，只保存在这台电脑上。{" "}
            <button className="link-btn" onClick={() => setMoving(true)}>
              迁移到其他作品库…
            </button>
          </p>
        )}
        {diverged && (
          <div className="diverged">
            <p>本地和 GitHub 上都有新的修改：</p>
            <div className="row wrap">
              <button className="btn small" onClick={() => resolve("merge")}>
                合并双方
              </button>
              <button className="btn small" onClick={() => resolve("remote")}>
                采用 GitHub 的版本
              </button>
            </div>
          </div>
        )}
      </section>
      {!autosaved && (
        <section className="view-section">
          <h3>
            未保存的修改 <span className="badge">{status?.files.length ?? 0}</span>
            <span className="grow" />
            {!!status?.files.length && !locked && (
              <button className="icon-btn" title="全部放弃" onClick={() => discard()}>
                <Undo2 size={14} />
              </button>
            )}
          </h3>
          {status?.files.map((file) => (
            <div
              key={file.path}
              className="change-row"
              title={`${short(file.path)}：单击查看改动`}
              onClick={() => diff(`${fileName(file.path)}（未保存）`, `file=${encodeURIComponent(file.path)}`)}
            >
              <span className={`change-status s-${file.status === "?" ? "A" : file.status}`}>{file.status === "?" ? "A" : file.status}</span>
              <span className="ellipsis grow" title={statusLabel[file.status] || file.status}>
                {fileName(file.path)} <span className="faint small-text">{folderOf(file.path)}</span>
              </span>
              {!locked && (
                <button
                  className="icon-btn"
                  title="放弃修改"
                  onClick={(event) => {
                    event.stopPropagation();
                    void discard(file.path);
                  }}
                >
                  <Undo2 size={13} />
                </button>
              )}
            </div>
          ))}
        </section>
      )}
      <section className="view-section">
        <h3>
          <History size={14} /> 历史
        </h3>
        {history.map((version, index) => {
          const expanded = open.has(version.commit);
          const files = changes[version.commit];
          return (
            <div key={version.commit}>
              <div
                className={`version-row ${expanded ? "open" : ""}`}
                title="单击展开改动的文件"
                onClick={() => toggle(version)}
                onContextMenu={(event) =>
                  openMenu(event, [
                    {
                      label: "查看这个版本的全部改动",
                      icon: <FileDiff size={14} />,
                      onClick: () => diff(`${version.short} ${version.message}`, `commit=${version.commit}`),
                    },
                    { label: "恢复到这个版本", icon: <RotateCcw size={14} />, onClick: () => revert(version), disabled: index === 0 || locked },
                  ])
                }
              >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis" title={version.message}>
                    {version.message}
                  </div>
                  <div className="faint small-text">
                    {timeAgo(version.date)} · {version.short}
                    {version.stat
                      ? ` · ${version.stat
                          .replace(/ files? changed/, " 个文件")
                          .replace(/insertions?\(\+\)/, "+")
                          .replace(/deletions?\(-\)/, "-")}`
                      : ""}
                  </div>
                </div>
                {index > 0 && !locked && (
                  <button
                    className="icon-btn"
                    title="恢复到这个版本"
                    onClick={(event) => {
                      event.stopPropagation();
                      void revert(version);
                    }}
                  >
                    <RotateCcw size={13} />
                  </button>
                )}
              </div>
              {expanded && (
                <div className="version-files">
                  {!files && <div className="faint small-text version-file">读取中…</div>}
                  {files?.length === 0 && <div className="faint small-text version-file">没有改动文件</div>}
                  {files?.map((file) => {
                    const title = `${version.short} ${fileName(file.path)}`;
                    const query = `commit=${version.commit}&file=${encodeURIComponent(file.path)}`;
                    return (
                      <div
                        key={file.path}
                        className="version-file"
                        title={`${short(file.path)}：单击查看这个版本对它的改动`}
                        onClick={() => diff(title, query)}
                      >
                        <span className={`change-status s-${file.status}`}>{file.status}</span>
                        <span className="ellipsis grow" title={statusLabel[file.status] || file.status}>
                          {fileName(file.path)} <span className="faint small-text">{folderOf(file.path)}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {!history.length && status && <p className="view-hint">还没有版本。</p>}
        {more && (
          <button className="btn small versions-more" onClick={() => run(() => load(history.length + PAGE))}>
            显示更早的版本
          </button>
        )}
      </section>
      {publish && <RepoDialog mode="publish" onClose={() => setPublish(false)} onDone={() => void load()} />}
      {moving && <MoveWorkDialog works={[{ repo: work.repo, id: work.id, title: work.meta?.title ?? work.id }]} onClose={() => setMoving(false)} />}
      {menu}
    </>
  );
}
