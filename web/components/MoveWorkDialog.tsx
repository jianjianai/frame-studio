import { useEffect, useMemo, useState } from "react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { api, formatBytes } from "../lib/api";
import { useExports } from "../lib/exports";
import { Dialog, useToast } from "../lib/ui";
import type { Repo } from "../lib/types";
import "./dialogs.css";

interface Library {
  id: string;
  title: string;
}
/** What moving a work means (server: routes/works.mjs moveReport). */
interface MoveReport {
  id: string;
  title: string;
  from: { id: string; name: string };
  to: { id: string; name: string; remote: string };
  published: boolean;
  unsaved: number;
  blocked: string[];
  error: string;
  materials: { copy: Library[]; shared: Library[]; changed: string[]; missing: string[] };
  experiences: { copy: Library[]; shared: Library[] };
  review: boolean;
  exports: { count: number; bytes: number };
  sessions: number;
}
type Checked = MoveReport | { failure: string };
export interface MovableWork {
  repo: string;
  id: string;
  title: string;
}

const key = (work: MovableWork) => `${work.repo}/${work.id}`;
/** Works this page is moving: it says so itself, the workbench's notice of the move is for other windows. */
const movingHere = new Set<string>();
export const movedHere = (repo: string, id: string) => movingHere.has(`${repo}/${id}`);
const titles = (list: Library[]) => list.map((library) => `「${library.title}」`).join("");
const files = (refs: string[]) => refs.map((ref) => `materials/${ref}`).join("、");

/** What goes along with a work, in short lines. */
function along(report: MoveReport) {
  const { materials, experiences, to } = report;
  return [
    report.unsaved > 0 && `${report.unsaved} 个文件的修改先保存为一个版本`,
    materials.copy.length > 0 && `素材库${titles(materials.copy)}复制到「${to.name}」`,
    materials.shared.length > 0 && `改用「${to.name}」里同名的素材库${titles(materials.shared)}`,
    experiences.copy.length > 0 && `经验库${titles(experiences.copy)}复制到「${to.name}」`,
    experiences.shared.length > 0 && `关联「${to.name}」里同名的经验库${titles(experiences.shared)}`,
    report.review && "复盘资料",
    report.exports.count > 0 && `导出的视频 ${report.exports.count} 个（${formatBytes(report.exports.bytes)}）`,
    report.sessions > 0 && `AI 对话 ${report.sessions} 个`,
  ].filter((line): line is string => Boolean(line));
}
/** Material files the work will see otherwise there. */
function changes(report: MoveReport) {
  const { changed, missing } = report.materials;
  return [
    changed.length > 0 && `改用「${report.to.name}」里的版本：${files(changed)}`,
    missing.length > 0 && `「${report.to.name}」里没有，迁移后作品会缺少：${files(missing)}`,
  ].filter((line): line is string => Boolean(line));
}

/**
 * Move works of the local repository (no GitHub) to another repository. The server reports
 * per work what goes along, what changes and what is in the way; works that cannot move now
 * are skipped.
 */
