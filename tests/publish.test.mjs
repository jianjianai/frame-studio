import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { git } from "../server/git.mjs";
import { removeProjectProperty, setProjectFields, readProjectSource } from "../server/project-meta.mjs";

describe("published works and copies", () => {
  let app, base, works;
  const call = async (route, { method = "GET", body } = {}) => {
    const response = await fetch(base + route, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-publish-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    works = app.services.works;
  });
  afterAll(() => app.close());

  it("adds and removes a project.ts field without disturbing the rest", () => {
    const code = `const project = {\n  title: "A",\n  tags: [],\n};\nexport default project;\n`;
    const added = setProjectFields(code, { publishedAt: "2026-10-06T00:00:00.000Z" });
    expect(readProjectSource(added).meta.publishedAt).toBe("2026-10-06T00:00:00.000Z");
    expect(removeProjectProperty(added, "publishedAt")).toBe(code);
    expect(removeProjectProperty(code, "missing")).toBe(code);
  });

  it("makes a published work view-only for the studio, tools and the AI", async () => {
    const work = await works.create({ title: "发布的作品" });
    const route = `/api/works/local/${work.id}`;
    fs.writeFileSync(path.join(work.dir, "notes.md"), "未保存");
    expect((await call(`${route}/publish`, { method: "POST" })).status).toBe(200);
    // Publishing saved everything as a version.
    expect((await git(work.root, ["log", "-1", "--format=%s"])).trim()).toBe("发布：发布的作品");
    expect((await works.status(work)).files).toEqual([]);
    expect((await works.list({ repo: "local" })).find((item) => item.id === work.id).publishedAt).toMatch(/^\d{4}-/);

    const refused = await call(`${route}/file`, { method: "PUT", body: { path: "scene.ts", content: "x", expectedHash: null } });
    expect(refused.status).toBe(423);
    expect(refused.body.error.message).toContain("已发布");
    expect((await call(route, { method: "PATCH", body: { title: "改名" } })).status).toBe(423);
    expect((await call(`${route}/layers`, { method: "POST", body: { operations: [] } })).status).toBe(423);
    expect((await call("/api/tools/subtitles_edit", { method: "POST", body: { work: work.id, set: [] } })).status).toBe(423);
    // Reading, checking and the experience library still work.
    expect((await call("/api/tools/work_context", { method: "POST", body: { work: work.id } })).status).toBe(200);
    await call("/api/repos/local/experience/libraries", { method: "POST", body: { name: "通用" } });
    expect((await call(`${route}/unpublish`, { method: "POST" })).status).toBe(200);
    expect((await call(route, { method: "PATCH", body: { experience: "通用" } })).status).toBe(200);
    expect((await call(`${route}/publish`, { method: "POST" })).status).toBe(200);
    const experience = await call("/api/tools/experience_write", { method: "POST", body: { work: work.id, path: "x.md", content: "# x\n" } });
    expect(experience.status).toBe(200);

    // The AI may not start working on it.
    const { ai } = app.services;
    const session = { meta: { id: "s-published", work: work.id, repo: "local", queue: [], status: "idle", commands: [] } };
    ai.sessions.set(session.meta.id, session);
    await expect(ai.prompt(session.meta.id, { text: "改一下标题" })).rejects.toThrow(/已发布/);
    ai.sessions.delete(session.meta.id);

    expect((await call(`${route}/unpublish`, { method: "POST" })).status).toBe(200);
    expect((await git(work.root, ["log", "-1", "--format=%s"])).trim()).toBe("取消发布");
    expect(fs.readFileSync(path.join(work.dir, "project.ts"), "utf8")).not.toContain("publishedAt");
    expect((await call(route, { method: "PATCH", body: { title: "改名" } })).status).toBe(200);
  });

  it("copies a work with its current files into a new, unpublished work", async () => {
    const source = await works.create({ title: "原作品" });
    fs.writeFileSync(path.join(source.dir, "public", "logo.svg"), "<svg/>");
    await works.commit(source, "logo");
    fs.writeFileSync(path.join(source.dir, "draft.md"), "还没保存");
    await works.setPublished(await works.open(source.id), true);

    const result = await call(`/api/works/local/${source.id}/duplicate`, { method: "POST", body: {} });
    expect(result.status).toBe(200);
    const copy = await works.open(result.body.id);
    expect(copy.id).not.toBe(source.id);
    expect(copy.slug).toBe(source.slug);
    expect(works.meta(copy).meta).toMatchObject({ title: "原作品（副本）" });
    expect(works.published(copy)).toBe("");
    expect(fs.readFileSync(path.join(copy.dir, "public", "logo.svg"), "utf8")).toBe("<svg/>");
    expect(fs.readFileSync(path.join(copy.dir, "draft.md"), "utf8")).toBe("还没保存");
    expect((await works.history(copy)).map((version) => version.message)).toEqual(["复制自「原作品」"]);
    expect((await works.status(copy)).files).toEqual([]);

    const named = await works.duplicate(source, { title: "第二版" });
    expect(works.meta(named).meta.title).toBe("第二版");
  });
});
