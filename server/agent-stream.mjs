import {
  publicAgentText as text,
  publicAgentData as data,
  publicToolOutput as output,
  parseAgentDiff,
} from "./agent-public-data.mjs";

const phase = (status, fallback = "running") =>
  ({
    in_progress: "running",
    inProgress: "running",
    running: "running",
    completed: "completed",
    done: "completed",
    succeeded: "completed",
    failed: "failed",
    declined: "cancelled",
    interrupted: "cancelled",
    cancelled: "cancelled",
  })[status] || fallback;
const toolCategory = (name = "") =>
  /read|view_image|imageView/i.test(name)
    ? "read"
    : /search|grep|glob|fetch/i.test(name)
      ? "search"
      : /agent|task|collab/i.test(name)
        ? "agent"
        : "tool";
const toolTitle = (name) =>
  ({
    Read: "读取文件",
    Grep: "搜索内容",
    Glob: "查找文件",
    WebSearch: "搜索资料",
    WebFetch: "读取网页",
    Task: "子代理",
    Agent: "子代理",
    AskUserQuestion: "向你确认",
    frame_ask_user: "向你确认",
  })[name] || name;
/** Stateful protocol adapter. One input can produce MANY ordered public items.
 * Private/raw reasoning, signatures, provider envelopes and auth are deliberately absent.
 */
