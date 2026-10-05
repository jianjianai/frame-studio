/** Turn the stored ACP event log into display blocks. */
export interface ContentBlock {
  type: string;
  text?: string;
  uri?: string;
  data?: string;
  mimeType?: string;
  name?: string;
  resource?: { uri?: string; text?: string };
}
export interface ToolContent {
  type: "content" | "diff" | "terminal";
  content?: ContentBlock;
  path?: string;
  oldText?: string | null;
  newText?: string;
  terminalId?: string;
}
export interface ToolBlock {
  kind: "tool";
  id: string;
  title: string;
  toolKind?: string;
  status?: string;
  content: ToolContent[];
  locations?: { path: string; line?: number }[];
  rawInput?: unknown;
  rawOutput?: unknown;
}
export type Block =
  | { kind: "user"; id: string; text: string; attachments: Record<string, unknown>[]; at: number; steered?: boolean }
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | ToolBlock
  | { kind: "plan"; entries: { content: string; status: string; priority?: string }[] }
  | {
      kind: "permission";
      id: string;
      toolCall: { title?: string; kind?: string; rawInput?: unknown; content?: ToolContent[] };
      options: { optionId: string; name: string; kind: string }[];
      outcome?: { outcome: { outcome: string; optionId?: string } };
    }
  | { kind: "turn_end"; stopReason: string; usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } | null }
  | { kind: "error"; message: string }
  | { kind: "notice"; message: string };

export interface Entry {
  at: number;
  kind: string;
  [key: string]: unknown;
}

export function reduceTranscript(entries: Entry[]): Block[] {
  const blocks: Block[] = [];
  const tools = new Map<string, ToolBlock>();
  const permissions = new Map<string, Extract<Block, { kind: "permission" }>>();
  for (const entry of entries) {
    switch (entry.kind) {
      case "user":
        blocks.push({
          kind: "user",
          id: entry.id as string,
          text: entry.text as string,
          attachments: (entry.attachments as Record<string, unknown>[]) ?? [],
          at: entry.at,
          steered: Boolean(entry.steered),
        });
        break;
      case "update": {
        const update = entry.update as Record<string, unknown> & { sessionUpdate: string };
        const last = blocks.at(-1);
        if (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") {
          const content = update.content as ContentBlock;
          const kind = update.sessionUpdate === "agent_message_chunk" ? "text" : "thought";
          if (content?.type !== "text" || !content.text) break;
          if (last?.kind === kind) (last as { text: string }).text += content.text;
          else blocks.push({ kind, text: content.text });
        } else if (update.sessionUpdate === "tool_call") {
          const tool: ToolBlock = {
            kind: "tool",
            id: update.toolCallId as string,
            title: (update.title as string) || "工具",
            toolKind: update.kind as string,
            status: (update.status as string) || "pending",
            content: (update.content as ToolContent[]) ?? [],
            locations: update.locations as ToolBlock["locations"],
            rawInput: update.rawInput,
          };
          const existing = tools.get(tool.id);
          if (existing) Object.assign(existing, tool);
          else {
            tools.set(tool.id, tool);
            blocks.push(tool);
          }
        } else if (update.sessionUpdate === "tool_call_update") {
          const tool = tools.get(update.toolCallId as string);
          if (!tool) break;
          if (update.title) tool.title = update.title as string;
          if (update.status) tool.status = update.status as string;
          if (update.kind) tool.toolKind = update.kind as string;
          if (update.content) tool.content = update.content as ToolContent[];
          if (update.locations) tool.locations = update.locations as ToolBlock["locations"];
          if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
          if (update.rawOutput !== undefined) tool.rawOutput = update.rawOutput;
        } else if (update.sessionUpdate === "plan") {
          const entries = (update.entries as { content: string; status: string; priority?: string }[]) ?? [];
          if (last?.kind === "plan") last.entries = entries;
          else blocks.push({ kind: "plan", entries });
        }
        break;
      }
      case "permission": {
        const block = { kind: "permission" as const, id: entry.id as string, toolCall: entry.toolCall as never, options: entry.options as never };
        permissions.set(block.id, block);
        blocks.push(block);
        break;
      }
      case "permission_result": {
        const block = permissions.get(entry.id as string);
        if (block) block.outcome = entry.outcome as never;
        break;
      }
      case "turn_end":
        blocks.push({ kind: "turn_end", stopReason: entry.stopReason as string, usage: entry.usage as never });
        break;
      case "error":
        blocks.push({ kind: "error", message: entry.message as string });
        break;
      case "notice":
        blocks.push({ kind: "notice", message: entry.message as string });
        break;
    }
  }
  return blocks;
}

/** Group blocks into turns: a user message followed by the agent's response. */
export function groupTurns(blocks: Block[]) {
  const turns: { user?: Extract<Block, { kind: "user" }>; items: Block[] }[] = [];
  for (const block of blocks) {
    if (block.kind === "user") turns.push({ user: block, items: [] });
    else {
      if (!turns.length) turns.push({ items: [] });
      turns.at(-1)!.items.push(block);
    }
  }
  return turns;
}
