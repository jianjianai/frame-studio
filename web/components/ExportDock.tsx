import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, AlertTriangle, CheckCircle2, Clapperboard, Clock3, Download, Loader2, Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import { api, formatBytes, formatTime, timeAgo, workPath } from "../lib/api";
import { useConfirm, usePersistent, useToast } from "../lib/ui";
import type { Task } from "../lib/types";
import { navigate } from "../App";
import { WorkbenchContext } from "../workbench/store";
import {
  dismissServer,
  downloadLocal,
  finishClock,
  formatEta,
  localRatio,
  pauseLocal,
  removeLocal,
  restartLocal,
  resumeLocal,
  useExports,
  type ExportsState,
  type LocalExport,
} from "../lib/exports";
import "./exports.css";

/**
 * Export progress in the bottom-left corner: the left end of the workbench's status bar, or a
 * small floating button on other pages. A click opens every export (local and server) with
 * its progress, time left and actions.
 */
export type ExportItem = { kind: "local"; key: string; job: LocalExport } | { kind: "server"; key: string; task: Task };

type LocalState = "rendering" | "waiting" | "paused" | "interrupted" | "failed" | "changed" | "done";

function localState(job: LocalExport): LocalState {
  if (job.here || job.elsewhere) return "rendering";
  if (job.waiting || job.status === "queued") return "waiting";
  // Marked running but rendered nowhere: its page went away (it goes on by itself unless it kept stopping).
  if (job.status === "running") return "interrupted";
  return job.status;
}

/** 0 running, 1 waiting, 2 stopped and waiting for the user, 3 finished. */
function rank(item: ExportItem) {
  if (item.kind === "server") return item.task.status === "running" ? 0 : item.task.status === "done" ? 3 : 2;
  const state = localState(item.job);
  return state === "rendering" ? 0 : state === "waiting" ? 1 : state === "done" ? 3 : 2;
}

const endedAt = (item: ExportItem) => Date.parse((item.kind === "local" ? item.job.output?.finishedAt : item.task.endedAt) ?? "") || 0;
const changedAt = (item: ExportItem) => Date.parse(item.kind === "local" ? item.job.updatedAt : item.task.startedAt) || 0;

/** Exports to show, the ones that need looking at first; `work` keeps one work's. */
export function exportItems(state: ExportsState, work?: { repo: string; id: string }): ExportItem[] {
  const items: ExportItem[] = [
    ...state.local.map((job) => ({ kind: "local" as const, key: "local:" + job.id, job })),
    ...state.server.map((task) => ({ kind: "server" as const, key: "server:" + task.id, task })),
  ];
  return items
    .filter(
      (item) =>
        !work ||
        (item.kind === "local"
          ? item.job.repo === work.repo && item.job.work === work.id
          : item.task.work === work.id && (!item.task.repo || item.task.repo === work.repo)),
    )
    .sort((a, b) => rank(a) - rank(b) || changedAt(b) - changedAt(a));
}

function metrics(item: ExportItem) {
  if (item.kind === "server") return { ratio: item.task.progress ?? 0, eta: item.task.eta ?? null };
  return { ratio: localRatio(item.job), eta: item.job.progress?.eta ?? null };
}

const titleOf = (item: ExportItem) => (item.kind === "local" ? item.job.title : item.task.title.replace(/^导出 /, ""));
const statusOf = (item: ExportItem) => (item.kind === "local" ? item.job.status : item.task.status);

