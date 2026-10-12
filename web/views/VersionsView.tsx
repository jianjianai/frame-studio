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
  RefreshCw,
  RotateCcw,
  Save,
  Undo2,
} from "lucide-react";
import { api, timeAgo, workPath, experiencePath, materialsPath, useServerEvent, type ApiError } from "../lib/api";
import { useAction, useConfirm, useContextMenu, useToast } from "../lib/ui";
import type { Version, WorkStatus } from "../lib/types";
import { useWorkbench, type VersionSource } from "../workbench/store";
import { RepoDialog } from "../components/RepoDialog";
import { RemoteBar, useRemoteState } from "../workbench/RemoteBar";
import { reviewsPath } from "../lib/reviews";
import { ViewHeader } from "./ViewHeader";

const statusLabel: Record<string, string> = { M: "修改", A: "新增", D: "删除", "?": "新增", R: "重命名", U: "冲突", C: "复制", T: "类型改变" };
export const SOURCE_NAMES: Record<VersionSource, string> = { work: "作品", experience: "经验库", materials: "素材库", reviews: "复盘资料" };
const SOURCES: VersionSource[] = ["work", "experience", "materials", "reviews"];
const SOURCE_ICONS: Record<VersionSource, typeof GitBranch> = { work: GitBranch, experience: BookOpen, materials: Library, reviews: BarChart3 };
/** Versions a history page shows; more on request. */
const PAGE = 50;

/** The API base of a branch with versions: the work's, or a shared branch of its repository. */
export const versionsBase = (source: VersionSource, repo: string, id: string) =>
  source === "experience" ? experiencePath(repo) : source === "materials" ? materialsPath(repo) : source === "reviews" ? reviewsPath(repo) : workPath(repo, id);
const scopeOf = (source: VersionSource, repo: string, id: string) => (source === "work" ? id : `${source}-${repo}`);

/**
 * 版本与同步, like VS Code's Source Control: the branches with versions — the work, and the
 * repository's experience, material and review branches — each with where it stands; the one
 * picked shows its unsaved changes and history below (a version opens to the files it changed,
 * a file opens its change in a tab), saving and GitHub sync.
 */
export function VersionsView() {
  const { work, versionSource, showVersions } = useWorkbench();
  const [refresh, setRefresh] = useState(0);
  // The review branch exists once a review was recorded.
  const [reviews, setReviews] = useState(false);
  const shown = SOURCES.filter((source) => source !== "reviews" || reviews);
  const source = shown.includes(versionSource) ? versionSource : "work";
  const refreshAll = () =>
    Promise.all(
      shown.flatMap((item) => {
        const base = versionsBase(item, work.repo, work.id);
        return [api(`${base}/sync`, { method: "POST" }), api(`${base}/remote/check`, { method: "POST" })].map((call) => call.catch(() => null));
      }),
    ).then(() => setRefresh(Date.now()));
  return (
    <div className="view">
      <ViewHeader title="版本与同步">
        <button className="icon-btn" title="刷新全部，并和 GitHub 比较" onClick={refreshAll}>
          <RefreshCw size={15} />
        </button>
      </ViewHeader>
      <div className="branch-list">
        {SOURCES.map((item) => (
          <BranchRow
            key={item}
            source={item}
            selected={item === source}
            refresh={refresh}
            onSelect={() => showVersions(item)}
            onPresence={item === "reviews" ? setReviews : undefined}
          />
        ))}
      </div>
      <VersionsPanel key={source} source={source} refresh={refresh} />
    </div>
  );
}

/** One branch: its name, unsaved changes or last version, versions to push or pull, trouble with GitHub. */
function BranchRow({
  source,
  selected,
  refresh,
  onSelect,
  onPresence,
}: {
  source: VersionSource;
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
    if (source === "experience" && event.type === "experience-files" && event.repo === work.repo) void load();
    if (source === "materials" && event.type === "materials" && event.repo === work.repo) void load();
    if (source === "reviews" && event.type === "reviews" && event.repo === work.repo) void load();
  });
  // No review data yet: no branch to show.
  const present = Boolean(status && (source !== "reviews" || status.head || status.files.length));
  useEffect(() => onPresence?.(present), [present, onPresence]);
  if (!status || !present) return null;
  const Icon = SOURCE_ICONS[source];
  const changes = status.files.length;
  const trouble = remote && ["behind", "diverged", "conflict", "error"].includes(remote.state);
  return (
    <div className={`branch-row ${selected ? "selected" : ""}`} title={`${SOURCE_NAMES[source]}的版本与同步`} onClick={onSelect}>
      <Icon size={14} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">{SOURCE_NAMES[source]}</div>
        <div className="faint small-text ellipsis">
          {changes ? `${changes} 个未保存的修改` : status.head ? `${timeAgo(status.head.date)}保存 · ${status.head.message}` : "还没有版本"}
        </div>
      </div>
      {changes > 0 && <span className="badge accent">{changes}</span>}
      {status.ahead > 0 && (
        <span className="faint small-text" title="还没推送到 GitHub 的版本">
          <ArrowUp size={11} />
          {status.ahead}
        </span>
      )}
      {status.behind > 0 && (
        <span className="faint small-text" title="GitHub 上更新的版本">
          <ArrowDown size={11} />
          {status.behind}
        </span>
      )}
      {trouble && <AlertTriangle size={14} className="warn-text" aria-label="和 GitHub 不同步" />}
    </div>
  );
}

/**
 * Saving versions, unsaved changes, history and GitHub sync of the work or one of the
 * repository's shared branches (same API on another branch). Changes open as diff tabs: a
 * click previews, a double-click keeps the tab.
 */
export function VersionsPanel({ source, refresh = 0 }: { source: VersionSource; refresh?: number }) {
  const { work, reload: reloadWork, openDiff, readOnly } = useWorkbench();
  // Shared branches use the work's version UI; the material and review branches save every change at once.
  const shared = source !== "work";
  const autosaved = source === "materials" || source === "reviews";
  // A published work keeps its history viewable and syncs, but takes no new versions.
  const locked = !shared && readOnly;
  const scope = scopeOf(source, work.repo, work.id);
  const reload = shared ? async () => {} : reloadWork;
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [history, setHistory] = useState<Version[]>([]);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [changes, setChanges] = useState<Record<string, { status: string; path: string }[]>>({});
  const [message, setMessage] = useState("");
  const [publish, setPublish] = useState(false);
  const [diverged, setDiverged] = useState(false);
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const [openMenu, menu] = useContextMenu();
  const base = versionsBase(source, work.repo, work.id);
  const name = SOURCE_NAMES[source];
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
    if (source === "reviews" && event.type === "reviews" && event.repo === work.repo) void load();
  });

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
          <p className="view-hint">{name}的每次修改都自动保存为一个版本。</p>
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
              title={`${short(file.path)}：单击查看改动，双击保持打开`}
              onClick={() => openDiff(`${fileName(file.path)}（未保存）`, `file=${encodeURIComponent(file.path)}`, { preview: true, source })}
              onDoubleClick={() => openDiff(`${fileName(file.path)}（未保存）`, `file=${encodeURIComponent(file.path)}`, { preview: false, source })}
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
                      onClick: () => openDiff(`${version.short} ${version.message}`, `commit=${version.commit}`, { preview: false, source }),
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
                        title={`${short(file.path)}：单击查看这个版本对它的改动，双击保持打开`}
                        onClick={() => openDiff(title, query, { preview: true, source })}
                        onDoubleClick={() => openDiff(title, query, { preview: false, source })}
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
      {menu}
    </>
  );
}
