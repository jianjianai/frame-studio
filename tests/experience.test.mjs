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
    expect((await call(`/api/works/local/${work.id}`, { method: "PATCH", body: { experiences: ["知识类视频"] } })).status).toBe(200);

    // Without a work: a library of the repository, named.
    expect((await tool("experience_read", { repo: "local", library: "知识类视频" })).body.text).toContain("经验库「知识类视频」");
    expect((await tool("experience_read", { repo: "local" })).body.error.code).toBe("LIBRARY_REQUIRED");
    const overview = await tool("experience_read", { work: work.id });
    expect(overview.body.text).toContain("经验库「知识类视频」");
    expect(overview.body.text).toContain("类作品的制作经验");

    const written = await tool("experience_write", { work: work.id, operations: [{ op: "write", path: "开场.md", content: "# 开场\n\n- 前 3 秒给出问题\n" }] });
    expect(written.status).toBe(200);
    expect(written.body.text).toContain("未保存：经验库「知识类视频」现在有 1 个未保存的修改（开场.md）");
    expect(written.body.data.unsaved).toEqual(["开场.md"]);
    const edited = await tool("experience_write", { work: work.id, operations: [{ op: "edit", path: "开场.md", edits: [{ oldText: "前 3 秒", newText: "前 2 秒" }] }] });
    expect(edited.body.text).toContain("1 处");
    expect((await tool("experience_read", { work: work.id, path: "开场.md" })).body.text).toContain("前 2 秒给出问题");
    expect((await tool("experience_read", { work: work.id, path: "../README.md" })).status).toBe(400);
    const refused = await tool("experience_write", {
      work: work.id,
      operations: [
        { op: "write", path: "x.js", content: "" },
        { op: "delete", path: "README.md" },
        { op: "write", path: "临时.md", content: "# 临时\n" },
        { op: "move", from: "临时.md", to: "归档.md" },
      ],
    });
    expect(refused.body.data.results.map((item) => item.status)).toEqual(["failed", "failed", "ok", "ok"]);
    expect(refused.body.text).toContain("只存放 .md 或 .txt");
    expect((await tool("experience_read", { work: work.id, path: "归档.md" })).body.text).toBe("# 临时\n");
    await tool("experience_write", { work: work.id, operations: [{ op: "delete", path: "归档.md" }] });

    const context = await tool("work_context", { work: work.id });
    // Its libraries' documents by name, and the work's notes in full: the AI reads what it needs.
    const [linked] = context.body.data.experiences.libraries;
    expect(linked.library).toBe("知识类视频");
    expect(linked.documents.map((doc) => doc.path)).toEqual(["README.md", "开场.md"]);
    expect(context.body.data.notes).toContain("# 科普短片");

    // The library's own versions (a branch of its own). What the AI wrote stays unsaved until saved.
    const versions = `${lib}/libraries/${encodeURIComponent("知识类视频")}`;
    expect((await call(`${versions}/status`)).body.files).toEqual([{ path: "开场.md", status: "?" }]);
    expect((await call(`${versions}/history`)).body.map((version) => version.message)).toEqual(["新建经验库：知识类视频"]);
    expect((await call(`${versions}/commit`, { method: "POST", body: { message: "记录开场" } })).body.commit).toMatch(/^[0-9a-f]{40}$/);
    // Edits made in the studio stay unsaved until saved too; paths from the library's folder.
    await call(`${lib}/file`, { method: "PUT", body: { path: "知识类视频/开场.md", content: "# 开场\n\n- 前 2 秒给出问题\n- 第 3 秒给答案\n", expectedHash: undefined } });
    expect((await call(`${versions}/diff?file=${encodeURIComponent("开场.md")}`)).body.diff).toContain("+- 第 3 秒给答案");
    expect((await call(`${versions}/status`)).body.files.map((file) => file.path)).toEqual(["开场.md"]);
    expect((await call(`${versions}/commit`, { method: "POST", body: { message: "开场经验" } })).body.commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await call(`${versions}/history`)).body[0].message).toBe("开场经验");
    // A version's files, and one file's change in it (the 版本与同步 history opens them).
    const [saved] = (await call(`${versions}/history`)).body;
    expect((await call(`${versions}/changes?commit=${saved.commit}`)).body).toEqual([{ status: "M", path: "开场.md" }]);
    const one = (await call(`${versions}/diff?commit=${saved.commit}&file=${encodeURIComponent("开场.md")}`)).body.diff;
    expect(one).toContain("+- 第 3 秒给答案");
    expect(one).not.toContain("README.md");
    expect((await call(`${versions}/diff?commit=HEAD`)).body.diff).toContain("+- 第 3 秒给答案");
    expect((await call(`${versions}/diff?commit=--output=x`)).status).toBe(400);
    expect((await call(`${lib}/versions`)).body).toMatchObject([{ id: "知识类视频", files: 0, head: { message: "开场经验" } }]);
    // The template's introduction says nothing about the library: no `about` until someone writes one.
    expect((await call(`${lib}/libraries`)).body).toMatchObject([{ id: "知识类视频", title: "知识类视频", files: 2, about: "", works: 1 }]);
    expect((await call(`${lib}/libraries?work=${work.id}`)).body).toMatchObject([{ id: "知识类视频", linked: true }]);
    expect((await call(`${lib}/tree?library=${encodeURIComponent("知识类视频")}`)).body.map((entry) => entry.path)).toEqual(["知识类视频/README.md", "知识类视频/开场.md"]);
    expect((await call(`${lib}/find?q=${encodeURIComponent("开场")}`)).body).toEqual([{ library: "知识类视频", path: "知识类视频/开场.md", title: "开场" }]);

    // The session brief says where things are; contents are read when needed.
    const opened = await app.services.openWork(work.id, "local");
    const brief = fs.readFileSync(path.join(opened.root, "AGENTS.md"), "utf8");
    expect(brief).toContain(`- 需求和约定：\`projects/${opened.slug}/AGENTS.md\``);
    expect(brief).toContain("- 经验库：「知识类视频」，需要时用 experience_read 读");
    expect(brief).toContain(`可以复用、但没有合适经验库的经验记在 \`projects/${opened.slug}/经验.md\`（还没有）`);
    expect(brief).not.toContain("第 3 秒给答案");
    expect(fs.readFileSync(path.join(opened.root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });

  it("renames a library: its title changes, the id works link stays", async () => {
    const created = await call(`${lib}/libraries`, { method: "POST", body: { name: "旧名称" } });
    const work = (await call("/api/works", { method: "POST", body: { title: "改名测试" } })).body;
    await call(`/api/works/local/${work.id}`, { method: "PATCH", body: { experiences: [created.body.id] } });
    await tool("experience_write", { work: work.id, operations: [{ op: "write", path: "做法.md", content: "# 做法\n\n- 先画分镜\n" }] });
    const versions = `${lib}/libraries/${encodeURIComponent("旧名称")}`;
    // An edit in the studio, not saved yet.
    await call(`${lib}/file`, { method: "PUT", body: { path: "旧名称/做法.md", content: "# 做法\n\n- 先画分镜\n- 再配音\n" } });

    expect((await call(`${versions}/rename`, { method: "POST", body: { name: "新名称" } })).body).toEqual({ id: "旧名称", title: "新名称" });
    expect((await call(`${lib}/libraries`)).body.find((item) => item.id === "旧名称")).toMatchObject({ title: "新名称", files: 2 });
    expect((await call(`${lib}/file?path=${encodeURIComponent("旧名称/README.md")}`)).body.content).toMatch(/^# 新名称\n/);
    // Unsaved, like the other edits.
    expect((await call(`${versions}/history`)).body.map((version) => version.message)).toEqual(["新建经验库：旧名称"]);
    expect((await call(`${versions}/status`)).body.files.map((file) => file.path)).toEqual(["README.md", "做法.md"]);

    // The work links the id: nothing of it changes.
    const info = (await call(`/api/works/local/${work.id}`)).body;
    expect(info.meta.experiences).toEqual(["旧名称"]);
    expect(info.experiences).toEqual({ libraries: [{ id: "旧名称", title: "新名称" }], missing: [] });
    expect((await tool("experience_read", { work: work.id, path: "做法.md" })).body.text).toContain("先画分镜");
    const opened = await app.services.openWork(work.id, "local");
    expect(Object.keys(app.services.works.writeBrief(opened).experience)).toEqual(["旧名称"]);
    expect(fs.readFileSync(path.join(opened.root, "AGENTS.md"), "utf8")).toContain("- 经验库：「新名称」（id 旧名称）");
    // The title is free for another library (with an id of its own); a name is required.
    expect((await call(`${lib}/libraries`, { method: "POST", body: { name: "新名称" } })).body).toEqual({ id: "新名称", title: "新名称" });
    expect((await call(`${versions}/rename`, { method: "POST", body: { name: " " } })).status).toBe(400);

    await call(`${lib}/libraries/${encodeURIComponent("旧名称")}`, { method: "DELETE" });
    expect((await call(`/api/works/local/${work.id}`)).body.experiences).toEqual({ libraries: [], missing: ["旧名称"] });
  });

  it("lets a work follow several libraries", async () => {
    await call(`${lib}/libraries`, { method: "POST", body: { name: "通用规范" } });
    await call(`${lib}/libraries`, { method: "POST", body: { name: "竖屏短片" } });
    const work = (await call("/api/works", { method: "POST", body: { title: "多个经验库" } })).body;
    await call(`/api/works/local/${work.id}`, { method: "PATCH", body: { experiences: ["通用规范", "竖屏短片"] } });

    const opened = await app.services.openWork(work.id, "local");
    expect(Object.keys(app.services.works.writeBrief(opened).experience)).toEqual(["通用规范", "竖屏短片"]);
    const brief = fs.readFileSync(path.join(opened.root, "AGENTS.md"), "utf8");
    expect(brief).toContain("- 经验库：「通用规范」、「竖屏短片」，需要时用 experience_read 读");

    const ambiguous = await tool("experience_write", { work: work.id, operations: [{ op: "write", path: "节奏.md", content: "# 节奏\n" }] });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error.message).toContain("用 library 参数指定");
    expect((await tool("experience_write", { work: work.id, library: "竖屏短片", operations: [{ op: "write", path: "节奏.md", content: "# 节奏\n\n- 3 秒一切\n" }] })).status).toBe(200);
    expect((await tool("experience_read", { work: work.id, library: "竖屏短片", path: "节奏.md" })).body.text).toContain("3 秒一切");
    // A library the work does not link can be named too (organizing); this one has no such document.
    expect((await tool("experience_read", { work: work.id, library: "知识类视频", path: "节奏.md" })).status).toBe(404);
    expect((await tool("experience_read", { work: work.id, library: "没有这个库", path: "节奏.md" })).body.error.message).toContain("用 experience_list 的 query");
    // Names written a little differently still find the library; unknown ones get the closest.
    expect((await tool("experience_read", { work: work.id, library: "竖屏 短片", path: "节奏.md" })).body.text).toContain("3 秒一切");
    expect((await tool("experience_read", { work: work.id, library: "竖屏", path: "节奏.md" })).body.error.message).toContain("最接近的：「竖屏短片」");
    const overview = await tool("experience_read", { work: work.id });
    expect(overview.body.text).toContain("## 经验库「通用规范」");
    expect(overview.body.text).toMatch(/## 经验库「竖屏短片」[\s\S]*### 文档\n\n- `节奏.md` 节奏：3 秒一切/);
    expect((await tool("work_context", { work: work.id })).body.data.experiences.libraries.map((item) => item.library)).toEqual(["通用规范", "竖屏短片"]);
  });

  it("lets the AI link libraries and save their versions", async () => {
    const { ai, works, tools } = app.services;
    const created = (await call("/api/works", { method: "POST", body: { title: "AI 关联经验库" } })).body;
    const work = await app.services.openWork(created.id, "local");
    const { snapshotFiles } = await import("../server/ai/context.mjs");
    const session = { meta: { id: "link-session", work: work.id, repo: "local", queue: [], context: { experience: works.writeBrief(work).experience } }, files: snapshotFiles(work.dir) };
    ai.sessions.set(session.meta.id, session);
    const scope = { work: work.id, repo: "local", session: session.meta.id };
    const context = () => ai.turnPrompt(session, { text: "继续", attachments: [], view: null }, work).at(-1).text;

    // Unknown names are refused with the list, before anything is created.
    await expect(tools.call("experience_link", { add: ["不存在"], create: ["不该建"] }, scope)).rejects.toMatchObject({ status: 400 });
    expect((await call(`${lib}/libraries`)).body.some((item) => item.id === "不该建")).toBe(false);

    const linked = await tools.call("experience_link", { add: ["知识类视频"], create: ["新经验"] }, scope);
    expect(linked.data.experiences.map((item) => item.id)).toEqual(["知识类视频", "新经验"]);
    expect(linked.text).toContain("新关联：「知识类视频」「新经验」，需要时用 experience_read 读。");
    expect(works.meta(work).meta.experiences).toEqual(["知识类视频", "新经验"]);
    // The AI saw them in the tool's answer: the next message does not repeat them.
    expect(context()).not.toContain("经验库");
    // create with an existing name links it; remove leaves the library itself alone.
    expect((await tools.call("experience_link", { create: ["新经验"] }, scope)).data.added).toEqual([]);
    const removed = await tools.call("experience_link", { remove: ["新经验"] }, scope);
    expect(removed.data).toMatchObject({ removed: ["新经验"], experiences: [{ id: "知识类视频" }] });
    expect(context()).not.toContain("不再关联");
    expect((await call(`${lib}/libraries`)).body.some((item) => item.id === "新经验")).toBe(true);

    // Saving is a version of each library with changes, on its own branch (no work hooks run for it).
    await tools.call("experience_write", { library: "新经验", operations: [{ op: "write", path: "做法.md", content: "# 做法\n" }] }, scope);
    await tools.call("experience_write", { library: "知识类视频", operations: [{ op: "write", path: "备忘.md", content: "# 备忘\n" }] }, scope);
    const hooks = [];
    works.beforeSave.push((target) => hooks.push(target.id));
    try {
      const saved = await tools.call("experience_commit", { library: "新经验", message: "新经验的做法", push: true }, scope);
      expect(saved.data.saved).toMatchObject([{ library: "新经验", files: ["新经验/做法.md"], pushed: { ok: false } }]); // the local repository has no GitHub
      expect(saved.data.saved[0].commit).toMatch(/^[0-9a-f]{40}$/);
      expect(saved.text).toContain("推送到 GitHub 失败");
    } finally {
      works.beforeSave.pop();
    }
    expect(hooks).toEqual([]);
    const versions = (id) => `${lib}/libraries/${encodeURIComponent(id)}`;
    expect((await call(`${versions("新经验")}/status`)).body.files).toEqual([]);
    expect((await call(`${versions("新经验")}/history`)).body[0].message).toBe("新经验的做法");
    // The other library's edit was not saved with it. Without `library`, every library with
    // changes gets a version of its own (竖屏短片 has what the AI wrote in the test before).
    expect((await call(`${versions("知识类视频")}/status`)).body.files.map((file) => file.path)).toEqual(["备忘.md"]);
    expect((await tools.call("experience_commit", { message: "备忘" }, scope)).data.saved.map((item) => item.library)).toEqual(["知识类视频", "竖屏短片"]);
    // In a conversation too, what the AI writes stays unsaved after the turn's end.
    await call(`${lib}/file`, { method: "PUT", body: { path: "知识类视频/用户在改.md", content: "# 用户在改\n" } });
    const written = await tools.call("experience_write", { library: "知识类视频", operations: [{ op: "write", path: "开场.md", content: "# 开场\n\n先给冲突\n" }] }, scope);
    expect(written.text).toContain("未保存：经验库「知识类视频」现在有 2 个未保存的修改");
    expect(session.experienceWrites ?? null).toBeNull();
    await app.services.experience.saveTurn([...(session.experienceWrites?.values() ?? [])]);
    expect((await call(`${versions("知识类视频")}/history`)).body[0].message).toBe("备忘");
    expect((await call(`${versions("知识类视频")}/status`)).body.files.map((file) => file.path).sort()).toEqual(["开场.md", "用户在改.md"]);
    expect((await tools.call("experience_commit", { library: "知识类视频", message: "开场要先给冲突" }, scope)).data.saved).toMatchObject([{ files: ["知识类视频/开场.md", "知识类视频/用户在改.md"] }]);
    expect((await tools.call("experience_commit", { message: "再存" }, scope)).text).toBe("经验库没有未保存的修改");
    // Linking changes the work, so a published work refuses it; saving experience does not.
    await call(`/api/works/local/${work.id}/publish`, { method: "POST" });
    await expect(tools.call("experience_link", { add: ["新经验"] }, scope)).rejects.toMatchObject({ status: 423 });
    expect((await tools.call("experience_commit", { message: "已发布也能存" }, scope)).text).toBe("经验库没有未保存的修改");
  });

  it("tells the AI where the work's notes and 经验.md are, without their contents, sizes or limits", async () => {
    const created = (await call("/api/works", { method: "POST", body: { title: "笔记很长" } })).body;
    const work = await app.services.openWork(created.id, "local");
    const notes = "# 笔记很长\n\n## 需求\n\n- 竖屏，45 秒\n\n## 历史\n\n" + "以前试过的做法。".repeat(560); // 13 KB
    fs.writeFileSync(path.join(work.dir, "AGENTS.md"), notes);
    fs.writeFileSync(path.join(work.dir, "经验.md"), "# 经验\n\n## 竖屏字幕\n\n- 字幕放在 y≈0.78\n\n## 开场\n\n- 前 2 秒给冲突\n");
    app.services.works.writeBrief(work);
    const brief = fs.readFileSync(path.join(work.root, "AGENTS.md"), "utf8");
    expect(brief).toContain(`- 需求和约定：\`projects/${work.slug}/AGENTS.md\`，开始工作前先读`);
    expect(brief).toContain(`- 记下但还没整理进经验库的经验：\`projects/${work.slug}/经验.md\`。`);
    // No sizes or counts: the brief stays the same while the notes grow.
    expect(brief).not.toMatch(/KB|\d+ 条/);
    expect(brief).not.toContain("以前试过的做法");
    expect(brief).not.toContain("需要整理");
    expect(Buffer.byteLength(brief)).toBeLessThan(4500);
    // work_context gives the contents to whoever asks.
    expect((await app.services.experience.summary(work)).inbox).toContain("## 竖屏字幕");
    expect((await tool("work_context", { work: work.id })).body.data.notes).toBe(notes);
  });

  it("tells the AI when GitHub has newer versions of the work or both sides do", async () => {
    const { ai, works, remoteSync } = app.services;
    const created = (await call("/api/works", { method: "POST", body: { title: "两台电脑" } })).body;
    const work = await app.services.openWork(created.id, "local");
    const { snapshotFiles } = await import("../server/ai/context.mjs");
    const session = { meta: { id: "remote-session", work: work.id, repo: "local", queue: [], context: { experience: works.writeBrief(work).experience } }, files: snapshotFiles(work.dir) };
    const context = () => ai.turnPrompt(session, { text: "继续", attachments: [], view: null }, work).at(-1).text;
    remoteSync.set(work, { state: "behind", ahead: 0, behind: 2, blocked: ["projects/x/scene.ts"] });
    expect(context()).toContain("GitHub 上有这个作品 2 个更新的版本");
    expect(context()).toContain("不要修改作品文件");
    remoteSync.set(work, { state: "diverged", ahead: 1, behind: 3 });
    expect(context()).toContain("冲突：本机 1 个、GitHub 3 个");
    remoteSync.set(work, { state: "synced", ahead: 0, behind: 0, pulled: 4 });
    expect(context()).toContain("拉取了 4 个更新的版本");
    remoteSync.set(work, { state: "synced", ahead: 0, behind: 0 });
    expect(context()).not.toContain("GitHub");
  });

  it("tells a chat session only what changed since it last knew", async () => {
    const { ai, works, auth } = app.services;
    const created = (await call("/api/works", { method: "POST", body: { title: "音乐短片" } })).body;
    await call(`/api/works/local/${created.id}`, { method: "PATCH", body: { experiences: ["知识类视频"] } });
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
    expect(text).toContain("经验库「知识类视频」有变化（来自用户或其他对话，不是你改的）：\n- `开场.md` 已修改");
    expect(text).not.toContain("前 1 秒给出问题");
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
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "experience_write", arguments: { operations: [{ op: "write", path: "开场.md", content: "# 开场\n\n- 前 3 秒给出问题\n" }] } } }),
    });
    expect(await response.text()).toContain("全部完成");
    expect(context()).not.toContain("经验库");

    // A bound session's changing tools have no work parameter, and a stray one is ignored; its
    // reading tools take another work of its repository.
    const mcp = async (method, params) => {
      const reply = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + token },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
      });
      return JSON.parse((await reply.text()).split("\n").find((line) => line.startsWith("data: ")).slice(6)).result;
    };
    const listed = await mcp("tools/list", {});
    const naming = listed.tools.filter((tool) => "work" in (tool.inputSchema.properties ?? {}));
    expect(naming.map((tool) => tool.name)).toContain("work_context");
    expect(naming.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
    expect(listed.tools.find((tool) => tool.name === "experience_read")._meta).toEqual({ "anthropic/alwaysLoad": true });
    expect(listed.tools.find((tool) => tool.name === "experience_commit")._meta).toBeUndefined();
    // Built-in agents edit files with their own tools.
    expect(listed.tools.some((tool) => tool.name === "files_batch")).toBe(false);
    const stray = await mcp("tools/call", {
      name: "experience_write",
      arguments: { work: "work-" + work.id, operations: [{ op: "write", path: "开场.md", content: "# 开场\n\n- 前 3 秒给出问题\n" }] },
    });
    expect(stray.isError).toBeFalsy();
    const read = await mcp("tools/call", { name: "experience_read", arguments: { work: work.id, path: "开场.md" } });
    expect(read.content[0].text).toContain("前 3 秒给出问题");
    expect((await mcp("tools/call", { name: "experience_read", arguments: { work: "work-" + work.id, path: "开场.md" } })).isError).toBe(true);

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
    const write = (content) => mcp("tools/call", { name: "experience_write", arguments: { operations: [{ op: "write", path: "开场.md", content }] } });
    let [result] = await Promise.all([write("# 开场\n\n- 被拒绝\n"), answer("reject")]);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("用户没有允许这次修改");
    expect((await mcp("tools/call", { name: "experience_read", arguments: { path: "开场.md" } })).content[0].text).toContain("前 3 秒给出问题");
    [result] = await Promise.all([write("# 开场\n\n- 允许了\n"), answer("allow")]);
    expect(result.content[0].text).toContain("全部完成");
    session.meta.configOptions = [{ id: "mode", currentValue: "acceptEdits" }];
    expect((await write("# 开场\n\n- 不用确认\n")).content[0].text).toContain("全部完成");
    ai.sessions.delete(session.meta.id);
  });
});
