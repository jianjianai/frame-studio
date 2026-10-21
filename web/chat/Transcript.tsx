import { Fragment, useEffect, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Pencil,
  Terminal,
  Search,
  Globe,
  Brain,
  Wrench,
  Trash2,
  ArrowRightLeft,
  CheckCircle2,
  XCircle,
  Loader2,
  Circle,
  ShieldQuestion,
  AlertTriangle,
  ListChecks,
  Image as ImageIcon,
  Sparkles,
  Clapperboard,
  Info,
  KeyRound,
} from "lucide-react";
import { useWorkbench } from "../workbench/store";
import { focusRemote, loginDone, showBrowserTab, useBrowserState } from "../lib/browser";
import { formatTime } from "../lib/api";
import { Markdown } from "./Markdown";
import { lineDiff, compactDiff } from "./lineDiff";
import { GoalLine } from "./Goal";
import {
  formatCost,
  formatDuration,
  formatTokens,
  textAmount,
  textHead,
  OUTPUT_LIMIT,
  type Block,
  type ContentBlock,
  type ToolBlock,
  type ToolContent,
  type TurnEnd,
} from "./reduce";

const kindIcon = (kind?: string, title = "") => {
  if (/frame__|^mcp\.frame\.|frame\./.test(title)) return <Clapperboard size={13} />;
  switch (kind) {
    case "read":
      return <FileText size={13} />;
    case "edit":
      return <Pencil size={13} />;
    case "delete":
      return <Trash2 size={13} />;
    case "move":
      return <ArrowRightLeft size={13} />;
    case "execute":
      return <Terminal size={13} />;
    case "search":
      return <Search size={13} />;
    case "fetch":
      return <Globe size={13} />;
    case "think":
      return <Brain size={13} />;
    default:
      return <Wrench size={13} />;
  }
};

/** "mcp__frame__preview_frames" → "FRAME · 查看画面" style names. */
const FRAME_TOOL_NAMES: Record<string, string> = {
  frame_guide: "查阅制作指南",
  work_context: "读取作品现状",
  work_check: "检查作品",
  preview_frames: "查看画面",
  preview_audio: "分析声音",
  files_list: "列出文件",
  files_batch: "读写文件",
  search: "搜索",
  upload_link: "上传本机文件",
  asset_import: "导入素材",
  asset_view: "查看素材",
  audio_place: "放置音频",
  layers_get: "读取图层",
  layers_edit: "编辑图层",
  audio_get: "读取混音",
  audio_edit: "编辑混音",
  speech_synthesize: "生成配音",
  speech_voices: "列出声音",
  versions_list: "版本历史",
  version_save: "保存版本",
  work_delete: "请求删除作品",
  version_restore: "恢复版本",
  version_diff: "查看改动",
  export_video: "导出视频",
  task_status: "任务状态",
  work_update: "修改作品信息",
  materials_list: "查看素材库",
  materials_link: "关联素材库",
  material_read: "阅读素材库文件",
  materials_use: "使用素材",
  material_write: "修改素材库",
  materials_commit: "保存素材库版本",
  subtitles_edit: "编辑字幕",
  experience_read: "阅读经验库",
  experience_write: "整理经验库",
  experience_link: "关联经验库",
  experience_commit: "保存经验库版本",
  browser_open: "打开网页",
  browser_read: "读网页",
  browser_tabs: "列出标签页",
  browser_act: "操作网页",
  browser_download: "从网页下载",
  browser_login: "请你登录",
  browser_cookies: "导出登录信息",
};
export function toolTitle(title: string) {
  if (title === "Compact conversation") return "压缩上下文";
  const match = /(?:mcp__frame__|mcp\.frame\.|frame[.:])([a-z_]+)/.exec(title);
  if (match) return FRAME_TOOL_NAMES[match[1]] ?? match[1];
  return title;
}

const KIND_ACTIVITY: Record<string, string> = {
  read: "读取文件",
  edit: "修改文件",
  delete: "删除文件",
  move: "移动文件",
  execute: "运行命令",
  search: "搜索",
  fetch: "访问网页",
};
/** The tool the AI waits on: the last thing it did, still running. */
export function runningTool(items: Block[]) {
  const last = items.at(-1);
  return last?.kind === "tool" && (last.status === "pending" || last.status === "in_progress") ? last : null;
}
/** What the AI is doing, in a word or two, from the last thing it did. */
export function activity(items: Block[], waiting: boolean) {
  if (waiting) return "等待你确认";
  const last = runningTool(items);
  if (!last) {
    const kind = items.at(-1)?.kind;
    return kind === "text" ? "回复中" : kind === "notice" ? "等待中" : kind === "goal" ? "继续朝目标做" : "思考中";
  }
  const name = toolTitle(last.title);
  if (name !== last.title && !name.includes("_")) return name; // compaction, a FRAME tool with a name
  return KIND_ACTIVITY[last.toolKind ?? ""] ?? "调用工具";
}

