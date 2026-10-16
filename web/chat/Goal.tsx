import { useEffect, useState } from "react";
import { Target, Check, X, Pause, Play, ChevronDown, ChevronRight } from "lucide-react";
import { formatDuration, formatTokens, type GoalBlock } from "./reduce";

/**
 * Goal mode as the agents' CLIs show it: "/goal <condition>" keeps the AI working until the
 * condition holds; each time it would stop, the goal is checked ("not met yet… continuing").
 * Here: the goal bar above the input box (what the CLI keeps in its footer) and the goal's
 * lines in the conversation.
 */
export interface GoalState {
  objective: string;
  /** Codex also pauses goals, and stops them at a limit or when blocked. */
  status: "active" | "paused" | "blocked" | "limited";
  setAt: number;
  /** Claude: checks so far that found the goal not met yet, and why the last one did. */
  checks?: number;
  lastReason?: string | null;
  checkedAt?: number;
  /** Codex: what the goal has used. */
  tokensUsed?: number | null;
  timeUsedSeconds?: number | null;
  tokenBudget?: number | null;
}

/** "/goal …" as typed. */
export function goalCommand(text: string): { action: "set" | "clear" | "pause" | "resume" | "status"; objective?: string } | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const argument = (match[1] ?? "").trim();
  if (!argument) return { action: "status" };
  const word = argument.toLowerCase();
  if (["clear", "stop", "off", "reset", "none", "cancel"].includes(word)) return { action: "clear" };
  if (word === "pause" || word === "resume") return { action: word };
  return { action: "set", objective: argument };
}

function useNow(interval: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

const STATUS: Record<GoalState["status"], string> = { active: "进行中", paused: "已暂停", blocked: "受阻", limited: "到了上限" };

/** A reason the evaluator gave, a line until clicked open. */
function Reason({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`goal-reason ${open ? "open" : ""}`} onClick={() => setOpen(!open)} title={open ? "收起" : "展开"}>
      <span className="goal-reason-label">{label}</span>
      <span className="goal-reason-text">{text}</span>
    </div>
  );
}

export type GoalAction = "clear" | "pause" | "resume" | "continue";

/** Why the AI is not working toward a goal that is still there. */
const HALTED = {
  stopped: "已停止这一轮，目标还在。点「继续」或发条消息，AI 就接着朝目标做；不想继续就「结束目标」。",
  capped: "AI 连续多次想停下都没达成目标，Claude 先结束了这一轮。看看上次检查说还差什么：点「继续」接着做，或发消息给它指个方向；不想继续就「结束目标」。",
};

/**
 * The goal the AI is working toward, above the input box: what it is, for how long, the last
 * check and why it was not met yet, and the controls (end it; Codex: pause, resume; go on
 * when no turn is running). A turn that ended short of the goal (stopped, or Claude's limit
 * of checks in a row) leaves the goal in place, as the CLI does: the bar says so.
 */
export function GoalBar({
  goal,
  agent,
  running,
  halted,
  onAction,
}: {
  goal: GoalState;
  agent?: string;
  running: boolean;
  halted: keyof typeof HALTED | null;
  onAction: (action: GoalAction) => void;
}) {
  const now = useNow(1000);
  const [open, setOpen] = useState(false);
  const used = goal.timeUsedSeconds != null && agent === "codex" ? goal.timeUsedSeconds * 1000 : Math.max(0, now - goal.setAt);
  const facts = [
    formatDuration(used),
    goal.checks ? `检查 ${goal.checks} 次未达成` : "",
    goal.tokensUsed ? `${formatTokens(goal.tokensUsed)}${goal.tokenBudget ? ` / ${formatTokens(goal.tokenBudget)}` : ""} tokens` : "",
  ].filter(Boolean);
  return (
    <div className={`goal-bar ${goal.status}`}>
      <div className="goal-head">
        <button className="goal-toggle" onClick={() => setOpen(!open)} title={open ? "收起目标" : "展开目标"}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Target size={13} />
          <strong>目标</strong>
          <span className="goal-state">{STATUS[goal.status]}</span>
          {!open && <span className="ellipsis goal-objective">{goal.objective}</span>}
        </button>
        {!running && (goal.status === "active" || goal.status === "blocked") && (
          <button className="goal-go" title="让 AI 接着朝目标做" onClick={() => onAction("continue")}>
            <Play size={11} /> 继续
          </button>
        )}
        {agent === "codex" &&
          (goal.status === "paused" ? (
            <button className="icon-btn tiny" title="继续目标" onClick={() => onAction("resume")}>
              <Play size={12} />
            </button>
          ) : (
            <button className="icon-btn tiny" title="暂停目标：AI 做完手上这一步就停" onClick={() => onAction("pause")}>
              <Pause size={12} />
            </button>
          ))}
        <button className="goal-end" title="结束目标：AI 不再被要求一直做下去，做完手上这一步就可以停" onClick={() => onAction("clear")}>
          结束目标
        </button>
      </div>
      {open && <div className="goal-full">{goal.objective}</div>}
      <div className="goal-facts">{facts.join(" · ")}</div>
      {goal.lastReason && <Reason label="上次检查" text={goal.lastReason} />}
      {!running && halted && <div className="goal-hint">{HALTED[halted]}</div>}
    </div>
  );
}

