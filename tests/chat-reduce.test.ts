import { describe, expect, it } from "vitest";
import { reduceTranscript, groupTurns, TranscriptReducer } from "../web/chat/reduce";
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
  it("does not store Claude's own copy of tool results", () => {
    const stored = withoutAgentCopy({ sessionUpdate: "tool_call_update", _meta: { claudeCode: { toolResponse: "big" } } });
    expect(stored._meta).toBeUndefined();
  });
  it("compacts stored chunks on the server", () => {
    expect(compact(entries as never).filter((entry) => entry.kind === "update")).toHaveLength(4);
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
