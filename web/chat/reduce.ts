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
  /** The terminal output went past OUTPUT_LIMIT; the rest is not kept. */
  outputCut?: boolean;
  exitCode?: number | null;
  /** Long texts were cut short in the conversation: the whole call is asked for when shown. */
  cut?: boolean;
}
/** Tokens of a turn as the agent reports them: Claude for the whole turn, Codex for its last request. */
export interface Usage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
}
export interface TurnEnd {
  kind: "turn_end";
  stopReason: string;
  usage?: Usage | null;
  /** What the turn cost, when the agent tells (Claude). */
  cost?: { amount: number; currency: string };
  /** When the turn's message was sent (undefined if it is not in the transcript) and when the turn ended. */
  startedAt?: number;
  at: number;
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
  | TurnEnd
  | { kind: "error"; message: string }
  | { kind: "notice"; message: string }
  /** Where a branch starts: what came before is the parent conversation's first `keep` turns. */
  | { kind: "branch"; from: string; title: string; keep: number };

export interface Entry {
  at: number;
  kind: string;
  [key: string]: unknown;
}

/** Terminal output kept for a card: enough for any command's, short of freezing the page. */
export const OUTPUT_LIMIT = 200_000;

function terminalMeta(tool: ToolBlock, meta: unknown) {
  const { terminal_output_delta: delta, terminal_exit: exit } = (meta ?? {}) as {
    terminal_output_delta?: { data?: string };
    terminal_exit?: { exit_code?: number | null };
  };
  if (delta?.data && !tool.outputCut) {
    const output = (tool.output ?? "") + delta.data;
    tool.output = output.slice(0, OUTPUT_LIMIT);
    if (output.length > OUTPUT_LIMIT) tool.outputCut = true;
  }
  if (exit) tool.exitCode = exit.exit_code ?? null;
}

/** How much of a long tool text a card shows until it is expanded. */
const SHOWN_TEXT = 4000;

/**
 * A long text as a card shows it at first: its beginning (ending at a line end when one is
 * near) and the rest; null when it is shown whole.
 */
export function textHead(text: string) {
  if (text.length <= SHOWN_TEXT) return null;
  const end = text.lastIndexOf("\n", SHOWN_TEXT);
  const head = text.slice(0, end > SHOWN_TEXT / 2 ? end : SHOWN_TEXT);
  return { head, rest: text.slice(head.length).replace(/^\n/, "") };
}

/** "254 行（19,456 字）", or "19,456 字" for text on one line. */
export function textAmount(text: string) {
  let lines = 1;
  for (let at = text.indexOf("\n"); at >= 0 && at < text.length - 1; at = text.indexOf("\n", at + 1)) lines++;
  const chars = text.length.toLocaleString("zh-CN");
  return lines > 1 ? `${lines.toLocaleString("zh-CN")} 行（${chars} 字）` : `${chars} 字`;
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
  /** When the turn being read started: at a message of the user's own (steered ones join a turn). */
  private turnStart?: number;

  private replace<T extends Block>(at: number, change: (block: T) => T) {
    this.blocks[at] = change(this.blocks[at] as T);
  }

  add(entry: Entry) {
    const blocks = this.blocks;
    switch (entry.kind) {
      case "user":
        if (!entry.steered) this.turnStart = entry.at;
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
          if (entry.cut) tool.cut = true;
          const at = this.index.get("tool:" + tool.id);
          if (at !== undefined)
            this.replace<ToolBlock>(at, (existing) => {
              const next = { ...existing, ...tool, cut: existing.cut || tool.cut };
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
            if (entry.cut) tool.cut = true;
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
        blocks.push({
          kind: "turn_end",
          stopReason: entry.stopReason as string,
          usage: entry.usage as Usage | null,
          cost: entry.cost as TurnEnd["cost"],
          startedAt: this.turnStart,
          at: entry.at,
        });
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

/**
 * The turn the AI is working on: what it has done since the user's message (messages steered
 * into the turn belong to it) and when that was sent. Null when the last turn has ended: the
 * next message is on its way.
 */
export function runningTurn(turns: Turn[]): { startedAt: number; items: Block[] } | null {
  const last = turns.at(-1)?.items.at(-1);
  if (last?.kind === "turn_end" || last?.kind === "error") return null;
  const items: Block[] = [];
  for (let index = turns.length - 1; index >= 0 && !turns[index].branch; index--) {
    const turn = turns[index];
    items.unshift(...turn.items);
    if (turn.user && !turn.user.steered) return { startedAt: turn.user.at, items };
  }
  return null;
}

/** Roughly how many tokens a text takes: one per CJK character, one per four other characters. */
export function estimateTokens(text: string) {
  let wide = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 0x2e80) wide++;
  return wide + (text.length - wide) / 4;
}

const written = new WeakMap<Block, number>();
/**
 * Roughly how many tokens the AI wrote in these blocks (replies, thoughts, tool inputs), for
 * while a turn runs: the agents count tokens only when a request is done. Blocks are never
 * changed in place, so each one is measured once.
 */
export function writtenTokens(items: Block[]) {
  let sum = 0;
  for (const block of items) {
    let tokens = written.get(block);
    if (tokens === undefined) {
      if (block.kind === "text" || block.kind === "thought") tokens = estimateTokens(block.text);
      else if (block.kind === "tool") tokens = block.rawInput === undefined ? 0 : estimateTokens(JSON.stringify(block.rawInput));
      else if (block.kind === "plan") tokens = estimateTokens(block.entries.map((entry) => entry.content).join("\n"));
      else tokens = 0;
      written.set(block, tokens);
    }
    sum += tokens;
  }
  return Math.round(sum);
}

/** "980", "23.1k", "197k", "1.2M". */
export function formatTokens(value: number) {
  const [scaled, unit] = value >= 1e6 ? [value / 1e6, "M"] : value >= 1000 ? [value / 1000, "k"] : [value, ""];
  return (unit ? scaled.toFixed(scaled >= 100 ? 0 : 1).replace(/\.0$/, "") : String(Math.round(scaled))) + unit;
}

/** "8 秒", "2 分 5 秒", "1 小时 3 分". */
export function formatDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分 ${total % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** "$0.42", "<$0.01"; another currency with its code. */
export function formatCost({ amount, currency }: { amount: number; currency: string }) {
  if (currency !== "USD") return `${amount.toFixed(2)} ${currency}`;
  return amount < 0.01 ? "<$0.01" : `$${amount.toFixed(2)}`;
}
