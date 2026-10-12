import { BookOpen, Library, Trash2, Undo2 } from "lucide-react";
import { api, del, formatBytes, timeAgo } from "../lib/api";
import { useAction, useConfirm, useToast } from "../lib/ui";
import type { Repo, WorkSummary } from "../lib/types";
import { Cover } from "./WorkItems";
import { PageHead } from "./PageHead";
import { Empty } from "./Parts";

const WHERE = { both: "本机和 GitHub", remote: "仅 GitHub", local: "仅本机" } as const;
const KIND_NAMES = { materials: "素材库", experience: "经验库" } as const;

/** A material or experience library in its repository's bin (.trash/ on the library branch). */
export interface BinnedLibrary {
  repo: string;
  kind: "materials" | "experience";
  key: string;
  id: string;
  title: string;
  deletedAt: string | null;
  files: number;
  size: number;
}

/**
 * The recycle bin: works whose branch was renamed to trash/<id> (here and on GitHub), and
 * material and experience libraries moved into their branch's .trash/. Restoring brings them
 * back; deleting removes them (works here and on GitHub; libraries stay in their history).
 */
export function TrashView({
  items,
  libraries,
  repos,
  repo,
  onRepo,
  onChanged,
  onNav,
}: {
  items: WorkSummary[];
  libraries: BinnedLibrary[];
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
  const shownLibraries = libraries.filter((item) => !repo || item.repo === repo).sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  const libraryBase = (item: Pick<BinnedLibrary, "repo" | "kind">) => `/api/repos/${encodeURIComponent(item.repo)}/${item.kind}/trash`;
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
  const restoreLibrary = async (item: BinnedLibrary) => {
    const result = await run(() => api<{ id: string; renamed: boolean }>(`${libraryBase(item)}/${encodeURIComponent(item.key)}/restore`, { method: "POST" }));
    if (result) toast(`已恢复${KIND_NAMES[item.kind]}「${item.title}」${result.renamed ? `，同名的已经有了，改名为「${result.id}」` : ""}`, "ok");
    onChanged();
  };
  const purgeLibrary = async (item: BinnedLibrary) => {
    if (!(await confirm(`永久删除${KIND_NAMES[item.kind]}「${item.title}」？以后只能从${KIND_NAMES[item.kind]}的版本历史里找回。`, { confirm: "永久删除", danger: true })))
      return;
    if (await run(() => del(`${libraryBase(item)}/${encodeURIComponent(item.key)}`))) toast(`已永久删除${KIND_NAMES[item.kind]}「${item.title}」`, "ok");
    onChanged();
  };
  const empty = async () => {
    if (!shown.length && !shownLibraries.length) return;
    const scope = repo ? `「${repoName(repo)}」回收站里的` : "回收站里的";
    const what = [shown.length ? `${shown.length} 个作品` : "", shownLibraries.length ? `${shownLibraries.length} 个素材库或经验库` : ""].filter(Boolean).join("和");
    if (!(await confirm(`永久删除${scope}${what}？作品在本机和 GitHub 上的分支都会删除，无法恢复；库以后只能从版本历史里找回。`, { confirm: "清空回收站", danger: true })))
      return;
    let total = 0;
    for (const id of new Set(shown.map((work) => work.repo))) {
      const result = await run(() => del<{ freed: number }>(`/api/trash/${id}`));
      if (!result) break;
      total += result.freed;
    }
    for (const key of new Set(shownLibraries.map((item) => `${item.repo}\n${item.kind}`))) {
      const [id, kind] = key.split("\n") as [string, BinnedLibrary["kind"]];
      await run(() => del(libraryBase({ repo: id, kind })));
    }
    toast(`回收站已清空${freed(total)}`, "ok");
    onChanged();
  };

  const withTrash = repos.filter((item) => items.some((work) => work.repo === item.id) || libraries.some((library) => library.repo === item.id));
  return (
    <>
      <PageHead
        icon={<Trash2 size={18} />}
        title="回收站"
        meta={
          <>
            <span>
              {shown.length} 个作品{shownLibraries.length ? ` · ${shownLibraries.length} 个素材库或经验库` : ""}
            </span>
            <span>移到回收站的作品分支改名为 trash/&lt;id&gt;，本机和 GitHub 上一起改；删除的素材库、经验库放在它们分支的回收站里。恢复后都回到原来的作品库。</span>
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
            <button className="btn danger" disabled={busy || (!shown.length && !shownLibraries.length)} onClick={empty}>
              <Trash2 size={13} /> 清空回收站
            </button>
          </>
        }
        onNav={onNav}
      />
      <div className="home-content">
        {!shown.length && !shownLibraries.length ? (
          <Empty icon={<Trash2 size={28} />} title="回收站是空的">
            <span className="muted">移到回收站的作品、素材库和经验库会显示在这里，可以恢复或永久删除。</span>
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
            {shownLibraries.map((item) => (
              <div className="trash-row" key={`${item.repo}/${item.kind}/${item.key}`}>
                <div className="work-row-thumb trash-library-icon">{item.kind === "materials" ? <Library size={22} /> : <BookOpen size={22} />}</div>
                <div className="grow trash-info">
                  <strong className="ellipsis" title={item.title}>
                    {item.title}
                  </strong>
                  <span className="faint small-text ellipsis">
                    {KIND_NAMES[item.kind]} · {repos.length > 1 ? repoName(item.repo) + " · " : ""}
                    {item.kind === "materials" ? `${item.files} 个文件 · ${formatBytes(item.size)}` : `${item.files} 篇文档`}
                    {item.deletedAt ? ` · ${timeAgo(item.deletedAt)}删除` : ""}
                  </span>
                </div>
                <button className="btn small" disabled={busy} onClick={() => restoreLibrary(item)}>
                  <Undo2 size={13} /> 恢复
                </button>
                <button className="btn small danger" disabled={busy} onClick={() => purgeLibrary(item)}>
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
