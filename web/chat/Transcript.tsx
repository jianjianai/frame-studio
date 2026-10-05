import { useState } from "react";
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
} from "lucide-react";
import { formatTime } from "../lib/api";
import { Markdown } from "./Markdown";
import { lineDiff, compactDiff } from "./lineDiff";
import type { Block, ToolBlock, ToolContent } from "./reduce";

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
  storyboard: "分镜总览",
  preview_audio: "分析声音",
  files_list: "列出文件",
  file_read: "读取文件",
  file_write: "写入文件",
  file_edit: "编辑文件",
  file_delete: "删除文件",
  file_move: "移动文件",
  assets_list: "素材列表",
  asset_import: "导入素材",
  audio_place: "放置音频",
  layers_get: "读取图层",
  layers_edit: "编辑图层",
  audio_get: "读取混音",
  audio_edit: "编辑混音",
  speech_synthesize: "生成配音",
  speech_voices: "列出声音",
  versions_list: "版本历史",
  version_save: "保存版本",
  version_restore: "恢复版本",
  version_diff: "查看改动",
  export_video: "导出视频",
  task_status: "任务状态",
  work_update: "修改作品信息",
  library_list: "素材库",
  exports_list: "导出列表",
};
export function toolTitle(title: string) {
  const match = /(?:mcp__frame__|mcp\.frame\.|frame[.:])([a-z_]+)/.exec(title);
  if (match) return FRAME_TOOL_NAMES[match[1]] ?? match[1];
  return title;
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
    if (text.startsWith("```") || text.length < 2000) return <pre className="tool-text">{text.replace(/^```\w*\n?|```$/g, "")}</pre>;
    return <pre className="tool-text">{text.slice(0, 4000)}…</pre>;
  }
  if (content.type === "resource_link" || content.type === "resource")
    return <div className="faint small-text">{content.name || content.uri || content.resource?.uri}</div>;
  return null;
}

function ToolCard({ tool }: { tool: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const hasDiff = tool.content.some((item) => item.type === "diff");
  const images = tool.content.filter((item) => item.content?.type === "image");
  const title = toolTitle(tool.title);
  const input = tool.rawInput as Record<string, unknown> | undefined;
  const detail =
    input && typeof input === "object"
      ? input.path ||
        input.file_path ||
        input.command ||
        input.pattern ||
        (Array.isArray(input.times) ? (input.times as number[]).map((t) => formatTime(t)).join(", ") : "")
      : "";
  return (
    <div className={`tool-card status-${tool.status}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {kindIcon(tool.toolKind, tool.title)}
        <span className="tool-title ellipsis">{title}</span>
        {detail ? <span className="tool-detail ellipsis mono">{String(detail)}</span> : null}
        {images.length > 0 && <ImageIcon size={12} className="faint" />}
        <span className="grow" />
        <StatusIcon status={tool.status} />
      </button>
      {(open || (hasDiff && tool.status !== "failed")) && tool.content.length > 0 && (
        <div className="tool-body">
          {(open ? tool.content : tool.content.filter((item) => item.type === "diff")).map((item, index) => (
            <ContentView key={index} item={item} />
          ))}
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

export function TurnBlocks({ items, running, onRespond }: { items: Block[]; running: boolean; onRespond: (id: string, optionId?: string) => void }) {
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
            return <ToolCard key={block.id} tool={block} />;
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
      {running && (
        <div className="working">
          <span className="dots">
            <i />
            <i />
            <i />
          </span>
        </div>
      )}
    </div>
  );
}
