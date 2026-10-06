import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";

describe("conversation branches", () => {
  let app, ai, work;
  const attached = [];
  const prompts = [];
  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-branch-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    await app.listen();
    ai = app.services.ai;
    work = await app.services.works.create({ title: "分支" });
    // No agent here: record what would reach it.
    ai.attach = async (session) => {
      attached.push({ id: session.meta.id, forkFrom: session.forkFrom });
      session.attached = true;
    };
    ai.prompt = async (id, message) => prompts.push({ id, ...message });
  });
  afterAll(() => app.close());

  const image = "a".repeat(24) + ".png";
  function parentSession() {
    const id = "parent-" + Math.random().toString(36).slice(2);
    const meta = { id, work: work.id, repo: "local", profile: "claude-account", profileName: "Claude", agent: "claude", model: "", title: "原对话", createdAt: "", updatedAt: "", status: "idle", queue: [], choices: { model: "haiku" }, acpSessionId: "acp-1", usage: { used: 10, size: 100 } };
    const say = (text, extra = {}) => ({ at: 1, kind: "user", id: text, text, attachments: [], ...extra });
    const reply = (text, messageId) => ({ at: 1, kind: "update", update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } } });
    const entries = [
      say("第一条"),
      reply("好的", "msg_1"),
      { at: 1, kind: "turn_end", stopReason: "end_turn" },
      say("第二条", { attachments: [{ type: "image", kind: "image", mimeType: "image/png", uri: `/api/ai/sessions/${id}/images/${image}` }] }),
      say("顺便", { steered: true }),
      reply("看到了", "msg_2"),
      { at: 1, kind: "turn_end", stopReason: "end_turn" },
    ];
    fs.writeFileSync(path.join(ai.sessionsDir, id + ".jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    fs.mkdirSync(path.join(ai.sessionsDir, id + ".images"), { recursive: true });
    fs.writeFileSync(path.join(ai.sessionsDir, id + ".images", image), "PNGDATA");
    ai.sessions.set(id, { meta, process: null, attached: false });
    return id;
  }

  it("branches after a reply with the agent's context forked there", async () => {
    const parent = parentSession();
    const branch = await ai.fork(parent, { keep: 1 });
    expect(branch).toMatchObject({ title: "原对话", choices: { model: "haiku" }, branch: { from: parent, keep: 1, dropped: 1 } });
    expect(attached.at(-1)).toEqual({ id: branch.id, forkFrom: { sessionId: "acp-1", messageId: "msg_1" } });
    const transcript = ai.transcript(branch.id);
    expect(transcript.map((entry) => entry.kind)).toEqual(["user", "update", "turn_end", "branch"]);
    expect(transcript.at(-1)).toMatchObject({ from: parent, title: "原对话", keep: 1 });
    expect(prompts.some((item) => item.id === branch.id)).toBe(false);
  });

  it("edits a message: the branch keeps what came before and sends the new text with the old images", async () => {
    const parent = parentSession();
    const branch = await ai.fork(parent, { keep: 1, text: "第二条（改）", attachments: ai.transcript(parent)[3].attachments });
    expect(prompts.at(-1)).toMatchObject({ id: branch.id, text: "第二条（改）", attachments: [{ type: "image", mimeType: "image/png", data: Buffer.from("PNGDATA").toString("base64") }] });
  });

  it("copies the images a kept turn shows, and counts steered messages as part of their turn", async () => {
    const parent = parentSession();
    const branch = await ai.fork(parent, { keep: 2 });
    expect(attached.at(-1).forkFrom).toEqual({ sessionId: "acp-1", messageId: "msg_2" });
    const user = ai.transcript(branch.id).find((entry) => entry.text === "第二条");
    expect(user.attachments[0].uri).toBe(`/api/ai/sessions/${branch.id}/images/${image}`);
    expect(fs.readFileSync(path.join(ai.sessionsDir, branch.id + ".images", image), "utf8")).toBe("PNGDATA");
    expect(ai.get(branch.id).meta.usage).toEqual({ used: 10, size: 100 });
    await expect(ai.fork(parent, { keep: 3 })).rejects.toThrow(/无效的分支位置/);
  });

  it("starts a branch from the very beginning without forking", async () => {
    const parent = parentSession();
    const branch = await ai.fork(parent, { keep: 0, text: "重新开始" });
    expect(attached.at(-1).forkFrom).toBeNull();
    expect(ai.transcript(branch.id).map((entry) => entry.kind)).toEqual(["branch"]);
    expect(prompts.at(-1)).toMatchObject({ id: branch.id, text: "重新开始" });
  });

  it("tells the branch once that dropped turns may have changed files", () => {
    const parent = parentSession();
    const session = ai.get(parent);
    session.meta.branch = { from: "x", title: "x", keep: 1, dropped: 1 };
    const opened = app.services.works.describe("local", work.id);
    const first = ai.turnPrompt(session, { text: "继续", attachments: [], view: null }, opened).at(-1).text;
    expect(first).toContain("分支点之后那些轮次对作品文件做过的修改仍在文件里");
    expect(ai.turnPrompt(session, { text: "再继续", attachments: [], view: null }, opened).at(-1).text).not.toContain("分支点");
  });
});
