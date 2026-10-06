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
    expect(context.body.data.experience).toMatchObject({ library: "知识类视频", files: ["README.md", "开场.md"] });

    // New documents show up in the diff of unsaved changes as fully added.
    expect((await call(`${lib}/diff?file=${encodeURIComponent("知识类视频/开场.md")}`)).body.diff).toContain("+- 前 2 秒给出问题");
    const status = await call(`${lib}/status`);
    expect(status.body.files.map((file) => file.path).sort()).toEqual(["知识类视频/README.md", "知识类视频/开场.md"]);
    expect((await call(`${lib}/commit`, { method: "POST", body: { message: "开场经验" } })).body.commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await call(`${lib}/history`)).body.map((version) => version.message)).toEqual(["开场经验", "创建经验库"]);
    expect((await call(`${lib}/diff?commit=HEAD`)).body.diff).toContain("+- 前 2 秒给出问题");
    expect((await call(`${lib}/libraries`)).body).toEqual([{ id: "知识类视频", title: "知识类视频", files: 2 }]);
  });
});
