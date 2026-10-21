import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { AiManager } from "../server/ai/manager.mjs";

describe("turn figures", () => {
  let app, ai, work;
  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-turns-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    ai = app.services.ai;
    work = await app.services.works.create({ title: "费用" });
  });
  afterAll(() => app.close());

  /** A session whose agent answers each message with `reports` (Claude's cost totals so far). */
  function session(agent, spent, profile = `${agent}-account`) {
    const id = "turns-" + Math.random().toString(36).slice(2);
    const meta = { id, work: work.id, repo: "local", profile, profileName: agent, agent, model: "", title: "费用", createdAt: "", updatedAt: "", status: "idle", queue: [], choices: {}, acpSessionId: "acp-" + id, spent };
    const usage = (amount) => ({ sessionUpdate: "usage_update", used: 1000, size: 200000, ...(amount === undefined ? {} : { cost: { amount, currency: "USD" } }) });
    const state = { meta, process: null, attached: true };
    state.process = {
      agent,
      connection: {
        prompt: async () => {
          const [last, ...earlier] = [...state.reports].reverse();
          for (const amount of earlier.reverse()) ai.onUpdate({ sessionId: meta.acpSessionId, update: usage(amount) });
          // The connection hands the notification that comes with the answer over a few ticks later than the answer.
          void Promise.resolve()
            .then(() => null)
            .then(() => null)
            .then(() => ai.onUpdate({ sessionId: meta.acpSessionId, update: usage(last) }));
          return { stopReason: "end_turn", usage: { outputTokens: 120 } };
        },
      },
    };
    ai.sessions.set(id, state);
    return {
      state,
      /** One turn; its turn_end. */
      async turn(...reports) {
        state.reports = reports;
        await ai.runTurn(state, { id: "m" + Math.random(), text: "改一下", attachments: [], view: null });
        return ai.transcript(id).at(-1);
      },
      /** A report while no turn runs (a background task finishing). */
      report: (amount) => ai.onUpdate({ sessionId: meta.acpSessionId, update: usage(amount) }),
    };
  }

  it("charges each turn what Claude's total grew by while it ran", async () => {
    const chat = session("claude", 0);
    expect(await chat.turn(0.3)).toMatchObject({ kind: "turn_end", usage: { outputTokens: 120 }, cost: { amount: 0.3, currency: "USD" } });
    // Two results in one turn (a steered message), the second as the answer comes.
    expect((await chat.turn(0.32, 0.5)).cost.amount).toBeCloseTo(0.2);
    chat.report(0.55);
    expect((await chat.turn(0.6)).cost.amount).toBeCloseTo(0.05);
    expect(chat.state.meta.spent).toBe(0.6);
  });
  it("leaves the cost out when the total cannot be compared", async () => {
    // A resumed conversation whose total was never seen.
    const resumed = session("claude", undefined);
    expect(await resumed.turn(5)).not.toHaveProperty("cost");
    expect((await resumed.turn(5.4)).cost.amount).toBeCloseTo(0.4);
    // A total that went down was not carried over to the resumed session.
    const reset = session("claude", 2);
    expect(await reset.turn(0.1)).not.toHaveProperty("cost");
    expect((await reset.turn(0.3)).cost.amount).toBeCloseTo(0.2);
    // Codex reports no cost.
    expect(await session("codex", undefined).turn(undefined)).not.toHaveProperty("cost");
  });
  it("says what happened before a turn that can make the agent send the conversation again", async () => {
    const chat = session("claude", 0);
    const option = (id, name, currentValue, values) => ({ id, name, category: id, type: "select", currentValue, options: values.map((value) => ({ value, name: value })) });
    chat.state.meta.configOptions = [option("effort", "Effort", "high", ["high", "max"]), option("mode", "Mode", "default", ["default", "plan"])];
    chat.state.process.connection.setSessionConfigOption = async () => ({});
    await ai.setConfig(chat.state.meta.id, "effort", "max");
    await ai.setConfig(chat.state.meta.id, "mode", "plan"); // the permission mode does not change what is sent
    await ai.setConfig(chat.state.meta.id, "effort", "max"); // nor does picking what is already chosen
    chat.state.resumed = true; // as connect() marks a conversation the agent picked up from its record
    expect(await chat.turn(0.1)).toMatchObject({ kind: "turn_end", resumed: true, changed: ["思考强度"] });
    const next = await chat.turn(0.2);
    expect(next).not.toHaveProperty("resumed");
    expect(next).not.toHaveProperty("changed");
  });
  it("does not take a conversation's file snapshot for a conversation", () => {
    fs.writeFileSync(path.join(ai.sessionsDir, "snapshot-only.files.json"), JSON.stringify({ "scene.ts": "10:1" }));
    const fresh = new AiManager(app.services);
    try {
      expect([...fresh.sessions.keys()]).not.toContain(undefined);
      expect(() => fresh.list()).not.toThrow();
    } finally {
      clearInterval(fresh.timer);
      clearInterval(fresh.pulse);
    }
  });
  it("leaves out what Claude makes of another vendor's prices", async () => {
    const glm = ai.profiles.save({ kind: "anthropic", name: "GLM", baseUrl: "https://open.bigmodel.cn/api/anthropic", models: ["glm-4.6"], apiKey: "k" });
    expect(await session("claude", 0, glm.id).turn(0.3)).not.toHaveProperty("cost");
    const anthropic = ai.profiles.save({ kind: "anthropic", name: "Anthropic API", models: [], apiKey: "k" });
    expect((await session("claude", 0, anthropic.id).turn(0.3)).cost.amount).toBe(0.3);
  });
});
