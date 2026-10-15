import { describe, expect, it } from "vitest";
import {
  reduceTranscript,
  groupTurns,
  TranscriptReducer,
  textHead,
  textAmount,
  runningTurn,
  writtenTokens,
  formatTokens,
  formatDuration,
  formatCost,
  OUTPUT_LIMIT,
  type ToolBlock,
} from "../web/chat/reduce";
import { lineDiff, compactDiff } from "../web/chat/lineDiff";
import { compact, lean, withoutAgentCopy } from "../server/ai/manager.mjs";

const update = (sessionUpdate: string, extra: Record<string, unknown>) => ({ at: 0, kind: "update", update: { sessionUpdate, ...extra } });

describe("chat transcript", () => {
  const entries = [
    { at: 0, kind: "user", id: "u1", text: "做个标题", attachments: [] },
    update("agent_thought_chunk", { content: { type: "text", text: "想" } }),
    update("agent_thought_chunk", { content: { type: "text", text: "一下" } }),
    update("tool_call", { toolCallId: "t1", title: "mcp__frame__preview_frames", kind: "other", status: "pending" }),
    update("tool_call_update", { toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] }),
    update("agent_message_chunk", { content: { type: "text", text: "好了" } }),
    update("agent_message_chunk", { content: { type: "text", text: "。" } }),
    { at: 0, kind: "turn_end", stopReason: "end_turn" },
  ];
  it("merges chunks and tool updates into blocks", () => {
    const blocks = reduceTranscript(entries);
    expect(blocks.map((block) => block.kind)).toEqual(["user", "thought", "tool", "text", "turn_end"]);
    expect(blocks[1]).toMatchObject({ text: "想一下" });
    expect(blocks[2]).toMatchObject({ status: "completed", content: [{ type: "content" }] });
    expect(groupTurns(blocks)).toHaveLength(1);
  });
  it("keeps unchanged blocks and turns when entries are appended", () => {
    const reducer = new TranscriptReducer();
    for (const entry of entries) reducer.add(entry);
    const before = groupTurns(reducer.blocks);
    const tool = reducer.blocks[2];
    reducer.add({ at: 0, kind: "user", id: "u2", text: "再改", attachments: [] });
    reducer.add(update("agent_message_chunk", { content: { type: "text", text: "好" } }));
    const after = groupTurns(reducer.blocks, before);
    expect(after[0]).toBe(before[0]);
    expect(reducer.blocks[2]).toBe(tool);
    reducer.add(update("tool_call_update", { toolCallId: "t1", status: "failed" }));
    expect(reducer.blocks[2]).not.toBe(tool);
    expect(groupTurns(reducer.blocks, after)[0]).not.toBe(after[0]);
  });
  it("shows Codex terminal output and MCP results", () => {
    const blocks = reduceTranscript([
      update("tool_call", { toolCallId: "x", title: "ls", kind: "execute", content: [{ type: "terminal", terminalId: "x" }] }),
      update("tool_call_update", { toolCallId: "x", _meta: { terminal_output_delta: { data: "a\n" } } }),
      update("tool_call_update", { toolCallId: "x", status: "completed", _meta: { terminal_output_delta: { data: "b\n" }, terminal_exit: { exit_code: 2 } } }),
    ]);
    expect(blocks[0]).toMatchObject({ output: "a\nb\n", exitCode: 2 });
  });
  it("marks a tool call whose texts the conversation cut short", () => {
    const short = lean(update("tool_call_update", { toolCallId: "y", status: "completed", rawOutput: "o".repeat(5000) }) as never) as Record<string, unknown>;
    expect(short.cut).toBe(true);
    expect(lean(update("tool_call", { toolCallId: "y", rawInput: { command: "ls" } }) as never)).not.toHaveProperty("cut");
    const blocks = reduceTranscript([
      update("tool_call", { toolCallId: "y", title: "rg", status: "in_progress" }),
      short as never,
      update("tool_call_update", { toolCallId: "y", status: "completed" }),
    ]);
    expect(blocks[0]).toMatchObject({ cut: true, status: "completed" });
  });
  it("shows the beginning of a long tool text and says how much is left out", () => {
    expect(textHead("短".repeat(4000))).toBeNull();
    // 300 lines of 39 characters: the card stops at the end of line 100.
    const text = Array.from({ length: 300 }, () => "x".repeat(39)).join("\n");
    const cut = textHead(text)!;
    expect(cut.head).toBe(text.slice(0, 3999));
    expect(cut.head + "\n" + cut.rest).toBe(text);
    expect(textAmount(cut.rest)).toBe("200 行（7,999 字）");
    // Text on one line is cut where the card fills up.
    expect(textHead("y".repeat(12345))!.rest).toHaveLength(8345);
    expect(textAmount("y".repeat(12345))).toBe("12,345 字");
  });
  it("keeps terminal output up to a limit and marks what it left out", () => {
    const delta = (data: string) => update("tool_call_update", { toolCallId: "t", _meta: { terminal_output_delta: { data } } });
    const big = "z".repeat(OUTPUT_LIMIT * 0.75);
    const [block] = reduceTranscript([update("tool_call", { toolCallId: "t", title: "cat", kind: "execute" }), delta(big), delta(big), delta("more")]) as ToolBlock[];
    expect(block.output).toHaveLength(OUTPUT_LIMIT);
    expect(block.outputCut).toBe(true);
  });
  it("does not store Claude's own copy of tool results", () => {
    const stored = withoutAgentCopy({ sessionUpdate: "tool_call_update", _meta: { claudeCode: { toolResponse: "big" } } });
    expect(stored._meta).toBeUndefined();
  });
  it("compacts stored chunks on the server", () => {
    expect(compact(entries as never).filter((entry) => entry.kind === "update")).toHaveLength(4);
  });
  it("times a turn from its message, steered messages included", () => {
    const blocks = reduceTranscript([
      { at: 1000, kind: "user", id: "u1", text: "做个标题", attachments: [] },
      update("agent_message_chunk", { content: { type: "text", text: "好" } }),
      { at: 5000, kind: "user", id: "u2", text: "顺便", attachments: [], steered: true },
      { at: 75000, kind: "turn_end", stopReason: "end_turn", usage: { outputTokens: 1200 }, cost: { amount: 0.42, currency: "USD" } },
    ]);
    expect(blocks.at(-1)).toEqual({
      kind: "turn_end",
      stopReason: "end_turn",
      usage: { outputTokens: 1200 },
      cost: { amount: 0.42, currency: "USD" },
      startedAt: 1000,
      at: 75000,
    });
  });
  it("finds the turn being worked on and estimates what the AI wrote", () => {
    const say = (id: string, at: number, steered = false) => ({ at, kind: "user", id, text: id, attachments: [], steered });
    const thought = update("agent_thought_chunk", { content: { type: "text", text: "a".repeat(400) } });
    const reply = update("agent_message_chunk", { content: { type: "text", text: "好的，标题做好了" } });
    const tool = update("tool_call", { toolCallId: "w", title: "Write", kind: "edit", status: "in_progress", rawInput: { content: "b".repeat(398) } });
    const turns = (list: unknown[]) => groupTurns(reduceTranscript(list as never));
    expect(runningTurn(turns([say("u1", 10), thought, { at: 20, kind: "turn_end", stopReason: "end_turn" }]))).toBeNull();
    expect(runningTurn(turns([say("u1", 10), { at: 20, kind: "error", message: "x" }]))).toBeNull();
    // Just sent: nothing written yet.
    expect(runningTurn(turns([say("u1", 10)]))).toEqual({ startedAt: 10, items: [] });
    const running = runningTurn(turns([say("u1", 10), thought, { at: 20, kind: "turn_end", stopReason: "end_turn" }, say("u2", 30), thought, say("u3", 40, true), tool, reply]))!;
    expect(running.startedAt).toBe(30);
    expect(running.items.map((block) => block.kind)).toEqual(["thought", "tool", "text"]);
    // 400 letters: 100; the tool input as JSON, 412 characters: 103; eight CJK characters: 8.
    expect(writtenTokens(running.items)).toBe(211);
  });
  it("formats token counts, durations and costs", () => {
    expect([980, 23_100, 23_000, 197_400, 1_000_000, 28_380_715].map(formatTokens)).toEqual(["980", "23.1k", "23k", "197k", "1M", "28.4M"]);
    expect([0, 8_900, 72_000, 125_000, 3_725_000].map(formatDuration)).toEqual(["0 秒", "8 秒", "1 分 12 秒", "2 分 5 秒", "1 小时 2 分"]);
    expect(formatCost({ amount: 1.2049, currency: "USD" })).toBe("$1.20");
    expect(formatCost({ amount: 0.0025, currency: "USD" })).toBe("<$0.01");
    expect(formatCost({ amount: 3, currency: "CNY" })).toBe("3.00 CNY");
  });
  it("diffs lines with context", () => {
    const lines = lineDiff("a\nb\nc\nd\ne\nf\ng", "a\nb\nC\nd\ne\nf\ng");
    expect(lines.filter((line) => line.type !== "same")).toEqual([
      { type: "del", text: "c" },
      { type: "add", text: "C" },
    ]);
    expect(compactDiff(lines, 1).some((line) => line.type === "gap")).toBe(true);
  });
});
