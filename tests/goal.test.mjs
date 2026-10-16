import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeGoalReader, goalCommand, goalOutput, hookCap } from "../server/ai/goal.mjs";
import { AiManager } from "../server/ai/manager.mjs";

/** The goal methods of the manager on a stand-in: entries and publishes are recorded. */
function harness(agent = "claude") {
  const entries = [];
  const manager = Object.create(AiManager.prototype);
  manager.append = (_session, entry) => entries.push(entry);
  manager.publish = () => {};
  const session = { meta: { agent, goal: null } };
  return { manager, session, entries };
}

describe("goal mode", () => {
  const before = { home: process.env.FRAME_AGENT_HOME, config: process.env.CLAUDE_CONFIG_DIR };
  let home;
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-goal-"));
    process.env.FRAME_AGENT_HOME = home;
    process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  });
  afterAll(() => {
    for (const [key, value] of [
      ["FRAME_AGENT_HOME", before.home],
      ["CLAUDE_CONFIG_DIR", before.config],
    ])
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });

  it("reads goal commands as the agents do", () => {
    expect(goalCommand("/goal 全片做完并核对过")).toEqual({ action: "set", objective: "全片做完并核对过" });
    expect(goalCommand("/goal\n第一行\n第二行")).toEqual({ action: "set", objective: "第一行\n第二行" });
    expect(goalCommand("/goal")).toEqual({ action: "status" });
    expect(goalCommand("/goal clear")).toEqual({ action: "clear" });
    expect(goalCommand("/goal Stop")).toEqual({ action: "clear" });
    expect(goalCommand("/goal pause")).toEqual({ action: "pause" });
    expect(goalCommand("/goals x")).toBeNull();
    expect(goalCommand("做个 /goal")).toBeNull();
    expect(goalOutput("Goal set: 甲乙丙")).toEqual({ type: "set", objective: "甲乙丙" });
    expect(goalOutput("Goal cleared: 甲乙丙")).toEqual({ type: "cleared", objective: "甲乙丙" });
    expect(goalOutput("No goal set. Usage: `/goal <condition>`")).toEqual({ type: "none" });
    expect(goalOutput("Goal active: 写完 (2 turns)\nLast check: 还差结尾")).toEqual({ type: "active", objective: "写完", checks: 2, reason: "还差结尾" });
    expect(goalOutput("Goal active: 写完（含片尾） (not yet evaluated)")).toEqual({ type: "active", objective: "写完（含片尾）", checks: 0, reason: null });
    expect(goalOutput("Goal achieved")).toBeNull();
    expect(hookCap("A hook blocked the turn from ending 9 consecutive times \u2014 overriding and ending turn. For Stop/SubagentStop hooks…")).toBe(9);
    expect(hookCap("Auto mode is unavailable")).toBeNull();
  });

  it("follows Claude's goal checks as its conversation file grows", () => {
    const id = "6c2f0b8e-0000-4000-8000-000000000001";
    // Before the file exists everything that comes is new.
    const early = new ClaudeGoalReader(id);
    const folder = path.join(home, ".claude", "projects", "-data-works-local-abc");
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, id + ".jsonl");
    const status = (attachment, timestamp = "2026-10-16T06:51:53.126Z") =>
      JSON.stringify({ type: "attachment", timestamp, attachment: { type: "goal_status", condition: "写出甲乙丙", ...attachment } }) + "\n";
    fs.writeFileSync(file, JSON.stringify({ type: "user", message: { content: "x" } }) + "\n" + status({ met: false, sentinel: true }));
    expect(early.read()).toEqual([{ type: "set", objective: "写出甲乙丙", at: Date.parse("2026-10-16T06:51:53.126Z") }]);
    // A reader made later starts at the end: what was there is old.
    const reader = new ClaudeGoalReader(id);
    expect(reader.read()).toEqual([]);
    const check = status({ met: false, reason: "只写了甲" });
    const met = status({ met: true, reason: "三个字都写了", iterations: 3, durationMs: 9900, tokens: 1234 });
    // Half a line waits for the rest.
    fs.appendFileSync(file, check + met.slice(0, 30));
    expect(reader.read().map((event) => [event.type, event.reason])).toEqual([["check", "只写了甲"]]);
    fs.appendFileSync(file, met.slice(30));
    expect(reader.read()).toMatchObject([{ type: "met", reason: "三个字都写了", iterations: 3, durationMs: 9900, tokens: 1234 }]);
    fs.appendFileSync(file, status({ met: false, failed: true, reason: "做不到" }) + status({ met: true, sentinel: true }));
    expect(reader.read().map((event) => event.type)).toEqual(["failed", "cleared"]);
  });

  it("turns Claude's goal events into the goal shown and the CLI's lines", () => {
    const { manager, session, entries } = harness();
    manager.applyGoal(session, { type: "set", objective: "写出甲乙丙", at: 1000 });
    manager.applyGoal(session, { type: "set", objective: "写出甲乙丙", at: 1100 }); // "Goal set" text and the file both tell
    expect(session.meta.goal).toEqual({ objective: "写出甲乙丙", status: "active", setAt: 1000, checks: 0 });
    manager.applyGoal(session, { type: "check", reason: "只写了甲", at: 2000 });
    manager.applyGoal(session, { type: "check", reason: "还差丙", at: 3000 });
    expect(session.meta.goal).toMatchObject({ checks: 2, lastReason: "还差丙", checkedAt: 3000 });
    manager.applyGoal(session, { type: "met", reason: "都写了", iterations: 3, durationMs: 9900, tokens: 1234, at: 4000 });
    expect(session.meta.goal).toBeNull();
    expect(entries).toEqual([
      { kind: "goal", event: "set", objective: "写出甲乙丙" },
      { kind: "goal", event: "check", objective: "写出甲乙丙", reason: "只写了甲", checks: 1 },
      { kind: "goal", event: "check", objective: "写出甲乙丙", reason: "还差丙", checks: 2 },
      { kind: "goal", event: "met", objective: "写出甲乙丙", reason: "都写了", iterations: 3, durationMs: 9900, tokens: 1234 },
    ]);
    // Cleared by the user's "/goal clear", or by the agent.
    manager.applyGoal(session, { type: "set", objective: "第二个" });
    session.goalClearing = true;
    manager.applyGoal(session, { type: "cleared" });
    expect(entries.at(-1)).toEqual({ kind: "goal", event: "cleared", objective: "第二个", byUser: true });
    expect(session.meta.goal).toBeNull();
    // A check with no goal named changes nothing.
    manager.applyGoal(session, { type: "check", reason: "?" });
    expect(entries).toHaveLength(6);
  });

  it("shows a goal set before the studio knew of it, from its first check or when asked", () => {
    const { manager, session, entries } = harness();
    manager.applyGoal(session, { type: "check", objective: "全片做完", reason: "还差第三幕", at: 5000 });
    expect(session.meta.goal).toMatchObject({ objective: "全片做完", status: "active", checks: 1, lastReason: "还差第三幕" });
    expect(entries.at(-1)).toEqual({ kind: "goal", event: "check", objective: "全片做完", reason: "还差第三幕", checks: 1 });
    // "/goal": what the agent says is the goal.
    manager.applyGoal(session, { type: "active", objective: "全片做完", checks: 4, reason: "还差片尾" });
    expect(session.meta.goal).toMatchObject({ objective: "全片做完", checks: 4, lastReason: "还差片尾", setAt: 5000 });
    expect(entries.at(-1)).toEqual({ kind: "goal", event: "status", objective: "全片做完", checks: 4, reason: "还差片尾" });
    manager.applyGoal(session, { type: "none" });
    expect(session.meta.goal).toBeNull();
    expect(entries.at(-1)).toEqual({ kind: "goal", event: "none" });
    manager.applyGoal(session, { type: "active", objective: "另一个", checks: 0, reason: null });
    expect(session.meta.goal).toMatchObject({ objective: "另一个", checks: 0 });
  });

  it("tells when Claude ended a turn at its limit of checks in a row; the goal stays", () => {
    const { manager, session, entries } = harness();
    manager.sessionByAcp = () => session;
    const notice = (text) =>
      manager.onUpdate({
        sessionId: "acp",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text }, _meta: { claudeCode: { kind: "informational", level: "warning" } } },
      });
    const cap =
      "**Warning:** A hook blocked the turn from ending 9 consecutive times \u2014 overriding and ending turn. For Stop/SubagentStop hooks, check stop_hook_active in the input and return success while it's true. Set CLAUDE_CODE_STOP_HOOK_BLOCK_CAP to raise this limit.";
    manager.applyGoal(session, { type: "set", objective: "写出一到十" });
    notice(cap);
    // Told after the last check, as the turn ends.
    expect(session.goalCapped).toBe(9);
    expect(entries).toHaveLength(1);
    manager.applyGoal(session, { type: "capped", count: session.goalCapped });
    expect(entries.at(-1)).toEqual({ kind: "goal", event: "capped", objective: "写出一到十", checks: 9 });
    expect(session.meta.goal).toMatchObject({ objective: "写出一到十", status: "active" });
    // Other notices are lines of their own, not words run on into the reply.
    notice("**Warning:** Auto mode is unavailable");
    expect(entries.at(-1)).toEqual({ kind: "notice", message: "Auto mode is unavailable" });
    // Without a goal the limit is a notice like any other.
    manager.applyGoal(session, { type: "cleared" });
    notice(cap);
    expect(entries.at(-1)).toMatchObject({ kind: "notice", message: expect.stringMatching(/^A hook blocked the turn/) });
  });

  it("follows Codex's goal as its adapter reports it", () => {
    const { manager, session, entries } = harness("codex");
    const snapshot = (status, extra = {}) => ({
      objective: "创建 a.txt",
      status,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 5000,
      ...extra,
    });
    manager.codexGoal(session, snapshot("active"));
    manager.codexGoal(session, snapshot("active", { tokensUsed: 900, timeUsedSeconds: 12 }));
    expect(session.meta.goal).toMatchObject({ objective: "创建 a.txt", status: "active", setAt: 5000, tokensUsed: 900, timeUsedSeconds: 12 });
    manager.codexGoal(session, snapshot("paused", { tokensUsed: 900 }));
    expect(session.meta.goal.status).toBe("paused");
    manager.codexGoal(session, snapshot("complete", { tokensUsed: 2000, timeUsedSeconds: 30 }));
    expect(session.meta.goal).toBeNull();
    expect(entries.map((entry) => entry.event)).toEqual(["set", "paused", "met"]);
    expect(entries.at(-1)).toMatchObject({ tokens: 2000, durationMs: 30000 });
    // Cleared: the adapter reports none.
    manager.codexGoal(session, snapshot("active"));
    manager.codexGoal(session, null);
    expect(entries.at(-1)).toMatchObject({ event: "cleared" });
    expect(session.meta.goal).toBeNull();
  });
});
