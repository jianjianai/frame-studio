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
  /** Streamed terminal output (Codex sends it in `_meta`, not as content). */
  output?: string;
  exitCode?: number | null;
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
  | { kind: "notice"; message: string }
  /** Where a branch starts: what came before is the parent conversation's first `keep` turns. */
  | { kind: "branch"; from: string; title: string; keep: number };

export interface Entry {
  at: number;
  kind: string;
  [key: string]: unknown;
}

const OUTPUT_LIMIT = 20000;

function terminalMeta(tool: ToolBlock, meta: unknown) {
  const { terminal_output_delta: delta, terminal_exit: exit } = (meta ?? {}) as {
    terminal_output_delta?: { data?: string };
    terminal_exit?: { exit_code?: number | null };
  };
  if (delta?.data && (tool.output?.length ?? 0) < OUTPUT_LIMIT) tool.output = ((tool.output ?? "") + delta.data).slice(0, OUTPUT_LIMIT);
  if (exit) tool.exitCode = exit.exit_code ?? null;
}

type PermissionBlock = Extract<Block, { kind: "permission" }>;

/**
 * Builds display blocks entry by entry. A changed block is replaced by a copy, never mutated,
 * so unchanged blocks (and the turns made of them) keep their identity and skip re-rendering
 * while a long conversation streams.
 */
export class TranscriptReducer {
  blocks: Block[] = [];
  private index = new Map<string, number>();

  private replace<T extends Block>(at: number, change: (block: T) => T) {
    this.blocks[at] = change(this.blocks[at] as T);
  }

  add(entry: Entry) {
    const blocks = this.blocks;
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
          if (last?.kind === kind) blocks[blocks.length - 1] = { kind, text: last.text + content.text };
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
          const at = this.index.get("tool:" + tool.id);
          if (at !== undefined)
            this.replace<ToolBlock>(at, (existing) => {
              const next = { ...existing, ...tool };
              terminalMeta(next, update._meta);
              return next;
            });
          else {
            terminalMeta(tool, update._meta);
            this.index.set("tool:" + tool.id, blocks.length);
            blocks.push(tool);
          }
        } else if (update.sessionUpdate === "tool_call_update") {
          const at = this.index.get("tool:" + (update.toolCallId as string));
          if (at === undefined) break;
          this.replace<ToolBlock>(at, (existing) => {
            const tool = { ...existing };
            if (update.title) tool.title = update.title as string;
            if (update.status) tool.status = update.status as string;
            if (update.kind) tool.toolKind = update.kind as string;
            if (update.content) tool.content = update.content as ToolContent[];
            if (update.locations) tool.locations = update.locations as ToolBlock["locations"];
            if (update.rawInput !== undefined) tool.rawInput = update.rawInput;
            if (update.rawOutput !== undefined) tool.rawOutput = update.rawOutput;
            terminalMeta(tool, update._meta);
            return tool;
          });
        } else if (update.sessionUpdate === "plan") {
          const entries = (update.entries as { content: string; status: string; priority?: string }[]) ?? [];
          if (last?.kind === "plan") blocks[blocks.length - 1] = { kind: "plan", entries };
          else blocks.push({ kind: "plan", entries });
        }
        break;
      }
      case "permission": {
        const block: PermissionBlock = { kind: "permission", id: entry.id as string, toolCall: entry.toolCall as never, options: entry.options as never };
        this.index.set("permission:" + block.id, blocks.length);
        blocks.push(block);
        break;
      }
      case "permission_result": {
        const at = this.index.get("permission:" + (entry.id as string));
        if (at !== undefined) this.replace<PermissionBlock>(at, (block) => ({ ...block, outcome: entry.outcome as never }));
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
      case "branch":
        blocks.push({ kind: "branch", from: entry.from as string, title: entry.title as string, keep: entry.keep as number });
        break;
    }
  }
}

export function reduceTranscript(entries: Entry[]): Block[] {
  const reducer = new TranscriptReducer();
  for (const entry of entries) reducer.add(entry);
  return reducer.blocks;
}

export type Turn = { user?: Extract<Block, { kind: "user" }>; branch?: Extract<Block, { kind: "branch" }>; items: Block[] };

/**
 * Group blocks into turns: a user message followed by the agent's response. A branch divider
 * stands alone. A turn whose blocks are unchanged since `previous` is returned as the same object.
 */
export function groupTurns(blocks: Block[], previous: Turn[] = []) {
  const turns: Turn[] = [];
  for (const block of blocks) {
    if (block.kind === "user") turns.push({ user: block, items: [] });
    else if (block.kind === "branch") turns.push({ branch: block, items: [] });
    else {
      if (!turns.length) turns.push({ items: [] });
      turns.at(-1)!.items.push(block);
    }
  }
  return turns.map((turn, index) => {
    const old = previous[index];
    return old &&
      old.user === turn.user &&
      old.branch === turn.branch &&
      old.items.length === turn.items.length &&
      old.items.every((item, i) => item === turn.items[i])
      ? old
      : turn;
  });
}