export function MoveWorkDialog({
  works: given,
  onClose,
  onMoved,
  onConnect,
}: {
  works: MovableWork[];
  onClose: () => void;
  /** After the moves (some may have failed). */
  onMoved?: () => void;
  /** Connect a repository first (when there is none to move to). */
  onConnect?: () => void;
}) {
  const toast = useToast();
  // The same works, whichever array they come in: checking them again is a round of requests.
  const signature = given.map(key).join("\n");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const works = useMemo(() => given, [signature]);
  const { local: exports } = useExports();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [target, setTarget] = useState("");
  const [reports, setReports] = useState<Map<string, Checked>>(new Map());
  const [phase, setPhase] = useState<"" | "checking" | "moving">("");
  const [progress, setProgress] = useState("");
  const sources = useMemo(() => new Set(works.map((work) => work.repo)), [works]);
  const targets = (repos ?? []).filter((repo) => repo.ready && !sources.has(repo.id));
  const from = (repos ?? []).find((repo) => sources.has(repo.id));

  useEffect(() => {
    void api<Repo[]>("/api/repos").then(
      (list) => {
        setRepos(list);
        setTarget(list.find((repo) => repo.ready && repo.remote && !sources.has(repo.id))?.id ?? list.find((repo) => repo.ready && !sources.has(repo.id))?.id ?? "");
      },
      (error) => toast((error as Error).message, "error"),
    );
  }, [sources, toast]);

  useEffect(() => {
    if (!target) return;
    let current = true;
    setPhase("checking");
    setReports(new Map());
    void (async () => {
      const next = new Map<string, Checked>();
      for (const work of works) {
        try {
          next.set(key(work), await api<MoveReport>(`/api/works/${encodeURIComponent(work.repo)}/${encodeURIComponent(work.id)}/move?to=${encodeURIComponent(target)}`));
        } catch (error) {
          next.set(key(work), { failure: (error as Error).message });
        }
        if (!current) return;
      }
      setReports(next);
      setPhase("");
    })();
    return () => {
      current = false;
    };
  }, [target, works]);

  // An export this browser is rendering loads the work from where it is now.
  const exporting = (work: MovableWork) => exports.some((job) => job.repo === work.repo && job.work === work.id && (job.status === "running" || job.status === "queued"));
  const problemsOf = (work: MovableWork) => {
    const report = reports.get(key(work));
    if (!report) return [];
    if ("failure" in report) return [report.failure];
    return [...report.blocked, ...(exporting(work) ? ["正在这个浏览器里导出，先等它完成或暂停"] : [])];
  };
  const ready = works.filter((work) => reports.has(key(work)) && !problemsOf(work).length);
  const checked = [...reports.values()].filter((report): report is MoveReport => !("failure" in report));
  const unreachable = checked.find((report) => report.error)?.error ?? "";
  const single = works.length === 1 ? reports.get(key(works[0])) : undefined;
  const destination = targets.find((repo) => repo.id === target);

  const move = async () => {
    setPhase("moving");
    const failed: string[] = [];
    const partly: string[] = [];
    for (const [index, work] of ready.entries()) {
      setProgress(`正在迁移 ${index + 1}/${ready.length}`);
      movingHere.add(key(work));
      try {
        const result = await api<{ problems: string[] }>(`/api/works/${encodeURIComponent(work.repo)}/${encodeURIComponent(work.id)}/move`, { body: { to: target } });
        if (result.problems.length) partly.push(`「${work.title}」已迁移，但这些没有跟过去：${result.problems.join("；")}`);
      } catch (error) {
        failed.push(`「${work.title}」：${(error as Error).message}`);
      } finally {
        setTimeout(() => movingHere.delete(key(work)), 5000);
      }
    }
    const done = ready.length - failed.length;
    const name = destination?.name ?? target;
    if (failed.length) toast(`${done ? `${done} 个已迁移到「${name}」，` : ""}${failed.length} 个没有成功：\n${failed.join("\n")}`, "error");
    else toast(ready.length === 1 ? `已把「${ready[0].title}」迁移到「${name}」` : `已把 ${ready.length} 个作品迁移到「${name}」`, "ok");
    if (partly.length) toast(partly.join("\n"), "error");
    onMoved?.();
    onClose();
  };

  const skipped = works.length - ready.length;
  return (
    <Dialog
      title={works.length === 1 ? `迁移「${works[0].title}」` : `迁移 ${works.length} 个作品`}
      onClose={phase === "moving" ? () => {} : onClose}
      width={580}
      footer={
        <>
          {phase === "moving" && (
            <span className="muted row grow">
              <span className="spinner" /> {progress}…
            </span>
          )}
          <button className="btn" disabled={phase === "moving"} onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={Boolean(phase) || !target || !ready.length} onClick={move}>
            {works.length > 1 && ready.length ? `迁移 ${ready.length} 个` : "迁移"}
          </button>
        </>
      }
    >
      <p className="muted dialog-intro">
        {works.length === 1 ? "作品" : "这些作品"}连同全部版本、媒体文件、复盘资料、导出的视频和 AI 对话一起迁到另一个作品库，{from ? `「${from.name}」` : "原来的作品库"}
        里不再保留。迁到连接 GitHub 的作品库后会自动同步到 GitHub。
      </p>
      {repos && !targets.length ? (
        <div className="dialog-notice warn">
          <TriangleAlert size={15} />
          <div className="grow">
            还没有可以迁移到的作品库，先连接一个 GitHub 作品库。
            {onConnect && (
              <>
                {" "}
                <button
                  className="link-btn"
                  onClick={() => {
                    onClose();
                    onConnect();
                  }}
                >
                  连接作品库
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <label className="field">
          <span>迁移到</span>
          <select className="select" value={target} disabled={phase === "moving" || !repos} onChange={(event) => setTarget(event.target.value)}>
            {targets.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
                {repo.remote ? "（GitHub）" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {phase === "checking" && (
        <div className="dialog-checking">
          <span className="spinner" /> 正在检查{works.length > 1 ? "这些作品" : "作品"}和「{destination?.name ?? target}」…
        </div>
      )}
      {target && phase !== "checking" && reports.size > 0 && (
        <>
          {unreachable && (
            <div className="dialog-notice warn">
              <TriangleAlert size={15} />
              <div className="grow">无法连接 GitHub，迁移后会在能连接时再同步：{unreachable}</div>
            </div>
          )}
          {single ? (
            <SingleReport report={single} problems={problemsOf(works[0])} />
          ) : (
            <>
              {skipped > 0 && (
                <div className="dialog-notice danger">
                  <CircleAlert size={15} />
                  <div className="grow">{skipped} 个作品现在不能迁移，会跳过。</div>
                </div>
              )}
              <ul className="dialog-facts">
                {works.map((work) => {
                  const report = reports.get(key(work));
                  const problems = problemsOf(work);
                  const lines = report && !("failure" in report) ? [...changes(report), ...along(report)] : [];
                  return (
                    <li key={key(work)} className="move-work">
                      <strong className="ellipsis">{work.title}</strong>
                      {problems.length > 0 ? (
                        <span className="danger-text small-text">不能迁移：{problems.join("；")}</span>
                      ) : (
                        lines.length > 0 && <span className="muted small-text">{lines.join("；")}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </>
      )}
    </Dialog>
  );
}

function SingleReport({ report, problems }: { report: Checked; problems: string[] }) {
  if ("failure" in report)
    return (
      <div className="dialog-notice danger">
        <CircleAlert size={15} />
        <div className="grow">{report.failure}</div>
      </div>
    );
  const lines = along(report);
  const changed = changes(report);
  return (
    <>
      {problems.length > 0 && (
        <div className="dialog-notice danger">
          <CircleAlert size={15} />
          <div className="grow">
            {problems.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        </div>
      )}
      {changed.length > 0 && (
        <div className="dialog-notice warn">
          <TriangleAlert size={15} />
          <div className="grow">
            <strong>作品用到的素材在「{report.to.name}」里不一样：</strong>
            <ul className="dialog-list">
              {changed.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="dialog-label">一起迁移</div>
      <ul className="dialog-facts">
        <li>作品的全部版本和媒体文件{report.published ? "（保持已发布）" : ""}</li>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </>
  );
}