export function ExportStatus({ floating = false }: { floating?: boolean }) {
  const state = useExports();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [seenAt, setSeenAt] = usePersistent("exports-seen", 0);
  const button = useRef<HTMLButtonElement>(null);
  const items = exportItems(state);

  // Finished or failed while the studio was open (often in the background): say so.
  const known = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    const before = known.current;
    known.current = new Map(items.map((item) => [item.key, statusOf(item)]));
    if (!before) return;
    for (const item of items) {
      const was = before.get(item.key);
      const now = statusOf(item);
      if (!was || was === now) continue;
      if (now === "done") toast(`「${titleOf(item)}」导出完成${item.kind === "local" ? "" : "（MP4，在导出选项卡下载）"}`, "ok");
      if (now === "failed") toast(`「${titleOf(item)}」导出失败：${item.kind === "local" ? item.job.error : item.task.error}`, "error");
      if (now === "changed") toast(`「${titleOf(item)}」在导出中断后改过，点左下角的导出确认怎么继续`, "info");
    }
  });
  // Opening the list counts as having seen what finished.
  useEffect(() => {
    if (open) setSeenAt(Date.now());
  }, [open, setSeenAt]);

  const running = items.filter((item) => rank(item) === 0);
  const waiting = items.filter((item) => rank(item) === 1);
  const stopped = items.filter((item) => rank(item) === 2);
  const fresh = items.filter((item) => rank(item) === 3 && endedAt(item) > seenAt);
  let content: ReactNode = null;
  let tone = "";
  if (running.length) {
    const { ratio, eta } = metrics(running[0]);
    const count = running.length + waiting.length;
    content = (
      <>
        <Loader2 size={13} className="spin" />
        <span>导出 {Math.floor(ratio * 100)}%</span>
        <span className="export-mini" aria-hidden="true">
          <span style={{ width: `${Math.round(ratio * 100)}%` }} />
        </span>
        {eta != null && <span className="export-status-eta">还要 {formatEta(eta)}</span>}
        {count > 1 && <span className="export-status-eta">共 {count} 个</span>}
      </>
    );
  } else if (waiting.length) {
    content = (
      <>
        <Clock3 size={13} />
        <span>等待导出{waiting.length > 1 ? `（${waiting.length} 个）` : ""}</span>
      </>
    );
  } else if (stopped.length) {
    const first = stopped[0];
    const state = first.kind === "local" ? localState(first.job) : "failed";
    tone = state === "failed" ? "danger-text" : "warn-text";
    content = (
      <>
        {state === "paused" ? <Pause size={13} /> : state === "failed" ? <AlertCircle size={13} /> : <AlertTriangle size={13} />}
        <span>{{ paused: "导出已暂停", interrupted: "导出已中断", changed: "导出等待确认", failed: "导出失败" }[state as string] ?? "导出已停止"}</span>
      </>
    );
  } else if (fresh.length) {
    tone = "ok-text";
    content = (
      <>
        <CheckCircle2 size={13} />
        <span>导出完成</span>
      </>
    );
  } else if (open)
    content = (
      <>
        <Clapperboard size={13} />
        <span>导出</span>
      </>
    );
  if (!content) return null;
  return (
    <>
      <button
        ref={button}
        className={`export-status ${floating ? "floating" : ""} ${tone}`}
        title="导出进度（点击查看全部导出）"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {content}
      </button>
      {open && createPortal(<ExportPanel items={items} anchor={button} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function ExportPanel({ items, anchor, onClose }: { items: ExportItem[]; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: 8, bottom: 32 });
  useLayoutEffect(() => {
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect)
        setPlace({
          left: Math.max(8, Math.min(rect.left, innerWidth - 8 - (panel.current?.offsetWidth ?? 0))),
          bottom: Math.max(8, innerHeight - rect.top + 6),
        });
    };
    update();
    addEventListener("resize", update);
    return () => removeEventListener("resize", update);
  }, [anchor]);
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const target = event.target as Element;
      // A confirmation asked from a row belongs to the list.
      if (panel.current?.contains(target) || anchor.current?.contains(target) || target.closest?.(".dialog-backdrop")) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector(".dialog-backdrop")) onClose();
    };
    addEventListener("pointerdown", down, true);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("pointerdown", down, true);
      removeEventListener("keydown", key);
    };
  }, [anchor, onClose]);
  return (
    <div ref={panel} className="export-panel" role="dialog" aria-label="导出" style={place}>
      <header>
        <strong className="grow">导出</strong>
        <button className="icon-btn" aria-label="关闭" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="export-list">
        {items.length ? items.map((item) => <ExportRow key={item.key} item={item} />) : <div className="faint small-text">没有进行中的导出。</div>}
      </div>
      <footer className="faint">
        本机导出在后台进行，可以切换界面或回到首页；关闭、刷新页面后再打开 FRAME，会从中断处接着导出。导出好的视频自动下载，并在浏览器里保留 7 天。
      </footer>
    </div>
  );
}