const COUNT = (block: GoalBlock) =>
  [
    block.durationMs != null ? `用时 ${formatDuration(block.durationMs)}` : "",
    block.iterations ? `检查 ${block.iterations} 次` : "",
    block.tokens ? `${formatTokens(block.tokens)} tokens` : "",
  ]
    .filter(Boolean)
    .join(" · ");

/** A goal line in the conversation, as the CLI prints it. */
export function GoalLine({ block }: { block: GoalBlock }) {
  const stats = COUNT(block);
  switch (block.event) {
    case "set":
      return (
        <div className="goal-line">
          <Target size={13} />
          <span>设定了目标：AI 会一直做下去，每次想停下时检查是否达成</span>
        </div>
      );
    case "check":
      return (
        <div className="goal-line pending">
          <Target size={13} />
          <span>目标还没达成，继续{block.checks ? `（第 ${block.checks} 次检查）` : ""}</span>
          {block.reason && <Reason label="原因" text={block.reason} />}
        </div>
      );
    case "met":
      return (
        <div className="goal-line met">
          <Check size={13} />
          <span>目标达成{stats ? `（${stats}）` : ""}</span>
          {block.reason && <Reason label="判断" text={block.reason} />}
        </div>
      );
    case "failed":
      return (
        <div className="goal-line failed">
          <X size={13} />
          <span>目标无法完成{stats ? `（${stats}）` : ""}</span>
          {block.reason && <Reason label="原因" text={block.reason} />}
        </div>
      );
    case "cleared":
      return (
        <div className="goal-line">
          <Target size={13} />
          <span>目标已结束{block.byUser ? "" : "（AI 那边清除了它）"}</span>
        </div>
      );
    case "status":
      return (
        <div className="goal-line pending">
          <Target size={13} />
          <span>目标进行中{block.checks ? `：检查了 ${block.checks} 次，还没达成` : "：还没检查过"}</span>
          {block.reason && <Reason label="上次检查" text={block.reason} />}
        </div>
      );
    case "none":
      return (
        <div className="goal-line pending">
          <Target size={13} />
          <span>现在没有目标</span>
        </div>
      );
    case "capped":
      return (
        <div className="goal-line warn">
          <Target size={13} />
          <span>AI 连续 {block.checks} 次想停下，检查都说还没达成，Claude 按上限先结束了这一轮；目标还在</span>
        </div>
      );
    case "paused":
      return (
        <div className="goal-line">
          <Pause size={13} />
          <span>目标已暂停</span>
        </div>
      );
    case "active":
      return (
        <div className="goal-line">
          <Play size={13} />
          <span>目标继续</span>
        </div>
      );
    case "blocked":
      return (
        <div className="goal-line failed">
          <Target size={13} />
          <span>目标受阻：AI 卡住了，看它说的原因，处理后可以「继续」</span>
        </div>
      );
    case "limited":
      return (
        <div className="goal-line failed">
          <Target size={13} />
          <span>目标到了上限（用量或预算），已停下</span>
        </div>
      );
    default:
      return null;
  }
}

/** A goal command the user sent, as the chat shows it instead of the raw text. */
export function GoalCommandMessage({ text }: { text: string }) {
  const command = goalCommand(text);
  if (!command) return null;
  if (command.action === "set")
    return (
      <div className="user-msg goal-msg">
        <div className="goal-msg-head">
          <Target size={12} /> 设定目标
        </div>
        <div className="user-text">{command.objective}</div>
      </div>
    );
  const label = { clear: "结束目标", pause: "暂停目标", resume: "继续目标", status: "查看目标" }[command.action];
  return (
    <div className="command-msg">
      <Target size={12} /> {label}
    </div>
  );
}

/** How the composer explains a command while it is typed (the agents' own words are English). */
export const COMMAND_TEXT: Record<string, { description: string; hint?: string }> = {
  goal: { description: "设定目标：AI 一直做下去，直到满足你写的条件", hint: "<完成条件> | clear" },
  compact: { description: "压缩上下文：总结之前的对话，腾出空间" },
};

/** Shown above the input box while a goal is being typed. */
export function GoalTip() {
  return (
    <div className="goal-tip">
      <Target size={12} />
      <span>
        写清楚<strong>做到什么程度算完成</strong>（例如“全片每个镜头都做完，并用 preview_frames 逐个核对过”）。AI
        每次想停下时都会检查这个条件，没满足就继续做。中途随时可以发消息调整方向（会插进 AI 正在做的这一轮），不想继续就「结束目标」。
      </span>
    </div>
  );
}
