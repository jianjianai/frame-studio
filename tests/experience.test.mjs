import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";

describe("experience libraries", () => {
  let app, base;
  const call = async (route, { method = "GET", body } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const tool = (name, args) => call(`/api/tools/${name}`, { method: "POST", body: args });
  const lib = "/api/repos/local/experience";

  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-experience-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
  });
  afterAll(() => app.close());

  it("links a library to a work and lets the AI read, write and version it", async () => {
    const created = await call(`${lib}/libraries`, { method: "POST", body: { name: "知识类视频" } });
    expect(created.body).toEqual({ id: "知识类视频", title: "知识类视频" });
    expect((await call(`${lib}/libraries`, { method: "POST", body: { name: "知识类视频" } })).status).toBe(409);

    const work = (await call("/api/works", { method: "POST", body: { title: "科普短片" } })).body;
    expect((await tool("experience_read", { work: work.id })).body.error.code).toBe("NO_EXPERIENCE");
    expect((await call(`/api/works/local/${work.id}`, { method: "PATCH", body: { experience: "知识类视频" } })).status).toBe(200);

    const overview = await tool("experience_read", { work: work.id });
    expect(overview.body.text).toContain("经验库「知识类视频」");
    expect(overview.body.text).toContain("## 用户偏好");

    const written = await tool("experience_write", { work: work.id, path: "开场.md", content: "# 开场\n\n- 前 3 秒给出问题\n" });
    expect(written.status).toBe(200);
    const edited = await tool("experience_edit", { work: work.id, path: "开场.md", edits: [{ oldText: "前 3 秒", newText: "前 2 秒" }] });
    expect(edited.body.text).toContain("1 处");
    expect((await tool("experience_read", { work: work.id, path: "开场.md" })).body.text).toContain("前 2 秒给出问题");
    expect((await tool("experience_read", { work: work.id, path: "../README.md" })).status).toBe(400);
    expect((await tool("experience_write", { work: work.id, path: "x.js", content: "" })).status).toBe(400);

    const context = await tool("work_context", { work: work.id });
    // Callers without a chat session (external MCP clients) get the README and the index here.
    expect(context.body.data.experience.library).toBe("知识类视频");
    expect(context.body.data.experience.documents.map((doc) => doc.path)).toEqual(["README.md", "开场.md"]);
    expect(context.body.data.experience.readme).toContain("## 用户偏好");
    expect(context.body.data.notes).toContain("# 科普短片");

    // New documents show up in the diff of unsaved changes as fully added.
    expect((await call(`${lib}/diff?file=${encodeURIComponent("知识类视频/开场.md")}`)).body.diff).toContain("+- 前 2 秒给出问题");
    const status = await call(`${lib}/status`);
    expect(status.body.files.map((file) => file.path).sort()).toEqual(["知识类视频/README.md", "知识类视频/开场.md"]);
    expect((await call(`${lib}/commit`, { method: "POST", body: { message: "开场经验" } })).body.commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await call(`${lib}/history`)).body.map((version) => version.message)).toEqual(["开场经验", "创建经验库"]);
    expect((await call(`${lib}/diff?commit=HEAD`)).body.diff).toContain("+- 前 2 秒给出问题");
    expect((await call(`${lib}/libraries`)).body).toEqual([{ id: "知识类视频", title: "知识类视频", files: 2 }]);

    // The session brief carries the work's notes and the whole (small) library.
    const opened = await app.services.openWork(work.id, "local");
    const brief = fs.readFileSync(path.join(opened.root, "AGENTS.md"), "utf8");
    expect(brief).toContain(`## 本作品的需求与约定（projects/${opened.slug}/AGENTS.md）`);
    expect(brief).toContain("## 经验库「知识类视频」");
    expect(brief).toContain("前 2 秒给出问题");
    expect(fs.readFileSync(path.join(opened.root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });

  it("tells a chat session only what changed since it last knew", async () => {
    const { ai, works, auth } = app.services;
    const created = (await call("/api/works", { method: "POST", body: { title: "音乐短片" } })).body;
    await call(`/api/works/local/${created.id}`, { method: "PATCH", body: { experience: "知识类视频" } });
    const work = await app.services.openWork(created.id, "local");
    const { snapshotFiles } = await import("../server/ai/context.mjs");
    const session = { meta: { id: "test-session", work: work.id, repo: "local", queue: [], context: { experience: works.writeBrief(work).experience } }, files: snapshotFiles(work.dir) };
    ai.sessions.set(session.meta.id, session);
    const view = { time: 1, playing: false, selection: { kind: "layer", id: "title" }, editing: "scene.ts" };
    const context = () => ai.turnPrompt(session, { text: "继续", attachments: [], view }, work).at(-1).text;

    let text = context();
    expect(text).toContain("用户在时间轴上选中了：图层 title「标题」");
    expect(text).toContain("用户在编辑器中打开着：scene.ts");
    expect(text).not.toContain("经验库");
    expect(text).not.toContain("改动了作品文件");
    // A pasted image goes to the AI as an image, not as a frame of the work.
    const pasted = ai.turnPrompt(session, { text: "参考这张图", attachments: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], view: null }, work);
    expect(pasted.find((block) => block.type === "image")).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
    expect(pasted.at(-2).text).toContain("1 张图片（用户直接发给你的");
    expect(pasted.at(-2).text).not.toContain("画面 0:");

    // The user edits an experience document and a work file between turns.
    const doc = (await call(`${lib}/file?path=${encodeURIComponent("知识类视频/开场.md")}`)).body;
    await call(`${lib}/file`, { method: "PUT", body: { path: "知识类视频/开场.md", content: "# 开场\n\n- 前 1 秒给出问题\n", expectedHash: doc.hash } });
    const scene = (await call(`/api/works/local/${work.id}/file?path=scene.ts`)).body;
    await call(`/api/works/local/${work.id}/file`, { method: "PUT", body: { path: "scene.ts", content: scene.content + "\n// 用户修改\n", expectedHash: scene.hash } });
    text = context();
    expect(text).toContain("### 开场.md（已更新，最新内容）");
    expect(text).toContain("前 1 秒给出问题");
    expect(text).toContain("修改 scene.ts");
    expect(context()).not.toContain("开场.md");
    // Mid-turn (steering), changed files are mostly the AI's own: not reported as the user's.
    fs.appendFileSync(path.join(work.dir, "scene.ts"), "// AI 正在改\n");
    expect(ai.turnPrompt(session, { text: "顺便", attachments: [], view }, work, { steering: true }).at(-1).text).not.toContain("改动了作品文件");

    // What the AI writes itself (through MCP, with its session token) is not reported back.
    const token = auth.issueInternal({ work: work.id, repo: "local", session: session.meta.id });
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "experience_write", arguments: { path: "开场.md", content: "# 开场\n\n- 前 3 秒给出问题\n" } } }),
    });
    expect(await response.text()).toContain("已写入经验库");
    expect(context()).not.toContain("经验库");

    // A bound session's tools have no work parameter, and a stray one is ignored.
    const mcp = async (method, params) => {
      const reply = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + token },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
      });
      return JSON.parse((await reply.text()).split("\n").find((line) => line.startsWith("data: ")).slice(6)).result;
    };
    const listed = await mcp("tools/list", {});
    expect(listed.tools.some((tool) => "work" in (tool.inputSchema.properties ?? {}))).toBe(false);
    expect(listed.tools.find((tool) => tool.name === "experience_read")._meta).toEqual({ "anthropic/alwaysLoad": true });
    expect(listed.tools.find((tool) => tool.name === "file_write")._meta).toBeUndefined();
    const stray = await mcp("tools/call", { name: "experience_read", arguments: { work: "work-" + work.id, path: "开场.md" } });
    expect(stray.isError).toBeFalsy();
    expect(stray.content[0].text).toContain("前 3 秒给出问题");

    // In a mode that confirms changes, FRAME's own tools wait for the user too; reads never do.
    session.meta.configOptions = [{ id: "mode", currentValue: "default" }];
    const answer = async (optionId) => {
      for (let tries = 0; tries < 100; tries++) {
        const pending = [...ai.permissions].find(([, item]) => item.session === session.meta.id);
        if (pending) return ai.respondPermission(pending[0], optionId);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("no permission request");
    };
    const write = (content) => mcp("tools/call", { name: "experience_write", arguments: { path: "开场.md", content } });
    let [result] = await Promise.all([write("# 开场\n\n- 被拒绝\n"), answer("reject")]);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("用户没有允许这次修改");
    expect((await mcp("tools/call", { name: "experience_read", arguments: { path: "开场.md" } })).content[0].text).toContain("前 3 秒给出问题");
    [result] = await Promise.all([write("# 开场\n\n- 允许了\n"), answer("allow")]);
    expect(result.content[0].text).toContain("已写入经验库");
    session.meta.configOptions = [{ id: "mode", currentValue: "acceptEdits" }];
    expect((await write("# 开场\n\n- 不用确认\n")).content[0].text).toContain("已写入经验库");
    ai.sessions.delete(session.meta.id);
  });
});
