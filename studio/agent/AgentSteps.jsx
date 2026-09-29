import { useEffect, useRef, useState } from "react";
import {
  BrainCircuit,
  Terminal,
  Wrench,
  FileCode2,
  Search,
  BookOpen,
  Check,
  Circle,
  CircleHelp,
  CircleAlert,
  ChevronRight,
  LoaderCircle,
  ListChecks,
  Users,
  Info,
  X,
} from "lucide-react";
import { AgentMarkdown, AgentCopy } from "./AgentMarkdown";
import { AgentFileList } from "./AgentFiles";
import {
  effectiveAgentPhase,
  isAgentRunning,
  searchableAgentItem,
} from "./agent-timeline";

export const elapsed = (ms) =>
  !Number.isFinite(ms)
    ? ""
    : ms < 1000
      ? "<1 秒"
      : ms < 60000
        ? `${Math.round(ms / 1000)} 秒`
        : `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`;
const phaseName = {
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  waiting: "待回答",
  ended: "执行已结束，未返回该步骤的结束状态",
};
export function AgentStatusIcon({ phase, size = 13 }) {
  return phase === "running" ? (
    <LoaderCircle size={size} className="spin" aria-label="进行中" />
  ) : phase === "completed" ? (
    <Check size={size} aria-label="已完成" />
  ) : phase === "failed" ? (
    <CircleAlert size={size} aria-label="失败" />
  ) : phase === "waiting" ? (
    <CircleHelp size={size} aria-label="待回答" />
  ) : (
    <X size={size} aria-label="已停止或结束" />
  );
}
function TerminalOutput({ output, running, truncated, notify }) {
  const ref = useRef(null),
    following = useRef(true);
  useEffect(() => {
    if (running && following.current && ref.current)
      ref.current.scrollTop = ref.current.scrollHeight;
  }, [output, running]);
  return (
    <div className="agent-terminal-output">
      <div className="agent-output-heading">
        <span>输出</span>
        <AgentCopy text={output || ""} label="复制输出" notify={notify} />
      </div>
      <pre
        ref={ref}
        tabIndex={0}
        aria-label="命令输出"
        onScroll={() => {
          const el = ref.current;
          following.current =
            el.scrollHeight - el.clientHeight - el.scrollTop < 28;
        }}
      >
        {output || (running ? "等待命令输出…" : "此命令没有输出")}
      </pre>
      {truncated && <small>仅保留最近的输出，较早部分已截断。</small>}
    </div>
  );
}
export function AgentStep({
  item,
  taskState,
  onFile,
  onRecall,
  notify,
  search = "",
}) {
  const phase = effectiveAgentPhase(item, taskState),
    [choice, setChoice] = useState(null);
  const matches =
    !!search &&
    searchableAgentItem(item).toLowerCase().includes(search.toLowerCase());
  const open =
    matches ||
    (choice ??
      (phase === "failed" ||
        (phase === "running" && item.kind === "command" && !!item.output)));
  const Icon =
    item.kind === "thinking"
      ? BrainCircuit
      : item.kind === "command"
        ? Terminal
        : item.kind === "files"
          ? FileCode2
          : item.kind === "plan"
            ? ListChecks
            : item.kind === "notice"
              ? Info
              : item.category === "search"
                ? Search
                : item.category === "read"
                  ? BookOpen
                  : item.category === "agent"
                    ? Users
                    : Wrench;
  const title =
    item.kind === "thinking"
      ? "思考摘要"
      : item.kind === "command"
        ? item.title === "验证与构建"
          ? "验证与构建"
          : "执行命令"
        : item.title || item.toolName || "工具调用";
  const preview =
    item.kind === "command"
      ? item.command
      : item.kind === "files"
        ? (item.files || []).map((f) => f.path.split("/").at(-1)).join("，")
        : item.input?.file_path ||
          item.input?.path ||
          item.input?.query ||
          item.input?.pattern ||
          "";
  return (
    <section
      className={
        "agent-step phase-" + phase + (matches ? " is-search-match" : "")
      }
      data-agent-item={item.id}
      data-agent-match={matches || undefined}
    >
      <button
        type="button"
        className="agent-step-toggle"
        aria-expanded={open}
        onClick={() => setChoice(!open)}
        title={preview || title}
      >
        <ChevronRight size={12} className={open ? "is-open" : ""} />
        <Icon size={14} />
        <span className="agent-step-label">
          <strong>{title}</strong>
          {preview && <code>{preview}</code>}
        </span>
        <span className="agent-step-timing">{elapsed(item.durationMs)}</span>
        <span className={"agent-step-status " + phase} title={phaseName[phase]}>
          <AgentStatusIcon phase={phase} />
        </span>
      </button>
      {open && (
        <div className="agent-step-detail">
          {item.parentId && (
            <p className="agent-detail-note">子任务中的执行步骤</p>
          )}
          {item.kind === "thinking" ? (
            <>
              <p className="agent-detail-note">
                提供商公开返回的思考摘要，不包含内部推理或加密内容。
              </p>
              {item.text ? (
                <AgentMarkdown
                  text={item.text}
                  onRecall={onRecall}
                  notify={notify}
                  streaming={phase === "running"}
                />
              ) : (
                <p className="agent-detail-note">
                  此提供商未返回可显示的摘要内容。
                </p>
              )}
            </>
          ) : item.kind === "command" ? (
            <>
              <div className="agent-command-line">
                <code>{item.command || "命令参数尚未返回"}</code>
                <AgentCopy
                  text={item.command}
                  label="复制命令"
                  notify={notify}
                />
              </div>
              {item.cwd && (
                <p className="agent-detail-note">
                  工作目录 <code>{item.cwd}</code>
                </p>
              )}
              <TerminalOutput
                output={item.output}
                running={phase === "running"}
                truncated={item.outputTruncated}
                notify={notify}
              />
              <div className="agent-exit-status">
                <span>{phaseName[phase]}</span>
                {Number.isInteger(item.exitCode) && (
                  <strong>退出码 {item.exitCode}</strong>
                )}
                {elapsed(item.durationMs) && (
                  <span>{elapsed(item.durationMs)}</span>
                )}
              </div>
            </>
          ) : item.kind === "files" ? (
            <>
              <AgentFileList
                files={item.files || []}
                onOpen={(file) => onFile(file, item.files || [])}
              />
              {item.output && (
                <pre className="agent-tool-output" tabIndex={0}>
                  {item.output}
                </pre>
              )}
            </>
          ) : item.kind === "plan" ? (
            <>
              {item.text && <p className="agent-detail-note">{item.text}</p>}
              <ol className="agent-plan">
                {(item.steps || []).map((step) => (
                  <li key={step.id} className={step.status}>
                    {step.status === "completed" ? (
                      <Check size={13} />
                    ) : step.status === "running" ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : (
                      <Circle size={12} />
                    )}
                    <span>{step.text}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : item.kind === "notice" ? (
            <p className="agent-detail-note">{item.text}</p>
          ) : (
            <>
              {item.input != null && (
                <div className="agent-tool-section">
                  <div className="agent-output-heading">
                    <span>输入参数</span>
                    <AgentCopy
                      text={JSON.stringify(item.input, null, 2)}
                      label="复制参数"
                      notify={notify}
                    />
                  </div>
                  <pre className="agent-tool-output" tabIndex={0}>
                    {typeof item.input === "string"
                      ? item.input
                      : JSON.stringify(item.input, null, 2)}
                  </pre>
                </div>
              )}
              {item.output && (
                <div className="agent-tool-section">
                  <div className="agent-output-heading">
                    <span>返回结果</span>
                    <AgentCopy
                      text={item.output}
                      label="复制结果"
                      notify={notify}
                    />
                  </div>
                  <pre className="agent-tool-output" tabIndex={0}>
                    {item.output}
                  </pre>
                </div>
              )}
              {!item.input && !item.output && (
                <p className="agent-detail-note">
                  {phase === "running"
                    ? "等待工具返回结果…"
                    : item.legacy
                      ? "历史记录只保存了活动摘要。"
                      : "该工具没有返回额外文本。"}
                </p>
              )}
            </>
          )}
          {item.error && (
            <p className="agent-inline-error" role="status">
              {item.error}
            </p>
          )}
          {phase === "ended" && (
            <p className="agent-detail-note">
              未收到此步骤的结束事件；不将它标记为成功。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
export function AgentSteps({ items, taskState, search, ...props }) {
  const [choice, setChoice] = useState(null);
  const [visible, setVisible] = useState(60);
  const unknown = items.filter(
    (item) => effectiveAgentPhase(item, taskState) === "ended",
  );
  const active = items.filter((item) =>
      isAgentRunning(effectiveAgentPhase(item, taskState)),
    ),
    failed = items.filter(
      (item) => effectiveAgentPhase(item, taskState) === "failed",
    );
  const matched =
    !!search &&
    items.some((item) =>
      searchableAgentItem(item).toLowerCase().includes(search.toLowerCase()),
    );
  const open = matched || (choice ?? (active.length > 0 || failed.length > 0));
  const title = active.length
    ? active.at(-1).kind === "thinking"
      ? "正在思考"
      : active.at(-1).title || "正在执行"
    : failed.length
      ? `${items.length} 个步骤 · ${failed.length} 项需要查看`
      : unknown.length
        ? `执行已结束 · ${unknown.length} 项未返回结束状态`
        : taskState === "cancelled"
          ? `执行已停止 · ${items.length} 个步骤`
          : `已完成 ${items.length} 个步骤`;
  return (
    <section className={"agent-steps " + (open ? "is-expanded" : "")}>
      <button
        type="button"
        className="agent-steps-heading"
        aria-expanded={open}
        onClick={() => setChoice(!open)}
      >
        <ChevronRight size={13} className={open ? "is-open" : ""} />
        {active.length ? (
          <LoaderCircle size={13} className="spin" />
        ) : failed.length ? (
          <CircleAlert size={13} />
        ) : (
          <Check size={13} />
        )}
        <span>{title}</span>
        {!active.length && <small>{open ? "收起过程" : "查看过程"}</small>}
      </button>
      {open && (
        <div
          className="agent-steps-body"
          onClickCapture={() => setChoice(true)}
        >
          {items.length > visible && !search && (
            <button
              type="button"
              className="agent-more-lines"
              onClick={() => setVisible((n) => n + 60)}
            >
              显示更早的 {Math.min(items.length - visible, 60)} 个步骤
            </button>
          )}
          {(search ? items : items.slice(-visible)).map((item) => (
            <AgentStep
              key={item.id}
              item={item}
              taskState={taskState}
              search={search}
              {...props}
            />
          ))}
        </div>
      )}
    </section>
  );
}