const StatusIcon = ({ status }: { status?: string }) =>
  status === "completed" ? (
    <CheckCircle2 size={13} className="ok-text" />
  ) : status === "failed" ? (
    <XCircle size={13} className="danger-text" />
  ) : status === "in_progress" || status === "pending" ? (
    <Loader2 size={13} className="spin muted" />
  ) : (
    <Circle size={13} className="faint" />
  );

/** A tool's text. A long one shows its beginning, says how much is left out, and opens whole. */
function LongText({ text, className = "" }: { text: string; className?: string }) {
  const [all, setAll] = useState(false);
  const cut = textHead(text);
  if (!cut) return <pre className={`tool-text ${className}`}>{text}</pre>;
  return (
    <div className="tool-long">
      <pre className={`tool-text ${className} ${all ? "all" : ""}`}>{all ? text : cut.head}</pre>
      <div className="tool-more">
        <span>{all ? `共 ${textAmount(text)}` : `已截断，还有 ${textAmount(cut.rest)}未显示`}</span>
        <button className="link-btn" onClick={() => setAll(!all)}>
          {all ? "收起" : "展开全部"}
        </button>
      </div>
    </div>
  );
}

function ContentView({ item }: { item: ToolContent }) {
  if (item.type === "diff") {
    const lines = compactDiff(lineDiff(item.oldText ?? "", item.newText ?? ""));
    return (
      <div className="tool-diff">
        <div className="tool-diff-path mono">{item.path?.split("/").slice(-3).join("/")}</div>
        <pre>
          {lines.map((line, index) =>
            line.type === "gap" ? (
              <div key={index} className="gap">
                ⋯ {line.count} 行未改动
              </div>
            ) : (
              <div key={index} className={line.type}>
                {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
                {line.text}
              </div>
            ),
          )}
        </pre>
      </div>
    );
  }
  if (item.type === "terminal") return <div className="faint small-text">终端 {item.terminalId}</div>;
  const content = item.content;
  if (!content) return null;
  if (content.type === "image") return <img className="tool-image" src={content.uri || `data:${content.mimeType};base64,${content.data}`} alt="" />;
  if (content.type === "text") {
    const text = content.text ?? "";
    return <LongText text={text.startsWith("```") ? text.replace(/^```\w*\n?|```$/g, "") : text} />;
  }
  if (content.type === "resource_link" || content.type === "resource")
    return <div className="faint small-text">{content.name || content.uri || content.resource?.uri}</div>;
  return null;
}

/** What a tool produced. Codex leaves `content` empty for most tools: shell output arrives as
 * terminal deltas and MCP results only in `rawOutput`, so fall back to those. */
function toolResults(tool: ToolBlock): ToolContent[] {
  const items = tool.content.filter((item) => item.type !== "terminal");
  const text = (value: string): ToolContent => ({ type: "content", content: { type: "text", text: value } });
  if (tool.output) items.push(text(tool.outputCut ? `${tool.output}\n…（输出超过 ${OUTPUT_LIMIT / 10000} 万字，后面的没有保留）` : tool.output));
  if (tool.exitCode) items.push(text(`退出码 ${tool.exitCode}`));
  if (items.some((item) => item.type === "content")) return items;
  const raw = tool.rawOutput as { result?: { content?: unknown }; error?: unknown; output?: unknown; stdout?: unknown } | string | undefined;
  if (typeof raw === "string") {
    if (raw) items.push(text(raw));
  } else if (raw && typeof raw === "object") {
    if (Array.isArray(raw.result?.content))
      for (const content of raw.result.content as ContentBlock[]) items.push({ type: "content", content });
    if (raw.error) items.push(text(typeof raw.error === "string" ? raw.error : JSON.stringify(raw.error, null, 2)));
    for (const value of [raw.output, raw.stdout]) if (typeof value === "string" && value) items.push(text(value));
  }
  return items;
}

/** MCP arguments, shown when the card is opened ({ server, tool, arguments } from Codex, plain object from Claude). */
function toolArguments(tool: ToolBlock) {
  if (!/mcp__|^mcp\.|frame[.:]/.test(tool.title)) return "";
  const input = tool.rawInput as { arguments?: unknown } | undefined;
  const args = input && typeof input === "object" && "arguments" in input ? input.arguments : input;
  if (!args || typeof args !== "object" || !Object.keys(args).length) return "";
  return JSON.stringify(args, null, 2);
}

/** A tool call whole, when the conversation cut its long texts short (null if it cannot be had). */
export type LoadTool = (id: string) => Promise<ToolBlock | null>;

function ToolCard({ tool: short, load }: { tool: ToolBlock; load?: LoadTool }) {
  const [open, setOpen] = useState(false);
  // Opened, a finished call whose texts were cut short is shown whole (while it runs, as it
  // streams in); undefined until asked for, null when it could not be had.
  const [whole, setWhole] = useState<ToolBlock | null | undefined>(undefined);
  const running = short.status === "pending" || short.status === "in_progress";
  const cut = Boolean(short.cut && load) && !running;
  useEffect(() => {
    if (!open || !cut) return;
    let current = true;
    load!(short.id).then(
      (found) => current && setWhole(found),
      () => current && setWhole((value) => value ?? null),
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cut, short.id, short.status]);
  const tool = open && cut && whole?.id === short.id ? { ...whole, status: short.status } : short;
  const loading = open && cut && whole === undefined;
  const results = toolResults(tool);
  const images = results.filter((item) => item.content?.type === "image");
  const args = open ? toolArguments(tool) : "";
  const title = toolTitle(tool.title);
  const input = tool.rawInput as Record<string, unknown> | undefined;
  const diffPath = tool.content.find((item) => item.type === "diff")?.path ?? tool.locations?.[0]?.path;
  const detail =
    (input && typeof input === "object"
      ? input.path ||
        input.file_path ||
        input.command ||
        input.url ||
        input.pattern ||
        (Array.isArray(input.times) ? (input.times as number[]).map((t) => formatTime(t)).join(", ") : "")
      : "") || (tool.toolKind === "edit" && diffPath ? diffPath.split("/").slice(-2).join("/") : "");
  return (
    <div className={`tool-card status-${tool.status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {kindIcon(tool.toolKind, tool.title)}
        <span className="tool-title ellipsis">{title}</span>
        {detail && detail !== tool.title ? <span className="tool-detail ellipsis mono">{String(detail)}</span> : null}
        {images.length > 0 && <ImageIcon size={12} className="faint" />}
        <span className="grow" />
        <StatusIcon status={tool.status} />
      </button>
      {open && (
        <div className="tool-body">
          {loading ? (
            <div className="faint small-text">正在载入…</div>
          ) : (
            <>
              {args && <LongText text={args} className="tool-args" />}
              {results.map((item, index) => (
                <ContentView key={index} item={item} />
              ))}
              {!args && !results.length && <div className="faint small-text">{running ? "运行中…" : "没有输出"}</div>}
              {tool.cut && (
                <div className="tool-more">
                  {running ? "内容较长，这里只有开头，运行结束后可查看全部" : "内容较长，这里只有开头：完整内容没有载入成功，收起再展开可重试"}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {!open && images.length > 0 && (
        <div className="tool-thumbs">
          {images.slice(0, 4).map((item, index) => (
            <img key={index} src={item.content!.uri || `data:${item.content!.mimeType};base64,${item.content!.data}`} alt="" onClick={() => setOpen(true)} />
          ))}
        </div>
      )}
    </div>
  );
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="thought">
      <button className="tool-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Brain size={13} />
        <span className="muted">思考</span>
        {!open && <span className="faint ellipsis thought-preview">{text.trim().split("\n")[0]}</span>}
      </button>
      {open && <div className="thought-body">{text.trim()}</div>}
    </div>
  );
}

function Permission({ block, onRespond }: { block: Extract<Block, { kind: "permission" }>; onRespond: (id: string, optionId?: string) => void }) {
  const decided = block.outcome?.outcome;
  const chosen = decided?.optionId ? block.options.find((option) => option.optionId === decided.optionId)?.name : decided ? "已取消" : null;
  const input = block.toolCall?.rawInput as Record<string, unknown> | undefined;
  return (
    <div className={`permission-card ${decided ? "decided" : ""}`}>
      <div className="row">
        <ShieldQuestion size={15} className="warn-text" />
        <strong className="grow">{toolTitle(block.toolCall?.title || "AI 请求执行操作")}</strong>
      </div>
      {input && (input.command || input.path || input.file_path) ? (
        <pre className="tool-text">{String(input.command || input.path || input.file_path)}</pre>
      ) : null}
      {block.toolCall?.content?.map((item, index) => (
        <ContentView key={index} item={item} />
      ))}
      {chosen ? (
        <div className="faint small-text">已选择：{chosen}</div>
      ) : (
        <div className="row wrap">
          {block.options.map((option) => (
            <button
              key={option.optionId}
              className={`btn small ${option.kind.startsWith("allow") ? (option.kind === "allow_once" ? "primary" : "") : "danger"}`}
              onClick={() => onRespond(block.id, option.optionId)}
            >
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The AI asks the user to log in to a site (browser_login): open the browser there, and say when
 * it is done (the AI gets a message). Only while that tab still waits for the login.
 */
function LoginRequest({ tool }: { tool: ToolBlock }) {
  const { openTool, work } = useWorkbench();
  const { tabs, remoteTabs } = useBrowserState(work.repo);
  const input = (tool.rawInput ?? {}) as { url?: string; reason?: string };
  const text = toolResults(tool)
    .map((item) => (item.content?.type === "text" ? item.content.text : ""))
    .join("\n");
  const tabId = /标签页 (t[0-9a-f]{6}|x\d+)/.exec(text)?.[1];
  const remote = Boolean(tabId?.startsWith("x"));
  const tab = tabId ? (remote ? remoteTabs : tabs).find((item) => item.id === tabId) : undefined;
  if (tool.status !== "completed" || !tabId || !tab?.login) return null;
  return (
    <div className="permission-card login-card">
      <div className="row">
        <KeyRound size={15} className="warn-text" />
        <strong className="grow">AI 请你登录 {tab.login.host}</strong>
      </div>
      <div className="small-text">{tab.login.reason || input.reason}</div>
      <div className="faint small-text">
        {remote ? "在你电脑上的浏览器里登录（AI 已经把那个页面切到前面）" : "在 FRAME 浏览器里登录"}：扫码、密码、验证码都在那里输入，不要发到聊天里。
      </div>
      <div className="row wrap">
        {remote ? (
          <button className="btn small primary" onClick={() => void focusRemote(work.repo, tabId).catch(() => {})}>
            <Globe size={13} /> 在电脑上打开那个页面
          </button>
        ) : (
          <button
            className="btn small primary"
            onClick={() => {
              showBrowserTab(tabId);
              openTool("browser");
            }}
          >
            <Globe size={13} /> 打开浏览器
          </button>
        )}
        <button className="btn small" onClick={() => void loginDone(work.repo, tabId).catch(() => {})}>
          登录好了
        </button>
      </div>
    </div>
  );
}

function Plan({ entries }: { entries: { content: string; status: string }[] }) {
  const done = entries.filter((entry) => entry.status === "completed").length;
  return (
    <div className="plan-card">
      <div className="row muted small-text">
        <ListChecks size={14} /> 计划 {done}/{entries.length}
      </div>
      {entries.map((entry, index) => (
        <div key={index} className={`plan-entry ${entry.status}`}>
          {entry.status === "completed" ? (
            <CheckCircle2 size={13} className="ok-text" />
          ) : entry.status === "in_progress" ? (
            <Loader2 size={13} className="spin" />
          ) : (
            <Circle size={13} className="faint" />
          )}
          <span>{entry.content}</span>
        </div>
      ))}
    </div>
  );
}

/** The running turn, as the CLI shows it while it works. */
export interface TurnProgress {
  /** What the AI is doing ("思考中", "运行命令"…). */
  state: string;
  startedAt: number;
  /** Roughly how many tokens it has written so far. */
  tokens: number;
  context?: { used?: number; size?: number } | null;
  /** When the model last sent anything, heartbeats included, while the AI waits on it (not on a tool or the user). */
  heard?: number;
}

/** No data from the model for this long: the connection may have stalled. */
const SILENT_MS = 30000;

/** "心跳 2 秒前", or how long nothing has come once that looks like a stall. */
function Heartbeat({ age }: { age: number }) {
  return age < SILENT_MS ? (
    <span className="turn-meta" title="AI 服务上次发来数据的时间，包括保持连接的心跳。模型思考时不显示内容，但连接正常时每隔一两秒就会收到心跳">
      心跳 {formatDuration(age)}前
    </span>
  ) : (
    <span className="turn-meta turn-silent" title="这么久没有收到 AI 服务的任何数据，连心跳也没有，连接可能卡住了；可以停止后重发这条消息">
      已 {formatDuration(age)}没有收到数据
    </span>
  );
}

function useNow(interval: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

/** "思考中… · 1 分 12 秒 · ↓ 约 3.4k tokens" and the context in use, ticking every second. */
function TurnStatus({ progress }: { progress: TurnProgress }) {
  const now = useNow(1000);
  const { used, size } = progress.context ?? {};
  return (
    <div className="turn-status">
      <span className="dots">
        <i />
        <i />
        <i />
      </span>
      <span className="turn-state">{progress.state}…</span>
      <span className="turn-meta">{formatDuration(now - progress.startedAt)}</span>
      {progress.heard !== undefined && <Heartbeat age={now - progress.heard} />}
      {progress.tokens >= 10 && (
        <span className="turn-meta" title="按 AI 已写出的文字估算；Claude 的回复结束后显示准确数字">
          ↓ 约 {formatTokens(progress.tokens)} tokens
        </span>
      )}
      {used != null && size ? (
        <span className="turn-context">
          上下文 {formatTokens(used)} / {formatTokens(size)}
        </span>
      ) : null}
    </div>
  );
}

/**
 * What a finished turn took: its time, the tokens it wrote (Claude counts them for the whole
 * turn; Codex only for its last request, so not shown) and its cost.
 */
function turnStats(end: TurnEnd, agent?: string) {
  const usage = agent === "claude" ? end.usage : null;
  const cost = end.cost && end.cost.amount > 0 ? end.cost : null;
  const parts = [
    end.startedAt !== undefined ? `用时 ${formatDuration(end.at - end.startedAt)}` : "",
    usage?.outputTokens ? `输出 ${formatTokens(usage.outputTokens)} tokens` : "",
    cost ? formatCost(cost) : "",
  ].filter(Boolean);
  if (!parts.length) return null;
  const detail = [
    usage
      ? [
          usage.inputTokens != null ? `输入 ${formatTokens(usage.inputTokens)}` : "",
          usage.cachedReadTokens ? `缓存读取 ${formatTokens(usage.cachedReadTokens)}` : "",
          usage.cachedWriteTokens ? `缓存写入 ${formatTokens(usage.cachedWriteTokens)}` : "",
          usage.outputTokens != null ? `输出 ${formatTokens(usage.outputTokens)}（含思考）` : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "",
    end.resumed ? "这一轮开始前 AI 进程重新启动过，对话从记录中恢复" : "",
    end.changed?.length ? `这一轮开始前切换了：${end.changed.join("、")}` : "",
    cost ? "费用由 Claude 按 API 价格计算，用订阅账号时只作参考" : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className="turn-stats" title={detail || undefined}>
      {parts.join(" · ")}
    </span>
  );
}

export function TurnBlocks({
  items,
  running,
  progress,
  agent,
  onRespond,
  onLoadTool,
  footer,
}: {
  items: Block[];
  running: boolean;
  /** For the turn the AI is working on. */
  progress?: TurnProgress | null;
  /** "claude" or "codex": whose figures the turn ends carry. */
  agent?: string;
  onRespond: (id: string, optionId?: string) => void;
  onLoadTool?: LoadTool;
  /** Actions shown under a finished reply. */
  footer?: React.ReactNode;
}) {
  let end: TurnEnd | undefined;
  for (const block of items) if (block.kind === "turn_end") end = block;
  const stats = end && turnStats(end, agent);
  return (
    <div className="assistant">
      <div className="msg-head">
        <span className="avatar ai">
          <Sparkles size={12} />
        </span>
        <strong>AI</strong>
      </div>
      {items.map((block, index) => {
        switch (block.kind) {
          case "text":
            return <Markdown key={index} text={block.text} />;
          case "thought":
            return <Thought key={index} text={block.text} />;
          case "tool":
            return /frame__browser_login|frame[.:]browser_login/.test(block.title) ? (
              <Fragment key={block.id}>
                <ToolCard tool={block} load={onLoadTool} />
                <LoginRequest tool={block} />
              </Fragment>
            ) : (
              <ToolCard key={block.id} tool={block} load={onLoadTool} />
            );
          case "plan":
            return <Plan key={index} entries={block.entries} />;
          case "permission":
            return <Permission key={block.id} block={block} onRespond={onRespond} />;
          case "error":
            return (
              <div key={index} className="chat-error">
                <AlertTriangle size={14} /> <span>{block.message}</span>
              </div>
            );
          case "notice":
            return (
              <div key={index} className="chat-notice">
                <Info size={13} /> {block.message}
              </div>
            );
          case "goal":
            return <GoalLine key={index} block={block} />;
          case "turn_end":
            return block.stopReason === "cancelled" ? (
              <div key={index} className="chat-notice">
                已停止
              </div>
            ) : block.stopReason !== "end_turn" ? (
              <div key={index} className="chat-notice">
                结束：{block.stopReason}
              </div>
            ) : null;
          default:
            return null;
        }
      })}
      {running && progress && <TurnStatus progress={progress} />}
      {!running && (stats || footer) && (
        <div className="turn-footer">
          {stats}
          {footer}
        </div>
      )}
    </div>
  );
}