export function ExportRow({ item }: { item: ExportItem }) {
  return item.kind === "local" ? <LocalRow job={item.job} /> : <ServerRow task={item.task} />;
}

/** The work's title: opens its export tab (or the work, from elsewhere). */
function WorkLink({ repo, work, title }: { repo?: string; work?: string; title: string }) {
  const workbench = useContext(WorkbenchContext);
  if (!repo || !work) return <span className="export-item-title ellipsis">{title}</span>;
  const here = workbench?.work.id === work && workbench.work.repo === repo;
  return (
    <button
      className="export-item-title ellipsis"
      title={here ? "打开导出选项卡" : "打开这个作品"}
      onClick={() => (here ? workbench.openTool("export") : navigate(`/work/${encodeURIComponent(repo)}/${encodeURIComponent(work)}`))}
    >
      {title}
    </button>
  );
}

const fpsText = (fps: number) => (fps >= 10 ? Math.round(fps) : fps.toFixed(1));

function LocalRow({ job }: { job: LocalExport }) {
  const confirm = useConfirm();
  const toast = useToast();
  // Waiting behind another export of this page, or about to start.
  const behind = useExports().local.some((other) => other.here && other.id !== job.id);
  const act = (action: () => Promise<unknown>) => void action().catch((error: Error) => toast(error.message, "error"));
  const state = localState(job);
  const ratio = localRatio(job);
  const percent = Math.floor(ratio * 100);
  const live = job.progress;
  const plan = job.plan;
  const ranged = job.options.start !== undefined || job.options.end !== undefined;
  const meta = [
    "本机",
    plan ? `${plan.width}×${plan.height}` : `宽 ${job.options.width}`,
    `${job.options.fps} fps`,
    "WebM",
    ranged ? `${formatTime(job.options.start ?? 0, false)}–${formatTime(job.options.end ?? plan?.end ?? 0, false)}` : "",
  ].filter(Boolean);
  let status: string;
  if (state === "rendering") {
    const where = job.elsewhere ? "在另一个标签页中导出 · " : "";
    const left = live?.eta != null ? `还要约 ${formatEta(live.eta)}（${finishClock(live.eta)} 完成）` : "";
    status =
      where +
      (!live
        ? "正在开始…"
        : live.phase === "loading"
          ? ["正在载入作品…", live.eta != null ? `预计还要 ${formatEta(live.eta)}` : ""].filter(Boolean).join(" · ")
          : live.phase === "joining"
            ? [`正在合成视频 ${live.done}/${live.total} 段`, live.eta != null ? `还要约 ${formatEta(live.eta)}` : ""].filter(Boolean).join(" · ")
            : [`${percent}%`, `第 ${live.done}/${live.total} 帧`, live.fps ? `每秒 ${fpsText(live.fps)} 帧` : "", left].filter(Boolean).join(" · "));
  } else
    status = {
      waiting: !job.waiting ? "等待导出" : behind ? "排队中，前一个导出完成后开始" : job.done.length ? "正在准备从中断处接着导出…" : "正在准备…",
      paused: `已暂停 · 完成 ${percent}%`,
      interrupted: `已中断 · 完成 ${percent}%：页面关闭或出错时停下了，点「继续」从中断处接着导出`,
      changed: "作品在导出中断后改过：「继续」用现在的作品导出剩下的部分，「重新导出」从头开始",
      failed: job.error || "导出失败",
      done: `已完成 · ${formatBytes(job.output?.size)} · ${timeAgo(job.output?.finishedAt)}`,
    }[state];
  const cancel = async () => {
    const done = state === "done";
    const ok = await confirm(done ? "从浏览器里移除这个视频？已经下载的文件不受影响。" : "取消这次导出？已经导出的部分会被删除。", {
      danger: true,
      confirm: done ? "移除" : "取消导出",
    });
    if (ok) act(() => removeLocal(job.id));
  };
  return (
    <div className={`export-item ${state}`}>
      <div className="export-item-head">
        <StateIcon state={state} />
        <WorkLink repo={job.repo} work={job.work} title={job.title} />
        <span className="export-item-actions">
          {(state === "rendering" || state === "waiting") && (
            <button className="icon-btn" title="暂停（之后可以继续）" onClick={() => act(() => pauseLocal(job.id))}>
              <Pause size={14} />
            </button>
          )}
          {(state === "paused" || state === "interrupted" || state === "failed" || state === "changed") && (
            <button className="icon-btn" title={state === "failed" ? "重试（从中断处接着导出）" : "继续"} onClick={() => act(() => resumeLocal(job.id))}>
              <Play size={14} />
            </button>
          )}
          {(state === "changed" || state === "failed") && (
            <button className="icon-btn" title="从头重新导出" onClick={() => act(() => restartLocal(job.id))}>
              <RotateCcw size={14} />
            </button>
          )}
          {state === "done" && (
            <button className="icon-btn" title="下载" onClick={() => act(() => downloadLocal(job.id))}>
              <Download size={14} />
            </button>
          )}
          <button className="icon-btn" title={state === "done" ? "从浏览器里移除" : "取消并删除"} onClick={cancel}>
            {state === "done" ? <X size={14} /> : <Trash2 size={14} />}
          </button>
        </span>
      </div>
      <div className="export-item-meta">{meta.join(" · ")}</div>
      {state !== "done" && (
        <div className="export-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div style={{ width: `${Math.max(1, ratio * 100)}%` }} />
        </div>
      )}
      <div className={`export-item-status ${state === "failed" ? "danger-text" : ""}`}>{status}</div>
    </div>
  );
}

