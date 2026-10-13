import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { unwrapToolResult } from "../server/ai/manager.mjs";

describe("conversation history", () => {
  let app, base, ai, work;
  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-history-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    ai = app.services.ai;
    work = await app.services.works.create({ title: "长对话" });
  });
  afterAll(() => app.close());

  const say = (text, extra = {}) => ({ at: 1, kind: "user", id: text, text, attachments: [], ...extra });
  const chunk = (text) => ({ at: 1, kind: "update", update: { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text } } });
  const tool = (id, output) => [
    {
      at: 1,
      kind: "update",
      update: { sessionUpdate: "tool_call", toolCallId: id, title: "rg", kind: "execute", status: "in_progress", rawInput: { command: "rg x" } },
    },
    {
      at: 1,
      kind: "update",
      update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { result: { content: [{ type: "text", text: output }] } } },
    },
  ];
  const end = { at: 1, kind: "turn_end", stopReason: "end_turn" };
  function session(entries, status = "idle") {
    const id = "history-" + Math.random().toString(36).slice(2);
    const meta = {
      id,
      work: work.id,
      repo: "local",
      profile: "codex-account",
      profileName: "Codex",
      agent: "codex",
      model: "",
      title: "长对话",
      createdAt: "",
      updatedAt: "",
      status,
      queue: [],
    };
    fs.writeFileSync(path.join(ai.sessionsDir, id + ".jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    ai.sessions.set(id, { meta, process: null, attached: false });
    return id;
  }
  const get = async (route) => (await fetch(base + route)).json();

  it("opens a long conversation at its latest turns and goes back a page at a time", async () => {
    const entries = [];
    for (let turn = 0; turn < 30; turn++) {
      entries.push(say(`第 ${turn} 轮`), chunk("好"), chunk("的"));
      if (turn === 25) entries.push(say("顺便", { steered: true }));
      entries.push(...tool(`call-${turn}`, "x".repeat(10000)), end);
    }
    const id = session(entries);
    const latest = await get(`/api/ai/sessions/${id}`);
    expect(latest).toMatchObject({ session: { id }, turn: 22, turns: 30, size: fs.statSync(path.join(ai.sessionsDir, id + ".jsonl")).size });
    const users = latest.transcript.filter((entry) => entry.kind === "user");
    expect(users.map((entry) => entry.text)).toEqual(["第 22 轮", "第 23 轮", "第 24 轮", "第 25 轮", "顺便", "第 26 轮", "第 27 轮", "第 28 轮", "第 29 轮"]);
    // Chunks merged; tool output cut short and marked.
    expect(latest.transcript[1].update.content.text).toBe("好的");
    const output = latest.transcript.find((entry) => entry.update?.sessionUpdate === "tool_call_update");
    expect(output.cut).toBe(true);
    expect(output.update.rawOutput.result.content[0].text.length).toBe(4000);
    expect(JSON.stringify(latest.transcript).length).toBeLessThan(80000);

    const earlier = await get(`/api/ai/sessions/${id}?before=22`);
    expect(earlier.turn).toBe(14);
    expect(earlier.transcript[0]).toMatchObject({ kind: "user", text: "第 14 轮" });
    expect(earlier.transcript.at(-1)).toMatchObject({ kind: "turn_end" });
    expect((await get(`/api/ai/sessions/${id}?before=3`)).turn).toBe(0);

    // The whole call when its card is opened.
    const whole = await get(`/api/ai/sessions/${id}/tools/call-27`);
    expect(whole.entries.map((entry) => entry.update.sessionUpdate)).toEqual(["tool_call", "tool_call_update"]);
    expect(whole.entries[1].update.rawOutput.result.content[0].text.length).toBe(10000);
    expect((await get(`/api/ai/sessions/${id}/tools/nope`)).entries).toEqual([]);
  });

  it("loads fewer turns when they are big, but at least one", async () => {
    const entries = [];
    for (let turn = 0; turn < 5; turn++) {
      entries.push(say(`大 ${turn}`));
      for (let call = 0; call < 110; call++) entries.push(...tool(`big-${turn}-${call}`, "y".repeat(3500)));
      entries.push(end);
    }
    const id = session(entries);
    const latest = await get(`/api/ai/sessions/${id}`);
    expect(latest.turns).toBe(5);
    expect(latest.turn).toBe(3);
    expect(latest.transcript.filter((entry) => entry.kind === "user").map((entry) => entry.text)).toEqual(["大 3", "大 4"]);
    expect((await get(`/api/ai/sessions/${id}?turns=1`)).turn).toBe(4);
    // A conversation without messages yet (a branch's divider only) is one page.
    const empty = session([{ at: 1, kind: "branch", from: "x", title: "t", keep: 0 }]);
    expect(await get(`/api/ai/sessions/${empty}`)).toMatchObject({ turn: 0, turns: 1, transcript: [{ kind: "branch" }] });
  });

  it("merges the chunks of the turn that ended, leaving the rest of the file as it was", () => {
    const before = [say("一"), chunk("a"), chunk("b"), end];
    const id = session(before);
    const file = path.join(ai.sessionsDir, id + ".jsonl");
    const start = fs.statSync(file).size;
    fs.appendFileSync(file, [say("二"), chunk("c"), chunk("d"), end].map((entry) => JSON.stringify(entry)).join("\n") + "\n" + "{broken\n");
    ai.compactFile(id, start);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    // The earlier turn is untouched (its chunks were for an earlier compaction to merge).
    expect(lines.slice(0, 4).map((line) => JSON.parse(line))).toEqual(before);
    expect(lines.slice(4).map((line) => JSON.parse(line).update?.content?.text ?? JSON.parse(line).kind)).toEqual(["user", "cd", "turn_end"]);
    // A line cut short by a crash does not stop the conversation from opening.
    fs.appendFileSync(file, "{also broken\n");
    expect(ai.transcript(id).map((entry) => entry.kind)).toEqual(["user", "update", "turn_end", "user", "update", "turn_end"]);
  });

  it("answers a message sent during a turn with the queue it joined", async () => {
    const id = session([say("一"), chunk("a")], "running");
    const response = await fetch(`${base}/api/ai/sessions/${id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "接着改", attachments: [{ type: "image", data: "a".repeat(400), mimeType: "image/png" }] }),
    });
    const body = await response.json();
    expect(body).toMatchObject({ queued: true, session: { id, status: "running", queue: [{ id: body.id, text: "接着改" }] } });
    // Queued pictures stay on the server until the message is sent.
    expect(JSON.stringify(body.session.queue)).not.toContain("aaaa");
    const removed = await (await fetch(`${base}/api/ai/sessions/${id}/queue/${body.id}`, { method: "DELETE" })).json();
    expect(removed.queue).toEqual([]);
  });

  it("keeps the pictures of a Codex tool result as files, not as a megabyte of text", () => {
    // Codex passes an MCP result on as one text: the JSON of the result, pictures in base64.
    const picture = "iVBORw0KGgo" + "A".repeat(3000);
    const wrapped = (toolCallId) => ({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      rawOutput: {
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                content: [
                  { type: "text", text: "840×1494" },
                  { type: "image", data: picture, mimeType: "image/png" },
                ],
              }),
            },
          ],
        },
        error: null,
      },
    });
    const id = session([say("看看画面"), ...tool("old", "").slice(0, 1), { at: 1, kind: "update", update: wrapped("old") }], "running");
    ai.append(ai.get(id), { kind: "update", update: unwrapToolResult(wrapped("new")) });
    const stored = JSON.parse(
      fs
        .readFileSync(path.join(ai.sessionsDir, id + ".jsonl"), "utf8")
        .trim()
        .split("\n")
        .at(-1),
    );
    const [caption, image] = stored.update.rawOutput.result.content;
    expect(caption).toEqual({ type: "text", text: "840×1494" });
    expect(image).toMatchObject({
      type: "image",
      mimeType: "image/png",
      uri: expect.stringMatching(new RegExp(`^/api/ai/sessions/${id}/images/[a-f0-9]{24}\\.png$`)),
    });
    expect(fs.existsSync(ai.imageFile(id, image.uri.split("/").at(-1)))).toBe(true);
    // Stored before: opened, the call shows its pictures too.
    const old = ai.toolCall(id, "old").at(-1).update.rawOutput.result.content;
    expect(old.map((item) => item.type)).toEqual(["text", "image"]);
    expect(old[1].data).toBe(picture);
    // Anything else stays as it is.
    const plain = { sessionUpdate: "tool_call_update", toolCallId: "x", rawOutput: { result: { content: [{ type: "text", text: '{"content":[oops' }] } } };
    expect(unwrapToolResult(plain)).toBe(plain);
  });

  it("says where each new entry ends in the file, and sends tool output cut short", () => {
    const id = session([say("一")], "running");
    const seen = [];
    const stop = app.services.events.subscribe((event) => event.type === "ai-event" && event.session === id && seen.push(event));
    ai.append(ai.get(id), tool("live", "z".repeat(9000))[1]);
    stop();
    expect(seen).toHaveLength(1);
    expect(seen[0].end).toBe(fs.statSync(path.join(ai.sessionsDir, id + ".jsonl")).size);
    expect(seen[0].entry.cut).toBe(true);
    expect(seen[0].entry.update.rawOutput.result.content[0].text).toHaveLength(4000);
    // The file keeps all of it.
    expect(ai.toolCall(id, "live")[0].update.rawOutput.result.content[0].text).toHaveLength(9000);
  });
});
