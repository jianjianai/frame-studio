import type { ReactNode } from "react";
import { BarChart3, Clock, HardDrive, LayoutGrid, Moon, MoreHorizontal, Plus, Settings as SettingsIcon, Sun, Trash2, TriangleAlert } from "lucide-react";
import type { Repo } from "../lib/types";
import { navigate } from "../App";
import { GithubIcon } from "../components/icons";
import { repoName, type Scope } from "./model";

function SideItem({
  icon,
  label,
  count,
  active,
  tone,
  onClick,
}: {
  icon: ReactNode;
  label: ReactNode;
  count?: number;
  active?: boolean;
  tone?: "warn";
  onClick: () => void;
}) {
  return (
    <button className={`side-item ${active ? "active" : ""} ${tone ?? ""}`} aria-current={active ? "page" : undefined} onClick={onClick}>
      {icon}
      <span className="side-label ellipsis">{label}</span>
      {count !== undefined && <span className="side-count">{count}</span>}
    </button>
  );
}

export interface RepoState {
  count: number;
  /** Works of the repository that conflict with GitHub (danger) or are not in step with it (warn). */
  issue?: { tone: "warn" | "danger"; text: string };
}

export function HomeSidebar({
  scope,
  go,
  repos,
  states,
  counts,
  version,
  theme,
  onTheme,
  onNew,
  onConnect,
  onRepoMenu,
  open,
  onClose,
}: {
  scope: Scope;
  go: (scope: Scope) => void;
  repos: Repo[];
  states: Map<string, RepoState>;
  counts: { all: number; recent: number; attention: number; trash: number };
  version: string;
  theme: string;
  onTheme: () => void;
  onNew: () => void;
  onConnect: () => void;
  onRepoMenu: (repo: Repo, event: React.MouseEvent) => void;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {open && <div className="home-side-backdrop" onClick={onClose} />}
      <aside className={`home-side ${open ? "open" : ""}`}>
        <div className="home-brand">
          <div className="brand-mark">F</div>
          <span>FRAME Studio</span>
          <span className="faint small-text">{version}</span>
          <span className="grow" />
          <button className="icon-btn" title="切换主题" onClick={onTheme}>
            {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
          </button>
        </div>
        <button className="btn primary home-new" onClick={onNew}>
          <Plus size={15} /> 新建作品
        </button>
        <nav className="side-nav">
          <SideItem icon={<Clock size={15} />} label="最近打开" count={counts.recent} active={scope.kind === "recent"} onClick={() => go({ kind: "recent" })} />
          <SideItem icon={<LayoutGrid size={15} />} label="全部作品" count={counts.all} active={scope.kind === "all"} onClick={() => go({ kind: "all" })} />
          {counts.attention > 0 && (
            <SideItem
              icon={<TriangleAlert size={15} />}
              label="需要处理"
              count={counts.attention}
              tone="warn"
              active={scope.kind === "attention"}
              onClick={() => go({ kind: "attention" })}
            />
          )}
        </nav>
        <div className="side-section">
          <span>作品库</span>
          <button className="icon-btn" title="连接 GitHub 作品库" aria-label="连接 GitHub 作品库" onClick={onConnect}>
            <Plus size={14} />
          </button>
        </div>
        <nav className="side-nav side-repos">
          {repos.map((repo) => {
            const { owner, name } = repoName(repo);
            const state = states.get(repo.id);
            const active = scope.kind === "repo" && scope.repo === repo.id;
            const menu = (event: React.MouseEvent) => {
              event.preventDefault();
              event.stopPropagation();
              onRepoMenu(repo, event);
            };
            return (
              <div
                key={repo.id}
                className={`side-item side-repo ${active ? "active" : ""}`}
                role="button"
                tabIndex={0}
                aria-current={active ? "page" : undefined}
                title={repo.remote ? `${repo.name}（GitHub）` : "只在这台电脑上"}
                onClick={() => go({ kind: "repo", repo: repo.id })}
                onKeyDown={(event) => event.key === "Enter" && go({ kind: "repo", repo: repo.id })}
                onContextMenu={menu}
              >
                {repo.remote ? <GithubIcon size={14} /> : <HardDrive size={15} />}
                <span className="side-label ellipsis">
                  {owner && <span className="faint">{owner}</span>}
                  {name}
                </span>
                {!repo.ready && <span className="badge danger">不可用</span>}
                {state?.issue && <span className={`side-dot ${state.issue.tone}`} title={state.issue.text} />}
                <span className="side-count">{state?.count ?? 0}</span>
                <button className="icon-btn side-more" aria-label={`${repo.name} 的操作`} onClick={menu}>
                  <MoreHorizontal size={14} />
                </button>
              </div>
            );
          })}
        </nav>
        <div className="side-foot">
          <SideItem icon={<BarChart3 size={15} />} label="复盘对比" onClick={() => navigate("/reviews")} />
          <SideItem
            icon={<Trash2 size={15} />}
            label="回收站"
            count={counts.trash || undefined}
            active={scope.kind === "trash"}
            onClick={() => go({ kind: "trash" })}
          />
          <SideItem icon={<SettingsIcon size={15} />} label="设置" active={scope.kind === "settings"} onClick={() => go({ kind: "settings" })} />
        </div>
      </aside>
    </>
  );
}
