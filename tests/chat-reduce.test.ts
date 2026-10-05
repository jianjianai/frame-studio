import { describe, expect, it } from "vitest";
import { reduceTranscript, groupTurns } from "../web/chat/reduce";
import { lineDiff, compactDiff } from "../web/chat/lineDiff";
import { compact } from "../server/ai/manager.mjs";

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