export function createAgentStream({ now = Date.now } = {}) {
  const started = new Map(),
    blocks = new Map(),
    messages = new Map(),
    tools = new Map();
  let serial = 0,
    lastMessage = "",
    session = "";
  const item = (id, kind, fields = {}) => {
    id = String(id || `event-${++serial}`).slice(0, 200);
    const at = now();
    if (!started.has(id)) started.set(id, at);
    return {
      type: "agent-item",
      version: 1,
      id,
      kind,
      at,
      ...fields,
      ...(fields.phase &&
      fields.phase !== "running" &&
      fields.phase !== "waiting" &&
      fields.durationMs === undefined
        ? { durationMs: Math.max(0, at - started.get(id)) }
        : {}),
    };
  };
  const toolItem = (tool, done = false, parentId) => {
    const name = tool.name || tool.tool || tool.type || "工具";
    const input = tool.input || tool.arguments || {};
    const base = {
      phase: done ? "completed" : "running",
      title: text(toolTitle(name), { limit: 120 }),
      toolName: text(name, { limit: 200 }),
      input: data(input),
      ...(parentId ? { parentId } : {}),
    };
    tools.set(tool.id, { ...base, name, input });
    if (
      ["Bash", "PowerShell", "exec_command", "shell_command", "shell"].includes(
        name,
      )
    )
      return item(tool.id, "command", {
        ...base,
        title: text(input.description || "执行命令", { limit: 200 }),
        command: text(
          Array.isArray(input.command)
            ? input.command.join(" ")
            : input.command || input.cmd || "",
          { limit: 12000 },
        ),
        cwd: text(input.cwd || input.workdir || "", { limit: 1000 }),
      });
    if (name === "TodoWrite")
      return item(tool.id, "plan", {
        ...base,
        title: "工作计划",
        steps: (input.todos || [])
          .slice(0, 30)
          .map((s, i) => ({
            id: String(i),
            text: text(s.content || s.step || "", { limit: 500 }),
            status: phase(s.status, "pending"),
          })),
      });
    if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name))
      return item(tool.id, "files", {
        ...base,
        title: name === "Write" ? "写入文件" : "修改文件",
        files: [
          {
            path: text(input.file_path || input.notebook_path || "文件", {
              limit: 1000,
            }),
            kind: name === "Write" ? "write" : "modify",
            proposed: true,
          },
        ],
      });
    return item(tool.id, "tool", { ...base, category: toolCategory(name) });
  };
  const codexItem = (i, eventPhase) => {
    const id = i.id;
    const state = phase(i.status, eventPhase);
    const parentId = i.parentId || i.parent_tool_use_id;
    const common = { phase: state, ...(parentId ? { parentId } : {}) };
    if (["agentMessage", "agent_message", "plan"].includes(i.type)) {
      if (i.text) lastMessage = i.text;
      return item(id, "message", {
        ...common,
        ...(typeof i.text === "string" ? { text: text(i.text) } : {}),
        ...(i.phase ? { channel: i.phase } : {}),
      });
    }
    if (i.type === "reasoning") {
      const summary = Array.isArray(i.summary)
        ? i.summary
            .map((s) => (typeof s === "string" ? s : s.text || ""))
            .join("\n\n")
        : "";
      return item(id, "thinking", {
        ...common,
        title: "思考摘要",
        ...(summary ? { text: text(summary) } : {}),
        publicSummary: true,
      });
    }
    if (["commandExecution", "command_execution"].includes(i.type)) {
      const exitCode = i.exitCode ?? i.exit_code;
      const full = i.aggregatedOutput ?? i.aggregated_output;
      return item(id, "command", {
        ...common,
        title: "执行命令",
        command: text(i.command, { limit: 12000 }),
        cwd: text(i.cwd || "", { limit: 1000 }),
        ...(full != null
          ? {
              output: output(full),
              outputTruncated: String(full).length > 32000,
              outputBytes: Buffer.byteLength(String(full)),
            }
          : {}),
        ...(Number.isInteger(exitCode)
          ? { exitCode, ...(exitCode !== 0 ? { phase: "failed" } : {}) }
          : {}),
        ...(Number.isFinite(i.durationMs) ? { durationMs: i.durationMs } : {}),
      });
    }
    if (["fileChange", "file_change"].includes(i.type)) {
      let remaining = 192000;
      return item(id, "files", {
        ...common,
        title: "修改文件",
        files: (i.changes || []).slice(0, 100).map((f) => {
          const diff = text(f.diff || "", {
            limit: Math.min(64000, Math.max(0, remaining)),
          });
          remaining -= Buffer.byteLength(diff);
          return {
            path: text(f.path, { limit: 1000 }),
            kind:
              typeof f.kind === "string" ? f.kind : f.kind?.type || "modify",
            diff,
            truncated: String(f.diff || "").length > diff.length,
          };
        }),
      });
    }
    if (
      [
        "mcpToolCall",
        "mcp_tool_call",
        "dynamicToolCall",
        "collabAgentToolCall",
        "collabToolCall",
      ].includes(i.type)
    ) {
      return item(id, "tool", {
        ...common,
        category: /collab/i.test(i.type) ? "agent" : "tool",
        title: text(
          [i.server, toolTitle(i.tool)].filter(Boolean).join(" / ") ||
            "工具调用",
          { limit: 200 },
        ),
        toolName: text(i.tool || i.type, { limit: 200 }),
        input: data(i.arguments),
        ...(i.result != null || i.contentItems != null
          ? { output: output(i.result ?? i.contentItems) }
          : {}),
        ...(i.error || i.success === false
          ? {
              phase: "failed",
              error: text(i.error?.message || i.error || "工具执行失败", {
                limit: 8000,
              }),
            }
          : {}),
        ...(Number.isFinite(i.durationMs) ? { durationMs: i.durationMs } : {}),
      });
    }
    if (["webSearch", "web_search"].includes(i.type))
      return item(id, "tool", {
        ...common,
        category: "search",
        title: "搜索资料",
        toolName: "web_search",
        input: data(i.action || { query: i.query }),
      });
    if (["todo_list", "todoList"].includes(i.type))
      return item(id, "plan", {
        ...common,
        title: "工作计划",
        steps: (i.items || [])
          .slice(0, 30)
          .map((s, n) => ({
            id: String(n),
            text: text(s.text || s.step, { limit: 500 }),
            status: s.completed ? "completed" : phase(s.status, "pending"),
          })),
      });
    if (["contextCompaction", "context_compaction"].includes(i.type))
      return item(id, "notice", {
        ...common,
        title: "整理对话上下文",
        text:
          state === "completed"
            ? "上下文已整理，继续当前工作。"
            : "正在整理较长的对话上下文。",
      });
    return item(id, "tool", {
      ...common,
      category: toolCategory(i.type),
      title: text(i.type || "工具活动", { limit: 200 }),
      input: data(i.path ? { path: i.path } : undefined),
    });
  };
  const feed = (value) => {
    if (!value || typeof value !== "object") return [];
    const p = value.params || {};
    if (["userMessage", "user_message"].includes((p.item || value.item)?.type))
      return [];
    if (value.method) {
      if (["thread/started"].includes(value.method)) {
        session = p.thread?.id || session;
        return session ? [{ type: "session", id: session }] : [];
      }
      if (["item/started", "item/completed"].includes(value.method) && p.item)
        return [
          codexItem(
            p.item,
            value.method === "item/completed" ? "completed" : "running",
          ),
        ];
      if (value.method === "item/agentMessage/delta")
        return [
          item(p.itemId, "message", { phase: "running", delta: text(p.delta) }),
        ];
      if (value.method === "item/reasoning/summaryTextDelta")
        return [
          item(p.itemId, "thinking", {
            phase: "running",
            title: "思考摘要",
            delta: text(p.delta),
            summaryIndex: p.summaryIndex || 0,
            publicSummary: true,
          }),
        ];
      // NEVER forward item/reasoning/textDelta (raw/private reasoning).
      if (value.method === "item/commandExecution/outputDelta")
        return [
          item(p.itemId, "command", {
            phase: "running",
            outputDelta: text(p.delta, { limit: 32000, tail: true }),
            outputBytes: Buffer.byteLength(String(p.delta || "")),
          }),
        ];
      if (value.method === "turn/plan/updated")
        return [
          item(`plan:${p.turnId}`, "plan", {
            phase: "running",
            title: "工作计划",
            text: text(p.explanation || "", { limit: 4000 }),
            steps: (p.plan || [])
              .slice(0, 30)
              .map((s, n) => ({
                id: String(n),
                text: text(s.step, { limit: 500 }),
                status: phase(s.status, "pending"),
              })),
          }),
        ];
      if (value.method === "turn/diff/updated")
        return [
          item(`changes:${p.turnId}`, "files", {
            phase: "completed",
            title: "本轮文件变更",
            cumulative: true,
            files: parseAgentDiff(text(p.diff, { limit: 256000 })),
            truncated: String(p.diff || "").length > 256000,
          }),
        ];
      if (value.method === "thread/tokenUsage/updated")
        return [
          {
            type: "usage",
            usage: data(
              p.tokenUsage?.last || p.tokenUsage?.total || p.tokenUsage,
            ),
            contextWindow: p.tokenUsage?.modelContextWindow,
          },
        ];
      if (value.method === "error")
        return [
          item(`error:${p.turnId || ++serial}`, "notice", {
            phase: p.willRetry ? "running" : "failed",
            title: p.willRetry ? "正在重试连接" : "执行出错",
            text: text(p.error?.message || p.message || "模型执行失败", {
              limit: 12000,
            }),
          }),
        ];
      return [];
    }
    if (
      value.type === "thread.started" ||
      (value.type === "system" && value.subtype === "init" && value.session_id)
    ) {
      session = value.thread_id || value.session_id;
      return [{ type: "session", id: session }];
    }
    if (
      value.item &&
      ["item.started", "item.updated", "item.completed"].includes(value.type)
    )
      return [
        codexItem(
          value.item,
          value.type === "item.completed" ? "completed" : "running",
        ),
      ];
    if (value.type === "turn.completed")
      return [{ type: "usage", usage: data(value.usage) }];
    if (value.type === "error" || value.type === "turn.failed")
      return [
        item(`error:${++serial}`, "notice", {
          phase: "failed",
          title: "执行出错",
          text: text(value.message || value.error?.message || "模型执行失败", {
            limit: 12000,
          }),
        }),
      ];
    const parentId = value.parent_tool_use_id || "";
    if (value.type === "stream_event") {
      const e = value.event || {};
      if (e.type === "message_start") {
        messages.set(parentId, e.message?.id || `message-${++serial}`);
        return [];
      }
      const messageId =
        messages.get(parentId) || `stream-${parentId || "main"}`;
      const key = `${messageId}:${e.index ?? 0}`;
      if (e.type === "content_block_start") {
        const b = e.content_block || {};
        blocks.set(key, { ...b, messageId, index: e.index, partial: "" });
        if (b.type === "text")
          return [
            item(key, "message", {
              phase: "running",
              text: text(b.text),
              ...(parentId ? { parentId } : {}),
            }),
          ];
        if (b.type === "thinking")
          return [
            item(key, "thinking", {
              phase: "running",
              title: "思考摘要",
              text: text(b.thinking),
              publicSummary: true,
              ...(parentId ? { parentId } : {}),
            }),
          ];
        if (b.type === "tool_use") return [toolItem(b, false, parentId)];
      }
      const b = blocks.get(key);
      if (e.type === "content_block_delta" && b) {
        if (e.delta?.type === "text_delta")
          return [
            item(key, "message", {
              phase: "running",
              delta: text(e.delta.text),
            }),
          ];
        if (e.delta?.type === "thinking_delta" && b.type === "thinking")
          return [
            item(key, "thinking", {
              phase: "running",
              title: "思考摘要",
              delta: text(e.delta.thinking),
              publicSummary: true,
            }),
          ];
        if (e.delta?.type === "input_json_delta")
          b.partial = (b.partial + e.delta.partial_json).slice(0, 128000);
      }
      if (e.type === "content_block_stop" && b) {
        if (["text", "thinking"].includes(b.type))
          return [
            item(key, b.type === "text" ? "message" : "thinking", {
              phase: "completed",
            }),
          ];
        if (b.type === "tool_use" && b.partial) {
          try {
            b.input = JSON.parse(b.partial);
            return [toolItem(b, false, parentId)];
          } catch {
            /* The authoritative assistant snapshot may still complete it. */
          }
        }
      }
      return [];
    }
    if (value.type === "assistant") {
      const result = [],
        messageId =
          value.message?.id || messages.get(parentId) || `message-${++serial}`;
      for (const [index, b] of (value.message?.content || []).entries()) {
        const id = `${messageId}:${index}`;
        if (b.type === "text") {
          lastMessage = b.text;
          result.push(
            item(id, "message", {
              phase: "completed",
              text: text(b.text),
              ...(parentId ? { parentId } : {}),
            }),
          );
        } else if (b.type === "thinking")
          result.push(
            item(id, "thinking", {
              phase: "completed",
              title: "思考摘要",
              text: text(b.thinking),
              publicSummary: true,
              ...(parentId ? { parentId } : {}),
            }),
          );
        else if (b.type === "tool_use")
          result.push(toolItem(b, false, parentId));
      }
      return result;
    }
    if (value.type === "user" && Array.isArray(value.message?.content)) {
      const result = [];
      for (const b of value.message.content) {
        if (b.type !== "tool_result") continue;
        const previous = tools.get(b.tool_use_id),
          name = previous?.name || "工具";
        const kind = ["Bash", "PowerShell"].includes(name)
          ? "command"
          : ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(name)
            ? "files"
            : name === "TodoWrite"
              ? "plan"
              : "tool";
        result.push(
          item(b.tool_use_id, kind, {
            phase: b.is_error ? "failed" : "completed",
            output: output(b.content),
            ...(b.is_error ? { error: "工具执行失败" } : {}),
            ...(typeof value.tool_use_result?.exitCode === "number"
              ? { exitCode: value.tool_use_result.exitCode }
              : {}),
          }),
        );
      }
      return result;
    }
    if (value.type === "tool_progress")
      return [
        item(
          value.tool_use_id,
          ["Bash", "PowerShell"].includes(value.tool_name) ? "command" : "tool",
          {
            phase: "running",
            title: text(value.tool_name, { limit: 200 }),
            ...(Number.isFinite(value.elapsed_time_seconds)
              ? { durationMs: value.elapsed_time_seconds * 1000 }
              : {}),
          },
        ),
      ];
    if (
      value.type === "system" &&
      ["compact_boundary", "status"].includes(value.subtype) &&
      (value.subtype === "compact_boundary" || value.status === "compacting")
    )
      return [
        item("context-compaction", "notice", {
          phase: value.subtype === "compact_boundary" ? "completed" : "running",
          title: "整理对话上下文",
          text:
            value.subtype === "compact_boundary"
              ? "上下文已整理。"
              : "正在整理较长的对话。",
        }),
      ];
    if (value.type === "result") {
      const result = [
        {
          type: "usage",
          usage: data(value.usage),
          ...(Number.isFinite(value.total_cost_usd)
            ? { cost: value.total_cost_usd }
            : {}),
        },
      ];
      if (value.is_error)
        result.push(
          item(`error:${++serial}`, "notice", {
            phase: "failed",
            title: "执行出错",
            text: text(
              value.result || value.errors?.join("\n") || "模型执行失败",
              { limit: 12000 },
            ),
          }),
        );
      else if (
        value.result &&
        value.result.trim() !== String(lastMessage).trim()
      )
        result.push(
          item(`${session || "agent"}:result`, "message", {
            phase: "completed",
            text: text(value.result),
          }),
        );
      return result;
    }
    return [];
  };
  return { feed };
}
