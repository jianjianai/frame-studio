import { Trash2, Undo2 } from "lucide-react";
import { api, del, formatBytes, timeAgo } from "../lib/api";
import { useAction, useConfirm, useToast } from "../lib/ui";
import type { Repo, WorkSummary } from "../lib/types";
import { Cover } from "./WorkItems";
import { PageHead } from "./PageHead";
import { Empty } from "./Parts";

const WHERE = { both: "本机和 GitHub", remote: "仅 GitHub", local: "仅本机" } as const;

/**
 * The recycle bin: works whose branch was renamed to trash/<id> (here and on GitHub).
 * Restoring renames it back; deleting removes it here and on GitHub.
 */
export function TrashView({
  items,
  repos,
  repo,
  onRepo,
  onChanged,
  onNav,
}: {
  items: WorkSummary[];
  repos: Repo[];
  repo?: string;
  onRepo: (repo?: string) => void;
  onChanged: () => void;
  onNav: () => void;
}) {
  const [run, busy] = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const shown = items.filter((work) => !repo || work.repo === repo).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const repoName = (id: string) => repos.find((item) => item.id === id)?.name ?? id;
  const freed = (bytes: number) => (bytes > 0 ? `，释放了 ${formatBytes(bytes)}` : "");

  const restore = async (work: WorkSummary) => {
    await run(() => api(`/api/works/${work.repo}/${work.id}/restore`, { method: "POST" }), `已恢复「${work.title}」`);
    onChanged();
  };
  const purge = async (work: WorkSummary) => {
    const where = work.location === "local" ? "本机上的分支" : work.location === "remote" ? "GitHub 上的分支" : "本机和 GitHub 上的分支";
    if (!(await confirm(`永久删除「${work.title}」？${where}、导出的视频、复盘资料和 AI 对话都会删除，无法恢复。`, { confirm: "永久删除", danger: true })))
      return;
    const result = await run(() => del<{ freed: number }>(`/api/trash/${work.repo}/${work.id}`));
    if (result) toast(`已永久删除「${work.title}」${freed(result.freed)}`, "ok");
    onChanged();
  };
  const empty = async () => {
    if (!shown.length) return;
    const scope = repo ? `「${repoName(repo)}」回收站里的` : "回收站里的";
    if (!(await confirm(`永久删除${scope} ${shown.length} 个作品？本机和 GitHub 上的分支都会删除，无法恢复。`, { confirm: "清空回收站", danger: true })))
      return;
    let total = 0;
    for (const id of new Set(shown.map((work) => work.repo))) {
      const result = await run(() => del<{ freed: number }>(`/api/trash/${id}`));
      if (!result) break;
      total += result.freed;
    }
    toast(`回收站已清空${freed(total)}`, "ok");
    onChanged();
  };

  const withTrash = repos.filter((item) => items.some((work) => work.repo === item.id));
  return (
    <>
      <PageHead
        icon={<Trash2 size={18} />}
        title="回收站"
        meta={
          <>
            <span>{shown.length} 个作品</span>
            <span>移到回收站的作品分支改名为 trash/&lt;id&gt;，本机和 GitHub 上一起改；恢复后回到原来的作品库。</span>
          </>
        }
        actions={
          <>
            {withTrash.length > 1 && (
              <select className="select home-select" value={repo ?? ""} onChange={(event) => onRepo(event.target.value || undefined)}>
                <option value="">全部作品库</option>
                {withTrash.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            )}
            <button className="btn danger" disabled={busy || !shown.length} onClick={empty}>
              <Trash2 size={13} /> 清空回收站
            </button>
          </>
        }
        onNav={onNav}
      />
      <div className="home-content">
        {!shown.length ? (
          <Empty icon={<Trash2 size={28} />} title="回收站是空的">
            <span className="muted">移到回收站的作品会显示在这里，可以恢复或永久删除。</span>
          </Empty>
        ) : (
          <div className="trash-list">
            {shown.map((work) => (
              <div className="trash-row" key={work.repo + work.id}>
                <div className="work-row-thumb">
                  <Cover work={work} />
                </div>
                <div className="grow trash-info">
                  <strong className="ellipsis" title={work.title}>
                    {work.title}
                  </strong>
                  <span className="faint small-text ellipsis">
                    {repos.length > 1 ? repoName(work.repo) + " · " : ""}
                    {WHERE[work.location]} · {timeAgo(work.updatedAt)}修改 · trash/{work.id}
                  </span>
                </div>
                <button className="btn small" disabled={busy} onClick={() => restore(work)}>
                  <Undo2 size={13} /> 恢复
                </button>
                <button className="btn small danger" disabled={busy} onClick={() => purge(work)}>
                  永久删除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
