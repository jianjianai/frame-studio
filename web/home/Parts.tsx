import type { ReactNode, RefObject } from "react";
import {
  ArrowUpDown,
  ExternalLink,
  FolderOutput,
  HardDrive,
  HardDriveDownload,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  SquareCheck,
  Tag,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { timeAgo } from "../lib/api";
import type { Repo, WorkSummary } from "../lib/types";
import { navigate } from "../App";
import { GithubIcon } from "../components/icons";
import { Cover } from "./WorkItems";
import { PageHead } from "./PageHead";
import type { Account } from "./RepoDialogs";
import { SORTS, conflicted, githubPage, workKey, type Filter, type Sort } from "./model";

export const openWork = (work: Pick<WorkSummary, "repo" | "id">) => navigate(`/work/${encodeURIComponent(work.repo)}/${encodeURIComponent(work.id)}`);

/** Search, filters with counts, order and grid/list above a list of works. */
export function Toolbar({
  search,
  query,
  onQuery,
  filters,
  filter,
  onFilter,
  sort,
  onSort,
  view,
  onView,
}: {
  search: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (query: string) => void;
  filters: { id: Filter; label: string; count: number }[];
  filter: Filter;
  onFilter: (filter: Filter) => void;
  /** Left out where the view keeps its own order (最近打开). */
  sort?: Sort;
  onSort: (sort: Sort) => void;
  view: "grid" | "list";
  onView: (view: "grid" | "list") => void;
}) {
  return (
    <div className="home-toolbar">
      <label className="home-search">
        <Search size={14} />
        <input
          ref={search}
          placeholder="搜索名称、简介或标签"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => event.key === "Escape" && (onQuery(""), event.currentTarget.blur())}
        />
        {query ? (
          <button className="icon-btn" aria-label="清除搜索" onClick={() => onQuery("")}>
            <X size={13} />
          </button>
        ) : (
          <span className="kbd">/</span>
        )}
      </label>
      <div className="home-chips" role="radiogroup" aria-label="筛选">
        {filters.map((item) => (
          <button key={item.id} role="radio" aria-checked={filter === item.id} className={filter === item.id ? "active" : ""} onClick={() => onFilter(item.id)}>
            {item.label}
            <span>{item.count}</span>
          </button>
        ))}
      </div>
      <span className="grow" />
      {sort && (
        <label className="home-sort" title="排序">
          <ArrowUpDown size={13} />
          <select value={sort} onChange={(event) => onSort(event.target.value as Sort)}>
            {SORTS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="home-segmented" role="radiogroup" aria-label="显示方式">
        {(
          [
            ["grid", "网格", <LayoutGrid size={14} key="grid" />],
            ["list", "列表", <List size={14} key="list" />],
          ] as const
        ).map(([id, label, icon]) => (
          <button key={id} role="radio" aria-checked={view === id} className={view === id ? "active" : ""} title={label} onClick={() => onView(id)}>
            {icon}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One line above the list when works in it wait for the user. */
export function AttentionBanner({ works, onShow }: { works: WorkSummary[]; onShow: () => void }) {
  if (!works.length) return null;
  const kinds = [
    [works.filter((work) => work.deleteRequest).length, "AI 请求删除"],
    [works.filter(conflicted).length, "与 GitHub 冲突"],
    [works.filter((work) => work.error).length, "无法读取"],
  ] as const;
  return (
    <button className="attention-banner" onClick={onShow}>
      <TriangleAlert size={15} />
      <span className="grow">
        {works.length} 个作品需要处理
        <span className="muted">
          {" · "}
          {kinds
            .filter(([count]) => count)
            .map(([count, label]) => `${label} ${count}`)
            .join(" · ")}
        </span>
      </span>
      查看
    </button>
  );
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="home-empty">
      {icon}
      <strong>{title}</strong>
      {children}
    </div>
  );
}

/** Batch actions for the selected works. `free`: how many can keep only their GitHub copy (null: none of them is on GitHub). */
export function SelectionBar({
  count,
  total,
  batch,
  free,
  move,
  onAll,
  onFree,
  onMove,
  onMark,
  onTrash,
  onClear,
}: {
  count: number;
  total: number;
  batch: string;
  free: number | null;
  /** How many of them can move to another repository (works of the local one); null: none. */
  move: number | null;
  onAll: () => void;
  onFree: () => void;
  onMove: () => void;
  /** 草稿, 编辑中 or 废案 for all of them (a menu under the button). */
  onMark: (event: React.MouseEvent) => void;
  onTrash: () => void;
  onClear: () => void;
}) {
  return (
    <div className="selection-bar" role="toolbar" aria-label="批量操作">
      <strong>已选择 {count} 个</strong>
      {count < total && !batch && (
        <button className="btn small ghost" onClick={onAll}>
          全选 {total} 个
        </button>
      )}
      <span className="selection-sep" />
      {batch ? (
        <span className="muted row">
          <span className="spinner" /> {batch}…
        </span>
      ) : (
        <>
          {free !== null && (
            <button
              className="btn small"
              disabled={!free}
              title={free ? "删除本机上的副本，只保留 GitHub 上的" : "选中的作品都不能只保留在 GitHub 上（只在本机、只在 GitHub 或有还没同步的版本）"}
              onClick={onFree}
            >
              <HardDriveDownload size={13} /> 释放本地空间
            </button>
          )}
          {move !== null && (
            <button className="btn small" title="迁移到另一个作品库（只限本地作品库里的作品）" onClick={onMove}>
              <FolderOutput size={13} /> 迁移到…
            </button>
          )}
          <button className="btn small" title="把选中的作品标为草稿、编辑中或废案（已发布的跳过）" onClick={onMark}>
            <Tag size={13} /> 标为…
          </button>
          <button className="btn small danger" onClick={onTrash}>
            <Trash2 size={13} /> 移到回收站
          </button>
        </>
      )}
      <button className="icon-btn" aria-label="取消选择" disabled={Boolean(batch)} onClick={onClear}>
        <X size={14} />
      </button>
    </div>
  );
}

/** Title of a repository's view: where it syncs, with which account, how much is here. */
export function RepoHead({
  repo,
  works,
  accounts,
  refreshing,
  onRefresh,
  onNew,
  onMenu,
  onAccount,
  onNav,
}: {
  repo: Repo;
  works: WorkSummary[];
  accounts: Account[];
  refreshing: boolean;
  onRefresh: () => void;
  onNew: () => void;
  onMenu: (event: React.MouseEvent) => void;
  onAccount: () => void;
  onNav: () => void;
}) {
  const page = githubPage(repo.remote);
  const account = accounts.find((item) => item.id === repo.account);
  const downloaded = works.filter((work) => work.checkedOut).length;
  return (
    <PageHead
      icon={repo.remote ? <GithubIcon size={18} /> : <HardDrive size={18} />}
      title={repo.name}
      meta={
        <>
          {repo.remote ? (
            page ? (
              <a href={page} target="_blank" rel="noreferrer">
                GitHub <ExternalLink size={11} />
              </a>
            ) : (
              <span className="mono ellipsis">{repo.remote}</span>
            )
          ) : (
            <span>只在这台电脑上</span>
          )}
          {repo.remote &&
            (account ? (
              <span>账号 {account.login}</span>
            ) : (
              <button className="link-btn warn-text" onClick={onAccount}>
                {repo.account ? "同步用的账号已移除，点此更换" : "没有使用 GitHub 账号"}
              </button>
            ))}
          <span>
            {works.length} 个作品{repo.remote && works.length ? `，已下载 ${downloaded} 个` : ""}
          </span>
          {repo.remote && repo.fetchedAt && <span>{timeAgo(repo.fetchedAt)}从 GitHub 刷新</span>}
        </>
      }
      actions={
        <>
          {repo.remote && (
            <button className="btn" disabled={refreshing} onClick={onRefresh}>
              <RefreshCw size={13} className={refreshing ? "spin" : ""} /> 刷新
            </button>
          )}
          <button className="btn primary" onClick={onNew}>
            <Plus size={14} /> 新建作品
          </button>
          <button className="icon-btn" aria-label="作品库操作" title="作品库操作" onClick={onMenu}>
            <MoreHorizontal size={16} />
          </button>
        </>
      }
      onNav={onNav}
    />
  );
}

/** Works waiting for the user, grouped by what they wait for. */
export function Attention({
  works,
  repoName,
  onKeep,
  onDelete,
  onMenu,
}: {
  works: WorkSummary[];
  repoName: (work: WorkSummary) => string;
  onKeep: (work: WorkSummary) => void;
  onDelete: (work: WorkSummary) => void;
  onMenu: (work: WorkSummary) => (event: React.MouseEvent) => void;
}) {
  const groups = [
    {
      title: "AI 请求删除",
      note: "AI 不能直接删除作品，只能提出请求。确认删除会把作品移到回收站（可以恢复）；不想删就保留。",
      works: works.filter((work) => work.deleteRequest),
      detail: (work: WorkSummary) => `${work.deleteRequest!.reason || "（AI 没有说明原因）"} · ${timeAgo(work.deleteRequest!.at)}`,
      actions: (work: WorkSummary) => (
        <>
          <button className="btn small" onClick={() => onKeep(work)}>
            保留
          </button>
          <button className="btn small danger" onClick={() => onDelete(work)}>
            确认删除
          </button>
        </>
      ),
    },
    {
      title: "与 GitHub 冲突",
      note: "本机和 GitHub 上都有新的版本。打开作品后选择合并双方、采用 GitHub 的版本或保留本机的版本。",
      works: works.filter(conflicted),
      detail: (work: WorkSummary) => `${repoName(work)} · ${timeAgo(work.updatedAt)}修改`,
      actions: () => null,
    },
    {
      title: "无法读取",
      note: "作品的 project.ts 有错误或文件结构不对。打开后可以看到原因，修好或移到回收站。",
      works: works.filter((work) => work.error),
      detail: (work: WorkSummary) => work.error ?? "",
      actions: () => null,
    },
  ].filter((group) => group.works.length);
  if (!groups.length) return <Empty icon={<SquareCheck size={28} />} title="没有需要处理的作品" />;
  return (
    <>
      {groups.map((group) => (
        <section className="attention-group" key={group.title}>
          <h2>
            {group.title} <span className="faint">{group.works.length}</span>
          </h2>
          <p className="muted small-text">{group.note}</p>
          {group.works.map((work) => (
            <div className="attention-row" key={workKey(work)} onContextMenu={onMenu(work)}>
              <div className="work-row-thumb">
                <Cover work={work} />
              </div>
              <div className="grow trash-info">
                <strong className="ellipsis" title={work.title}>
                  {work.title}
                </strong>
                <span className="muted small-text ellipsis" title={group.detail(work)}>
                  {group.detail(work)}
                </span>
              </div>
              <button className="btn small" onClick={() => openWork(work)}>
                打开
              </button>
              {group.actions(work)}
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

/** First visit: nothing made yet. */
export function Welcome({ onNew, onConnect, onSettings }: { onNew: () => void; onConnect: () => void; onSettings: () => void }) {
  return (
    <section className="home-welcome">
      <h2>用 AI 做视频</h2>
      <p className="muted">描述想要的画面，AI 写代码生成动画、配乐和配音；你在旁边实时预览、提意见、导出。</p>
      <div className="hero-actions">
        <button className="hero-card primary" onClick={onNew}>
          <Plus size={20} />
          <span>
            <strong>新建作品</strong>
            <small>设置画幅和时长，然后和 AI 一起制作</small>
          </span>
        </button>
        <button className="hero-card" onClick={onConnect}>
          <GithubIcon size={20} />
          <span>
            <strong>连接 GitHub 作品库</strong>
            <small>多台电脑同步作品与素材</small>
          </span>
        </button>
        <button className="hero-card" onClick={onSettings}>
          <SettingsIcon size={20} />
          <span>
            <strong>设置 AI</strong>
            <small>登录 Claude / ChatGPT，或添加自定义 API</small>
          </span>
        </button>
      </div>
    </section>
  );
}
