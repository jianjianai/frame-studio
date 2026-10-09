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
    expect((await call(route, { method: "PATCH", body: { experiences: ["通用"] } })).status).toBe(200);
    expect((await call(`${route}/publish`, { method: "POST" })).status).toBe(200);
    const experience = await call("/api/tools/experience_write", { method: "POST", body: { work: work.id, operations: [{ op: "write", path: "x.md", content: "# x\n" }] } });
    expect(experience.status).toBe(200);

    // The files are read-only on disk, whatever tool would write them.
    const scene = path.join(work.dir, "scene.ts");
    expect(() => fs.writeFileSync(scene, "x")).toThrow(/EACCES|permission/);
    expect(() => fs.writeFileSync(path.join(work.dir, "new.ts"), "x")).toThrow(/EACCES|permission/);
    // The AI can still talk about it (review, experience), and is told it may not change it.
    const { ai } = app.services;
    const session = { meta: { id: "s-published", work: work.id, repo: "local", queue: [], status: "idle", commands: [] } };
    ai.sessions.set(session.meta.id, session);
    const prompt = ai.turnPrompt(session, { text: "复盘一下", attachments: [], view: null }, await app.services.openWork(work.id, "local"));
    expect(prompt.at(-1).text).toContain("这个作品已发布，只能查看");
    expect(prompt.at(-1).text).toContain("经验库和素材库本身不属于作品，可以照常整理");
    ai.sessions.delete(session.meta.id);

    // Organizing the libraries goes on: new libraries (not linked to it), their files and versions.
    const tool = (name, args) => call(`/api/tools/${name}`, { method: "POST", body: { work: work.id, ...args } });
    expect((await tool("experience_link", { add: ["通用"] })).status).toBe(423);
    const newLibrary = await tool("experience_link", { create: ["复盘"] });
    expect(newLibrary.body.data.created).toEqual(["复盘"]);
    expect(newLibrary.body.text).toContain("没有关联到它");
    expect((await tool("experience_write", { library: "复盘", operations: [{ op: "write", path: "要点.md", content: "# 要点\n\n- 开场太慢\n" }] })).status).toBe(200);
    expect((await tool("experience_read", { library: "复盘", path: "要点.md" })).body.text).toContain("开场太慢");
    expect((await tool("experience_commit", { message: "复盘要点" })).body.data.files).toContain("复盘/要点.md");
    expect((await tool("materials_link", { remove: ["x"] })).status).toBe(423);
    expect((await tool("materials_link", { create: ["精选"] })).body.data).toMatchObject({ created: ["精选"], materials: [] });
    expect((await tool("material_write", { library: "精选", operations: [{ op: "put", path: "note.txt", content: "好用" }] })).body.data[0].ok).toBe(true);
    expect(readProjectSource(fs.readFileSync(path.join(work.dir, "project.ts"), "utf8")).meta.experiences).toEqual(["通用"]);

    expect((await call(`${route}/unpublish`, { method: "POST" })).status).toBe(200);
    expect((await git(work.root, ["log", "-1", "--format=%s"])).trim()).toBe("取消发布");
    fs.writeFileSync(scene, fs.readFileSync(scene, "utf8")); // writable again
    expect(fs.readFileSync(path.join(work.dir, "project.ts"), "utf8")).not.toContain("publishedAt");
    expect((await call(route, { method: "PATCH", body: { title: "改名" } })).status).toBe(200);
  });

  it("copies a work with its current files into a new, unpublished work", async () => {
    const source = await works.create({ title: "原作品" });
    fs.mkdirSync(path.join(source.dir, "public"), { recursive: true });
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
    fs.writeFileSync(path.join(copy.dir, "draft.md"), "副本可以改"); // the source was published (read-only), the copy is not
    // A published work can still go to the recycle bin (its read-only checkout is removed).
    await works.trash(source.id, "local");
    expect(fs.existsSync(source.root)).toBe(false);
  });

  it("lets an AI only ask to delete a work; the user confirms or keeps it", async () => {
    const work = await works.create({ title: "不要了" });
    const asked = await call("/api/tools/work_delete", { method: "POST", body: { work: work.id, reason: "用户说这个作品不要了" } });
    expect(asked.status).toBe(200);
    expect(asked.body.text).toContain("作品还在");
    const listed = async () => (await call("/api/works")).body.find((item) => item.id === work.id);
    expect((await listed()).deleteRequest).toMatchObject({ reason: "用户说这个作品不要了" });
    expect(fs.existsSync(work.dir)).toBe(true);

    // Keeping it clears the request; the AI can also take it back.
    expect((await call(`/api/works/local/${work.id}/delete-request`, { method: "DELETE" })).body).toEqual({ cleared: true });
    expect((await listed()).deleteRequest).toBeNull();
    await call("/api/tools/work_delete", { method: "POST", body: { work: work.id } });
    expect((await call("/api/tools/work_delete", { method: "POST", body: { work: work.id, cancel: true } })).body.text).toBe("已撤回删除请求");

    // Confirming is moving it to the recycle bin, which also clears the request.
    await call("/api/tools/work_delete", { method: "POST", body: { work: work.id, reason: "再次请求" } });
    expect((await call(`/api/works/local/${work.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await listed()).toBeUndefined();
    expect(app.services.settings.get("deleteRequests")).toEqual([]);
  });
});
