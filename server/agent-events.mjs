/** Normalize public CLI events; never expose raw auth/config or private reasoning. */
export function agentEvent(value) {
  if (!value || typeof value !== "object") return null;
  if (
    value.type === "thread.started" ||
    (value.type === "system" && value.session_id)
  )
    return { type: "session", id: value.thread_id || value.session_id };
  if (value.type === "error" || value.type === "turn.failed")
    return {
      type: "error",
      text: String(
        value.message || value.error?.message || "AI 执行失败",
      ).slice(0, 12000),
    };
  if (value.type === "turn.completed")
    return { type: "usage", usage: value.usage };
  if (value.type === "result")
    return {
      type: value.is_error ? "error" : "summary",
      text: String(value.result || "").slice(0, 40000),
      usage: value.usage,
      cost: value.total_cost_usd,
    };
  if (value.type === "assistant") {
    const blocks = value.message?.content || [];
    const text = blocks
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("\n");
    if (text)
      return {
        type: "message",
        id: value.message?.id,
        text: text.slice(0, 40000),
      };
    const tool = blocks.find((x) => x.type === "tool_use");
    if (tool)
      return {
        type: "activity",
        id: tool.id,
        tool: tool.name,
        phase: "running",
        text: String(
          tool.input?.description ||
            tool.input?.file_path ||
            tool.input?.command ||
            tool.name,
        ).slice(0, 3000),
      };
  }
  if (value.type === "user") {
    const result = value.message?.content?.find(
      (x) => x.type === "tool_result",
    );
    if (result)
      return {
        type: "activity",
        id: result.tool_use_id,
        tool: "result",
        phase: "done",
        text: result.is_error ? "工具返回错误" : "工具执行完成",
        output: (typeof result.content === "string"
          ? result.content
          : (result.content || [])
              .filter((x) => x.type === "text")
              .map((x) => x.text)
              .join("\n")
        ).slice(-4000),
      };
  }
  if (
    value.type === "stream_event" &&
    value.event?.type === "content_block_delta" &&
    value.event.delta?.type === "text_delta"
  )
    return { type: "delta", text: value.event.delta.text };
  const item = value.item;
  if (
    item &&
    ["item.started", "item.updated", "item.completed"].includes(value.type)
  ) {
    if (item.type === "agent_message")
      return {
        type: "message",
        id: item.id,
        text: String(item.text || "").slice(0, 40000),
      };
    if (item.type === "reasoning")
      return {
        type: "activity",
        id: item.id,
        tool: "thinking",
        phase: value.type === "item.completed" ? "done" : "running",
        text: "正在构思与检查作品",
      };
    return {
      type: "activity",
      id: item.id,
      tool: item.type,
      phase: value.type === "item.completed" ? "done" : "running",
      text: String(
        item.command ||
          item.tool ||
          item.changes?.map((x) => x.path).join(", ") ||
          item.type,
      ).slice(0, 3000),
      output: String(item.aggregated_output || "").slice(-4000),
      exitCode: item.exit_code,
    };
  }
  return null;
}
