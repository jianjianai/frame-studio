import "./task-diagnostics.css";
const ms = (value) =>
  Number.isFinite(value) ? `${(value / 1000).toFixed(1)} 秒` : null;
export function TaskDiagnostics({ task, queue }) {
  const metrics = task.metrics || {};
  const values = [
    ["排队", metrics.queueMs],
    ["准备", metrics.prepareMs],
    ["保存", metrics.publicationMs],
  ].filter(([, value]) => Number.isFinite(value));
  if (!queue && !values.length) return null;
  return (
    <div className="task-diagnostics">
      {queue && (
        <p className="queue-reason" role="status">
          {queue.reason}
          {queue.blocker ? ` · 任务 ${queue.blocker.id.slice(0, 8)}` : ""}
        </p>
      )}
      {!!values.length && (
        <small>
          {values.map(([label, value]) => `${label} ${ms(value)}`).join(" · ")}
        </small>
      )}
    </div>
  );
}
