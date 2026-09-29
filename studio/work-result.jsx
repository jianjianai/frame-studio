import { useRef, useState } from "react";
import { api, useQuery, Button, ErrorNote, Loading } from "./ui";
import { ReviewContext } from "./review-text";
import { reviewRange } from "../src/contracts/workflow.mjs";
import { RevisionPreview } from "./revision-preview";
import "./workflow.css";

const checkNames = {
  scope: "修改范围",
  structure: "工程结构",
  "project-tests": "项目检查",
  "preview-build": "预览构建",
};
const duration = (value) =>
  Number.isFinite(value) ? `${(value / 1000).toFixed(1)} 秒` : "未记录";
export function WorkResult({ work, task, notify, onChanged, onContinue }) {
  const query = useQuery("works_result", { id: work.id, task: task.id });
  const [side, setSide] = useState("after"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const request = useRef(null),
    pending = useRef(false),
    positions = useRef({});
  const data = query.data;
  if (query.loading && !data) return <Loading />;
  if (!data)
    return (
      <>
        <ErrorNote error={query.error} />
        <Button onClick={query.refresh}>重试读取创作结果</Button>
      </>
    );
  const version =
    side === "before"
      ? data.before
      : side === "reference"
        ? data.reference?.sourceCommit
        : data.after;
  const initial = positions.current[side] || task.input.context || {};
  const undo = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const old = request.current;
    const key =
      data.undo.requestKey ||
      (old?.expectedCommit === data.undo.expectedCommit &&
      old?.expectedRevision === data.undo.expectedRevision
        ? old.requestKey
        : crypto.randomUUID());
    const args = {
      id: work.id,
      task: task.id,
      requestKey: key,
      expectedCommit: data.undo.expectedCommit,
      expectedRevision: data.undo.expectedRevision,
    };
    request.current = args;
    try {
      const value = await api("works_undo", args);
      notify(
        value.previewTask
          ? "已撤销本轮修改，正在准备新预览"
          : "已撤销本轮修改，可更新预览查看",
      );
      query.refresh();
      onChanged?.();
    } catch (error) {
      setError(error.message);
      query.refresh();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="work-result-review">
      <div className="result-summary">
        <strong>{task.input.prompt}</strong>
        <p>
          {data.execution?.connectionName || "原执行连接"} ·{" "}
          {data.execution?.model || task.input.model || "工具默认模型"}
        </p>
        <p className="quiet">
          本轮确切文件变化：{data.total}{" "}
          项。文件差异不代表已证明对应画面的全部影响范围。
        </p>
        {data.current && (
          <small>
            当前作品版本 {data.current.slice(0, 7)}
            {data.after !== data.current ? " · 当前作品已包含后续修改" : ""}
          </small>
        )}
        <ReviewContext
          context={task.input.context}
          onRecall={() =>
            setSide(data.reference?.sourceCommit ? "reference" : "before")
          }
        />
      </div>
      <div className="result-version-switch" aria-label="修改前后版本">
        <Button
          disabled={!data.before || busy}
          aria-pressed={side === "before"}
          onClick={() => setSide("before")}
        >
          修改前 {data.before?.slice(0, 7)}
        </Button>
        <Button
          disabled={!data.after || busy}
          aria-pressed={side === "after"}
          onClick={() => setSide("after")}
        >
          修改后 {data.after?.slice(0, 7)}
        </Button>
        {data.reference?.sourceCommit &&
          data.reference.sourceCommit !== data.before && (
            <Button
              disabled={busy}
              aria-pressed={side === "reference"}
              onClick={() => setSide("reference")}
            >
              原引用版本 {data.reference.sourceCommit.slice(0, 7)}
            </Button>
          )}
        <Button
          disabled={busy}
          onClick={() => {
            setError("");
            query.refresh();
          }}
        >
          刷新状态
        </Button>
      </div>
      <p className="settings-help">
        每次只播放一个版本。引用时间属于原版本；新版若已改变时长，请按实际镜头重新定位。
      </p>
      {version || (side === "after" && task.result?.previewTask) ? (
        <RevisionPreview
          key={side + ":" + version}
          work={work}
          version={version}
          previewTask={side === "after" ? task.result?.previewTask : null}
          context={initial}
          label="本轮结果播放器"
          onPosition={(value) => {
            positions.current[side] = {
              time: value.time,
              ...(value.selection?.end > value.selection?.start
                ? value.selection
                : {}),
            };
          }}
        />
      ) : (
        <p>此旧任务没有可用的版本预览记录。</p>
      )}
      <div className="result-evidence">
        <h3>实际检查记录</h3>
        {data.validation.length ? (
          <div className="result-checks">
            {data.validation.map((check) => (
              <span key={check.check} className={check.status}>
                {check.status === "passed" ? "✓" : "×"}{" "}
                {checkNames[check.check]} · {duration(check.durationMs)}
              </span>
            ))}
          </div>
        ) : (
          <p>旧任务未记录逐项检查证据，不推定已经通过。</p>
        )}
        {data.executorMetrics && (
          <p>
            AI 执行：{duration(data.executorMetrics.agentMs)} · 执行器总耗时：
            {duration(data.executorMetrics.totalMs)}
          </p>
        )}
        {data.buildMetrics && (
          <p>
            画面编译：{duration(data.buildMetrics.compileMs)}
            {data.buildMetrics.audio
              ? ` · 音频准备：${duration(data.buildMetrics.audio.totalMs)} · 复用 ${data.buildMetrics.audio.reusedChunks}/${data.buildMetrics.audio.totalChunks} 个片段`
              : ""}
          </p>
        )}
        <details>
          <summary>查看文件变化 · {data.total} 项</summary>
          <div className="result-files">
            {data.changes.map((change) => (
              <div key={change.path}>
                <code>{change.status}</code>
                <span>{change.path}</span>
              </div>
            ))}
          </div>
          {data.truncated && (
            <p>只展示前 500 项，完整变化保存在作品 Git 历史中。</p>
          )}
        </details>
      </div>
      <ErrorNote error={error || query.error} />
      <div className="result-actions">
        <Button
          disabled={!version || busy}
          onClick={() =>
            onContinue?.({
              text: "请继续调整这个版本的作品：",
              review: {
                ...(reviewRange(positions.current[side] || initial) || {
                  time: 0,
                }),
                sourceCommit: version,
              },
            })
          }
        >
          基于正在看的版本继续调整
        </Button>
        <Button
          disabled={!data.undo.available || busy || query.loading}
          onClick={() => void undo()}
        >
          {busy
            ? "正在安全撤销…"
            : data.undo.recovery
              ? "重试完成撤销"
              : "撤销本轮修改"}
        </Button>
      </div>
      <p className="settings-help">
        {data.undo.reason ||
          "撤销只逆向应用本轮文件变化，保留后续无关修改；冲突时不覆盖正式作品。"}
      </p>
      {data.undo.error && <ErrorNote error={data.undo.error} />}
    </section>
  );
}
