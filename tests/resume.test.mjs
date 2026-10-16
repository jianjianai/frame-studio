import { describe, expect, it } from "vitest";
import { AiManager } from "../server/ai/manager.mjs";

/** The manager's shutdown and restart on a stand-in: entries, saves and prompts are recorded. */
function harness(sessions) {
  const manager = Object.create(AiManager.prototype);
  const entries = [];
  const prompts = [];
  manager.sessions = new Map(sessions.map((session) => [session.meta.id, session]));
  manager.processes = new Map();
  manager.append = (session, entry) => entries.push({ session: session.meta.id, ...entry });
  manager.saveMeta = () => {};
  manager.prompt = async (id, { text }) => prompts.push({ id, text });
  return { manager, entries, prompts };
}

describe("a restart of the studio", () => {
  it("lets the turns it cut off go on afterwards, once", async () => {
    const running = { meta: { id: "a", status: "running" } };
    const idle = { meta: { id: "b", status: "idle" } };
    const { manager, entries } = harness([running, idle]);
    manager.close();
    expect(running.meta.interrupted).toBeTypeOf("number");
    expect(idle.meta.interrupted).toBeUndefined();
    expect(entries).toEqual([{ session: "a", kind: "notice", message: expect.stringContaining("重启后 AI 会自动接着做") }]);

    // The next studio: the cut-off conversation gets a message to go on; an old mark is dropped.
    const old = { meta: { id: "c", status: "idle", interrupted: Date.now() - 2 * 60 * 60 * 1000 } };
    const next = harness([{ meta: { ...running.meta, status: "idle" } }, { meta: { ...idle.meta } }, old]);
    next.manager.resumeInterrupted();
    expect(next.prompts).toEqual([{ id: "a", text: expect.stringContaining("从中断的地方接着做") }]);
    expect([...next.manager.sessions.values()].some((session) => session.meta.interrupted)).toBe(false);
    next.manager.resumeInterrupted();
    expect(next.prompts).toHaveLength(1);
  });
});
