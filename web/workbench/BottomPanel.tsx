import { useEffect, useState } from "react";
import { X, AlertCircle, AlertTriangle, Sparkles, RefreshCw, CircleStop, CheckCircle2, Loader2, FileCode2 } from "lucide-react";
import { api, timeAgo, useServerEvent } from "../lib/api";
import type { Task } from "../lib/types";
import { useWorkbench } from "./store";
import { Timeline } from "./Timeline";

export function BottomPanel({ tab, setTab, onClose }: { tab: string; setTab: (tab: string) => void; onClose: () => void }) {
  const { check } = useWorkbench();
  const errors = check?.problems.filter((problem) => problem.severity === "error").length ?? 0;
  const tabs = [
    { id: "timeline", label: "时间轴" },
    { id: "problems", label: "问题", count: check?.problems.length ?? 0, danger: errors > 0 },
    { id: "tasks", label: "任务" },
  ];
  return (
    <div className="panel">
      <div className="panel-tabs">
        {tabs.map((item) => (
          <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
            {item.label}
            {item.count ? <span className={`badge ${item.danger ? "danger" : "warn"}`}>{item.count}</span> : null}
          </button>
        ))}
        <span className="grow" />
        <button className="icon-btn" title="关闭面板 (Ctrl+J)" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="panel-body">
        {tab === "timeline" && <Timeline />}
        {tab === "problems" && <Problems />}
        {tab === "tasks" && <Tasks />}
      </div>
    </div>
  );
}

function Problems() {
  const { check, runCheck, openFile, askAi } = useWorkbench();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    await runCheck();
    setBusy(false);
  };
  return (
    <div className="problems">
      <div className="panel-toolbar">
        <button className="btn small" disabled={busy} onClick={run}>
          {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} 检查作品
        </button>
        {check && (
          <span className="muted small-text">
            {timeAgo(check.checkedAt)} · {check.ms} ms
          </span>
        )}
        <span className="grow" />
        {check && check.problems.length > 0 && (
          <button
            className="btn small primary"
            onClick={() =>
              askAi(
                "作品检查发现以下问题，请修复后重新检查：\n" +
                  check.problems
                    .map(
                      (problem) =>
                        `- [${problem.source}] ${problem.file ? problem.file + (problem.line ? ":" + problem.line : "") + " " : ""}${problem.message}`,
                    )
                    .join("\n"),
              )
            }
          >
            <Sparkles size={13} /> 让 AI 修复全部
          </button>
        )}
      </div>
      {!check && <div className="empty">还没有检查过。AI 修改后会自动检查，也可以手动检查。</div>}
      {check && check.problems.length === 0 && (
        <div className="empty">
          <CheckCircle2 size={16} style={{ color: "var(--ok)", verticalAlign: "-3px" }} /> 没有发现问题
        </div>
      )}
      {check?.problems.map((problem, index) => (
        <div key={index} className="problem-row" onClick={() => problem.file && openFile(problem.file, { line: problem.line })}>
          {problem.severity === "error" ? <AlertCircle size={14} className="danger-text" /> : <AlertTriangle size={14} className="warn-text" />}
          <span className="badge">{problem.source}</span>
          <span className="grow problem-message">{problem.message}</span>
          {problem.file && (
            <span className="faint mono small-text">
              <FileCode2 size={12} /> {problem.file}
              {problem.line ? `:${problem.line}` : ""}
            </span>
          )}
          <button
            className="icon-btn"
            title="让 AI 修复"
            onClick={(event) => {
              event.stopPropagation();
              askAi(
                `请修复这个问题：[${problem.source}] ${problem.file ? problem.file + (problem.line ? ":" + problem.line : "") + " " : ""}${problem.message}`,
              );
            }}
          >
            <Sparkles size={14} />
          </button>
        </div>
      ))}
      {check?.console && check.console.length > 0 && (
        <details className="console-log">
          <summary>浏览器控制台（{check.console.length}）</summary>
          <pre>{check.console.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}

function Tasks() {
  const { work } = useWorkbench();
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    void api<Task[]>(`/api/tasks?work=${work.id}`).then(setTasks);
  }, [work.id]);
  useServerEvent((event) => {
    if (event.type !== "task") return;
    const task = event.task as Task;
    if (task.work && task.work !== work.id) return;
    setTasks((list) => [task, ...list.filter((item) => item.id !== task.id)]);
  });
  if (!tasks.length) return <div className="empty">没有后台任务。导出、模型下载等会显示在这里。</div>;
  return (
    <div className="tasks">
      {tasks.map((task) => (
        <div className="task-row" key={task.id}>
          {task.status === "running" ? (
            <Loader2 size={14} className="spin" />
          ) : task.status === "done" ? (
            <CheckCircle2 size={14} className="ok-text" />
          ) : (
            <AlertCircle size={14} className="danger-text" />
          )}
          <span className="task-title">{task.title}</span>
          <span className="muted small-text grow ellipsis">{task.error || task.message}</span>
          {task.progress != null && task.status === "running" && (
            <div className="progress">
              <div style={{ width: `${Math.round(task.progress * 100)}%` }} />
            </div>
          )}
          <span className="faint small-text">{timeAgo(task.startedAt)}</span>
          {task.status === "running" && (
            <button className="icon-btn" title="取消" onClick={() => api(`/api/tasks/${task.id}/cancel`, { method: "POST" })}>
              <CircleStop size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
