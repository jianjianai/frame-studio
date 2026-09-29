import { useMemo, useRef, useState } from "react";
import {
  Sparkles,
  Play,
  Pencil,
  Square,
  RotateCcw,
  Check,
  ChevronDown,
} from "lucide-react";
import {
  useQuery,
  Button,
  ErrorNote,
  active,
  cancellable,
  states,
  date,
} from "../ui";
import { ReviewContext } from "../review-text";
import { TaskDiagnostics } from "../task-diagnostics";
import { AgentMarkdown, AgentCopy } from "./AgentMarkdown";
import { AgentSteps, AgentStep, elapsed } from "./AgentSteps";
import { AgentQuestion } from "./AgentQuestion";
import { AgentChangeSummary, AgentDiffViewer } from "./AgentFiles";
import {
  createAgentTimeline,
  groupAgentItems,
  latestAgentFiles,
  effectiveAgentPhase,
  searchableAgentItem,
} from "./agent-timeline";

function AgentUsage({ usage, task }) {
  const [open, setOpen] = useState(false);
  const value = usage?.usage;
  const input = value?.input_tokens ?? value?.inputTokens,
    output = value?.output_tokens ?? value?.outputTokens;
  if (!Number.isFinite(input) && !Number.isFinite(output)) return null;
  return (
    <div className="agent-usage">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title="提供商返回的本轮用量"
      >
        用量 <ChevronDown size={11} />
      </button>
      {open && (
        <span>
          输入 {Number.isFinite(input) ? input.toLocaleString() : "未提供"} ·
          输出 {Number.isFinite(output) ? output.toLocaleString() : "未提供"}{" "}
          token
          {Number.isFinite(usage.cost) ? ` · $${usage.cost.toFixed(4)}` : ""}
        </span>
      )}
    </div>
  );
}
export function AgentTurn({
  work,
  task,
  events = [],
  onRetry,
  onStop,
  onRecall,
  notify,
  onRetryPublication,
  onResult,
  onEdit,
  queue,
  search = "",
}) {
  const reducer = useRef(null);
  reducer.current ||= createAgentTimeline();
  const { items, usage } = useMemo(
    () => reducer.current.update(events),
    [events],
  );
  const groups = useMemo(() => groupAgentItems(items), [items]);
  const manifest = useMemo(() => latestAgentFiles(items), [items]);
  const [viewer, setViewer] = useState(null),
    [humanExpanded, setHumanExpanded] = useState(false);
  const hasWaiting = items.some(
    (item) => item.kind === "question" && item.question?.state === "pending",
  );
  const questions = useQuery(
    hasWaiting && task.state === "running" && work ? "agent_questions" : null,
    { work: work?.id, task: task.id },
    1,
  );
  const openFile = (file, files = manifest.files) => {
    if (typeof file === "string") {
      const selected = manifest.files.find(
        (entry) => entry.path === file || entry.path.endsWith("/" + file),
      );
      if (!selected) {
        notify("该文件没有本轮可审查的差异记录；未打开其他文件", "info");
        return;
      }
      file = selected;
    }
    setViewer({
      file,
      files: files.some((entry) => entry.path === file.path) ? files : [file],
      step: files !== manifest.files,
    });
  };
  const messageText = items
    .filter((item) => item.kind === "message")
    .map((item) => item.text || "")
    .join("\n\n");
  const timeMs =
    task.started && task.finished
      ? Math.max(
          0,
          new Date(task.finished) -
            new Date(task.started) -
            Number(task.input_wait_ms || 0),
        )
      : null;
  const userMatch =
    !!search && task.input.prompt.toLowerCase().includes(search.toLowerCase());
  return (
    <article
      className={"chat-turn agent-turn " + (active(task) ? "is-active" : "")}
      id={"agent-turn-" + task.id}
      data-task-id={task.id}
    >
      <div
        className={"agent-human " + (userMatch ? "is-search-match" : "")}
        data-agent-match={userMatch || undefined}
      >
        <div
          className={
            "human-message " + (humanExpanded || userMatch ? "expanded" : "")
          }
        >
          <div className="agent-human-text">{task.input.prompt}</div>
          <ReviewContext context={task.input.context} onRecall={onRecall} />
        </div>
        {task.input.prompt.length > 500 && (
          <button
            type="button"
            className="agent-human-expand"
            onClick={() => setHumanExpanded(!humanExpanded)}
          >
            {humanExpanded ? "收起要求" : "展开完整要求"}
          </button>
        )}
        <div className="agent-human-actions">
          <AgentCopy
            text={task.input.prompt}
            label="复制要求"
            notify={notify}
          />
          <button
            type="button"
            title="复制到输入框，修改后重新发送"
            onClick={() => onEdit(task)}
          >
            <Pencil size={13} />
            重新编辑要求
          </button>
        </div>
      </div>
      <div className="assistant-message agent-assistant">
        <div className="agent-turn-heading">
          <span className="agent-avatar">
            <Sparkles size={14} />
          </span>
          <strong>{task.execution?.model || task.input.model || "AI"}</strong>
          <span className={"agent-turn-state state-" + task.state}>
            {task.interaction
              ? "等待你的回答"
              : states[task.state] || "状态更新中"}
          </span>
          <time title={date(task.created)}>
            {elapsed(timeMs) || date(task.created)}
          </time>
        </div>
        <div className="agent-turn-content">
          {groups.map((group) =>
            group.type === "steps" ? (
              <AgentSteps
                key={group.id}
                items={group.items}
                taskState={task.state}
                onFile={openFile}
                onRecall={onRecall}
                notify={notify}
                search={search}
              />
            ) : group.item.kind === "message" ? (
              <div
                className={
                  "agent-prose " +
                  (search &&
                  searchableAgentItem(group.item)
                    .toLowerCase()
                    .includes(search.toLowerCase())
                    ? "is-search-match"
                    : "")
                }
                key={group.id}
                data-agent-item={group.id}
                data-agent-match={
                  (!!search &&
                    searchableAgentItem(group.item)
                      .toLowerCase()
                      .includes(search.toLowerCase())) ||
                  undefined
                }
              >
                <AgentMarkdown
                  text={group.item.text}
                  onRecall={onRecall}
                  onFile={openFile}
                  notify={notify}
                  streaming={
                    effectiveAgentPhase(group.item, task.state) === "running"
                  }
                />
                {group.item.textTruncated && (
                  <p className="agent-detail-note">
                    该条内容过长，显示已捕获的部分。
                  </p>
                )}
              </div>
            ) : group.item.kind === "question" &&
              group.item.question?.payload?.questions ? (
              <AgentQuestion
                key={group.id}
                question={
                  questions.data?.find(
                    (q) => q.id === group.item.question.id,
                  ) || group.item.question
                }
                task={task}
                work={work}
                onStop={onStop}
                notify={notify}
              />
            ) : (
              <AgentStep
                key={group.id}
                item={group.item}
                taskState={task.state}
                onFile={openFile}
                onRecall={onRecall}
                notify={notify}
                search={search}
              />
            ),
          )}
          {!items.length && active(task) && (
            <p className="agent-empty-progress">
              {task.state === "queued"
                ? "已排队，前一项工作结束后开始。"
                : "正在连接模型并准备创作…"}
            </p>
          )}
          <ErrorNote error={questions.error} />
          <AgentChangeSummary
            files={manifest.files}
            truncated={manifest.truncated}
            task={task}
            onOpen={openFile}
          />
          <ErrorNote error={task.error} />
          <TaskDiagnostics task={task} queue={queue} />
          {task.state === "succeeded" && (
            <div className="agent-turn-result turn-result">
              <div>
                <Check size={14} />
                <strong>已完成并保存</strong>
                {typeof task.result?.commit === "string" && (
                  <small>{task.result.commit.slice(0, 7)}</small>
                )}
              </div>
              <Button icon={Play} onClick={() => onResult(task)}>
                查看本轮预览与修改
              </Button>
            </div>
          )}
          <div className="agent-turn-footer">
            {messageText && !active(task) && (
              <AgentCopy
                text={messageText}
                label="复制 AI 回复"
                notify={notify}
              />
            )}
            {task.state === "failed" && (
              <button
                type="button"
                onClick={() =>
                  onRetry(
                    task.input.prompt,
                    task.input.context || {},
                    task.input.model,
                  )
                }
              >
                <RotateCcw size={13} />
                保留原引用重试
              </button>
            )}
            {task.state === "publish_failed" && (
              <button type="button" onClick={() => onRetryPublication(task.id)}>
                <RotateCcw size={13} />
                重试保存结果（不重跑 AI）
              </button>
            )}
            {cancellable(task) && !hasWaiting && (
              <button type="button" onClick={() => onStop(task.id)}>
                <Square size={12} />
                停止本次创作
              </button>
            )}
            {!active(task) && <AgentUsage usage={usage} task={task} />}
          </div>
        </div>
      </div>
      {viewer && (
        <AgentDiffViewer
          task={task}
          initial={viewer.file}
          files={viewer.files}
          scope={viewer.step ? "step" : "turn"}
          onClose={() => setViewer(null)}
          notify={notify}
        />
      )}
    </article>
  );
}