function ServerRow({ task }: { task: Task }) {
  const toast = useToast();
  const result = task.result as { name?: string; width?: number; height?: number } | null;
  const running = task.status === "running";
  const state: LocalState = running ? "rendering" : task.status === "done" ? "done" : "failed";
  const percent = Math.floor((task.progress ?? 0) * 100);
  return (
    <div className={`export-item ${state}`}>
      <div className="export-item-head">
        <StateIcon state={state} />
        <WorkLink repo={task.repo} work={task.work} title={task.title.replace(/^导出 /, "")} />
        <span className="export-item-actions">
          {task.status === "done" && result?.name && task.repo && task.work && (
            <a className="icon-btn" title="下载" href={`${workPath(task.repo, task.work)}/exports/${encodeURIComponent(result.name)}?download=1`}>
              <Download size={14} />
            </a>
          )}
          <button
            className="icon-btn"
            title={running ? "取消导出" : "不再显示"}
            onClick={() =>
              running ? api(`/api/tasks/${task.id}/cancel`, { method: "POST" }).catch((error: Error) => toast(error.message, "error")) : dismissServer(task.id)
            }
          >
            <X size={14} />
          </button>
        </span>
      </div>
      <div className="export-item-meta">{["服务器", result?.width ? `${result.width}×${result.height}` : "", "MP4"].filter(Boolean).join(" · ")}</div>
      {running && (
        <div className="export-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div style={{ width: `${Math.max(1, percent)}%` }} />
        </div>
      )}
      <div className={`export-item-status ${state === "failed" ? "danger-text" : ""}`}>
        {running
          ? [`${percent}%`, task.message, task.eta != null ? `${finishClock(task.eta)} 完成` : ""].filter(Boolean).join(" · ")
          : task.status === "done"
            ? `已完成 · ${result?.name ?? ""}`
            : task.error || "导出失败"}
      </div>
    </div>
  );
}

function StateIcon({ state }: { state: LocalState }) {
  if (state === "rendering") return <Loader2 size={14} className="spin" />;
  if (state === "waiting") return <Clock3 size={14} className="faint" />;
  if (state === "paused") return <Pause size={14} className="warn-text" />;
  if (state === "done") return <CheckCircle2 size={14} className="ok-text" />;
  if (state === "failed") return <AlertCircle size={14} className="danger-text" />;
  return <AlertTriangle size={14} className="warn-text" />;
}
