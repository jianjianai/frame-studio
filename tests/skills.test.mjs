import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { git } from "../server/git.mjs";
import { frontmatter, mentionedSkills, readUpload } from "../server/skills.mjs";
import { platformInstructions } from "../server/templates.mjs";

const skillMd = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
const zip = (files) =>
  Buffer.from(
    zipSync(
      Object.fromEntries(Object.entries(files).map(([name, content]) => [name, typeof content === "string" ? strToU8(content) : new Uint8Array(content)])),
    ),
  );

describe("SKILL.md frontmatter", () => {
  it("reads plain, quoted, folded and literal fields", () => {
    expect(frontmatter(skillMd("cut", "剪辑节奏"))).toEqual({ name: "cut", description: "剪辑节奏" });
    expect(frontmatter("---\nname: \"a: b\"\ndescription: 'it''s'\n---\n")).toEqual({ name: "a: b", description: "it's" });
    expect(frontmatter("---\nname: x\ndescription: >\n  第一行\n  第二行\nlicense: MIT\n---\nbody")).toEqual({
      name: "x",
      description: "第一行 第二行",
      license: "MIT",
    });
    expect(frontmatter("---\nname: x\ndescription: |\n  一\n\n  二\n---\n").description).toBe("一\n\n二");
    expect(frontmatter("---\nname: x\ndescription: 很长的说明\n  接着写\nallowed-tools:\n  - Read\n---\n")).toMatchObject({ description: "很长的说明 接着写" });
    expect(frontmatter("# 没有 frontmatter")).toBeNull();
  });
});

describe("uploaded skills", () => {
  it("finds each skill by its SKILL.md and drops what archives carry besides", () => {
    const skills = readUpload(
      "bundle.zip",
      zip({
        "cut/SKILL.md": skillMd("cut", "剪辑"),
        "cut/scripts/beat.py": "print(1)",
        "cut/examples/inner/SKILL.md": "part of cut",
        "__MACOSX/cut/._SKILL.md": "junk",
        "cut/.DS_Store": "junk",
        "titles/SKILL.md": skillMd("titles", "标题"),
        "README.md": "outside any skill",
      }),
    );
    expect(skills.map((skill) => [skill.name, skill.files.map(([name]) => name).sort()])).toEqual([
      ["cut", ["SKILL.md", "examples/inner/SKILL.md", "scripts/beat.py"]],
      ["titles", ["SKILL.md"]],
    ]);
  });
  it("names a skill packed without its folder after its frontmatter, else the file", () => {
    expect(readUpload("whatever.skill", zip({ "SKILL.md": skillMd("配色", "颜色"), "ref.md": "x" }))[0]).toMatchObject({ name: "配色" });
    expect(readUpload("运镜.zip", zip({ "SKILL.md": "---\ndescription: 镜头\n---\n" }))[0].name).toBe("运镜");
    expect(readUpload("字幕.md", Buffer.from("no frontmatter"))[0]).toMatchObject({ name: "字幕", files: [["SKILL.md", expect.anything()]] });
  });
  it("refuses what is not a skill", () => {
    expect(() => readUpload("a.zip", zip({ "notes.md": "x" }))).toThrow(/没有找到 SKILL.md/);
    expect(() => readUpload("a.zip", zip({ "bad name/SKILL.md": "x" }))).toThrow(/不能用作文件夹名/);
    expect(() => readUpload("a.zip", zip({ "../x/SKILL.md": "x" }))).toThrow(/路径不对/);
    expect(() => readUpload("SKILL.md", Buffer.from("x"))).toThrow(/没有写 name/);
    expect(() => readUpload("a.pdf", Buffer.from("x"))).toThrow(/上传文件夹/);
    expect(() => readUpload("a.zip", Buffer.from("not a zip"))).toThrow(/读不了/);
  });
});

describe("the repository's skills in the studio and for the AI", () => {
  let app, base, home;
  const call = async (route, { method = "GET", body, raw } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: body ? { "Content-Type": "application/json" } : raw ? { "Content-Type": "application/octet-stream" } : {},
      body: body ? JSON.stringify(body) : raw,
    });
    const type = response.headers.get("content-type") || "";
    return { status: response.status, body: type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  const branch = async () => (await git(app.services.repos.dir("local"), ["branch", "--list", "frame/skills"])).trim();
  const messages = async () => (await call("/api/repos/local/skills/history")).body.map((version) => version.message);

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-skills-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
  });
  afterAll(() => app.close());

  it("links them into the work for Claude Code and Codex, and saves what the AI changes there", async () => {
    const created = (await call("/api/works", { method: "POST", body: { title: "技能测试" } })).body;
    // Reading, also the versions, starts no branch.
    expect((await call("/api/repos/local/skills")).body).toEqual({ skills: [], versioned: false });
    expect((await call("/api/repos/local/skills/status")).body.head).toBeNull();
    expect((await call("/api/repos/local/skills/remote")).body).toEqual({ state: "unknown" });
    expect(await branch()).toBe("");

    const work = await app.services.openWork(created.id, "local");
    await app.services.skills.link(work);
    const folder = path.join(home, "skills", "local");
    for (const link of [".claude/skills", ".agents/skills"]) expect(fs.realpathSync(path.join(work.root, link))).toBe(fs.realpathSync(folder));
    // The links never become part of the work.
    expect((await call(`/api/works/local/${work.id}/status`)).body.files).toEqual([]);

    // The AI writes a skill with its own tools; the turn's end saves it, and the branch starts.
    fs.mkdirSync(path.join(work.root, ".claude/skills/节奏"), { recursive: true });
    fs.writeFileSync(path.join(work.root, ".claude/skills/节奏/SKILL.md"), skillMd("节奏", "按音乐节拍剪辑"));
    await app.services.skills.saveTurn("local");
    expect(await branch()).toContain("frame/skills");
    expect(await messages()).toEqual(["AI 修改技能：节奏", "创建技能分支"]);
    expect(fs.existsSync(path.join(folder, "README.md"))).toBe(true);
    expect(fs.readFileSync(path.join(work.root, ".agents/skills/节奏/SKILL.md"), "utf8")).toContain("按音乐节拍剪辑");
    await app.services.skills.saveTurn("local"); // nothing changed: no version
    expect((await messages()).length).toBe(2);

    const listed = (await call("/api/repos/local/skills")).body;
    expect(listed.versioned).toBe(true);
    expect(listed.skills).toEqual([
      { name: "节奏", title: "节奏", description: "按音乐节拍剪辑", files: [expect.objectContaining({ path: "SKILL.md", type: "file" })] },
    ]);
  });

  it("uploads, creates, edits, downloads and deletes skills, each a version", async () => {
    const bundle = zip({ "titles/SKILL.md": skillMd("titles", "标题动画"), "titles/ref/fonts.md": "字体" });
    const uploaded = await call(`/api/repos/local/skills/upload?name=${encodeURIComponent("titles.zip")}`, { method: "POST", raw: bundle });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.skills.map((skill) => skill.name)).toEqual(["titles"]);
    // The same name again asks first.
    const again = await call("/api/repos/local/skills/upload?name=titles.zip", { method: "POST", raw: bundle });
    expect(again.status).toBe(409);
    expect(again.body.error.details).toEqual({ existing: ["titles"] });
    const replaced = zip({ "titles/SKILL.md": skillMd("titles", "新的说明") });
    expect((await call("/api/repos/local/skills/upload?name=titles.zip&replace=1", { method: "POST", raw: replaced })).status).toBe(200);
    expect(fs.existsSync(path.join(home, "skills/local/titles/ref"))).toBe(false);

    const made = await call("/api/repos/local/skills/create", { method: "POST", body: { name: "color-grade", description: "调色: 电影感" } });
    expect(made.body).toMatchObject({ name: "color-grade", title: "color-grade", description: "调色: 电影感" });
    expect((await call("/api/repos/local/skills/create", { method: "POST", body: { name: "has space" } })).status).toBe(400);

    const file = (await call("/api/repos/local/skills/file?path=color-grade/SKILL.md")).body;
    const saved = await call("/api/repos/local/skills/file", {
      method: "PUT",
      body: { path: "color-grade/SKILL.md", content: skillMd("color-grade", "暖色调"), expectedHash: file.hash },
    });
    expect(saved.status).toBe(200);
    expect(
      (await call("/api/repos/local/skills/file", { method: "PUT", body: { path: "color-grade/SKILL.md", content: "x", expectedHash: file.hash } })).status,
    ).toBe(409);
    expect((await call("/api/repos/local/skills/file?path=../secrets.json")).status).toBe(400);
    expect((await call("/api/repos/local/skills/file?path=color-grade/SKILL.md", { method: "DELETE" })).status).toBe(400);

    const download = await call("/api/repos/local/skills/download?name=titles");
    expect(Object.keys(unzipSync(download.body))).toEqual(["titles/", "titles/SKILL.md"]);
    expect(strFromU8(unzipSync(download.body)["titles/SKILL.md"])).toContain("新的说明");

    expect((await call("/api/repos/local/skills/skill?name=titles", { method: "DELETE" })).status).toBe(200);
    expect((await call("/api/repos/local/skills")).body.skills.map((skill) => skill.name)).toEqual(["color-grade", "节奏"]);
    expect((await messages()).slice(0, 5)).toEqual([
      "删除技能：titles",
      "修改技能「color-grade」：SKILL.md",
      "新建技能：color-grade",
      "更新技能：titles",
      "上传技能：titles",
    ]);

    // Like any shared branch: back to an earlier version, as a new one.
    const history = (await call("/api/repos/local/skills/history")).body;
    const before = history.find((version) => version.message === "上传技能：titles");
    expect((await call("/api/repos/local/skills/revert", { method: "POST", body: { commit: before.commit } })).status).toBe(200);
    expect((await call("/api/repos/local/skills")).body.skills.map((skill) => skill.name)).toEqual(["titles", "节奏"]);
  });

  it("tells the AI which skills the user named with @<name>", async () => {
    expect(mentionedSkills("用 @节奏 剪，再看 @titles。还有 @没有 和 a@titles @节奏", ["节奏", "titles"])).toEqual(["节奏", "titles"]);
    const created = (await call("/api/works", { method: "POST", body: { title: "点名" } })).body;
    const work = await app.services.openWork(created.id, "local");
    const { ai } = app.services;
    const session = { meta: { id: "s-skills", work: work.id, repo: "local", queue: [], status: "idle", commands: [] } };
    ai.sessions.set(session.meta.id, session);
    const context = (text) => ai.turnPrompt(session, { text, attachments: [], view: null }, work);
    const named = context("@节奏 帮我卡点");
    expect(named[0].text).toBe("@节奏 帮我卡点");
    expect(named.at(-1).text).toContain("用户点名要用技能 节奏（.claude/skills/节奏/SKILL.md）：先用 Skill 工具加载，按它的说明做。");
    expect(context("帮我卡点，@不存在").at(-1).text).not.toContain("点名");
    // /<skill> at the start, as typed in Claude Code, is the same (Claude lists skills as its commands).
    expect(mentionedSkills("/titles 做 @节奏", ["节奏", "titles"])).toEqual(["titles", "节奏"]);
    session.meta.commands = [
      { name: "节奏", description: "" },
      { name: "compact", description: "" },
    ];
    const slashed = context("/节奏 帮我卡点");
    expect(slashed[0].text).toBe("@节奏 帮我卡点");
    expect(slashed.at(-1).text).toContain("用户点名要用技能 节奏");
    expect(context("/compact")).toEqual([{ type: "text", text: "/compact" }]);
    // Codex finds them under .agents/ and reads them itself.
    session.process = { agent: "codex" };
    expect(context("@titles 做标题").at(-1).text).toContain("用户点名要用技能 titles（.agents/skills/titles/SKILL.md）：先读它的 SKILL.md");
    ai.sessions.delete(session.meta.id);
  });

  it("offers a new conversation the commands its AI offered last, before the AI has started", async () => {
    const { ai } = app.services;
    const created = (await call("/api/works", { method: "POST", body: { title: "新对话" } })).body;
    const work = await app.services.openWork(created.id, "local");
    const meta = { work: work.id, repo: "local", profile: "claude-account", queue: [], status: "idle" };
    const older = { meta: { ...meta, id: "s-older", updatedAt: "2026-10-17T00:00:00.000Z", commands: [{ name: "init", description: "写 CLAUDE.md" }] } };
    const fresh = { meta: { ...meta, id: "s-fresh", updatedAt: "2026-10-17T01:00:00.000Z", commands: [] } };
    ai.sessions.set(older.meta.id, older);
    ai.sessions.set(fresh.meta.id, fresh);
    expect((await call("/api/ai/profiles/claude-account/commands")).body).toEqual([{ name: "init", description: "写 CLAUDE.md" }]);
    // Sent as typed, not with the work's state appended as its arguments.
    expect(ai.turnPrompt(fresh, { text: "/init", attachments: [], view: null }, work)).toEqual([{ type: "text", text: "/init" }]);
    ai.sessions.delete(older.meta.id);
    ai.sessions.delete(fresh.meta.id);
    expect((await call("/api/ai/profiles/claude-account/commands")).body).toEqual([]);
  });

  it("hands out a skill's files as they are, for the 经验 and 素材 views, and lets the user point the AI at one", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const bundle = zip({ "motion/SKILL.md": skillMd("motion", "动效知识库"), "motion/references/index.md": "# 索引", "motion/assets/a/preview.png": png });
    expect((await call("/api/repos/local/skills/upload?name=motion.zip", { method: "POST", raw: bundle })).status).toBe(200);
    const raw = await fetch(`${base}/api/repos/local/skills/raw?path=${encodeURIComponent("motion/assets/a/preview.png")}`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await raw.arrayBuffer())).toEqual(png);
    expect((await call("/api/repos/local/skills/raw?path=motion/../../../secrets.json")).status).toBe(400);
    expect((await call("/api/repos/local/skills/raw?path=motion/none.png")).status).toBe(404);
    // A file picked in those views and sent with a message: where the AI finds it.
    const created = (await call("/api/works", { method: "POST", body: { title: "引用技能文件" } })).body;
    const work = await app.services.openWork(created.id, "local");
    const { ai } = app.services;
    const session = { meta: { id: "s-skill-file", work: work.id, repo: "local", queue: [], status: "idle", commands: [] } };
    const message = { text: "参考这个", attachments: [{ type: "skill", path: "motion/references/index.md" }], view: null };
    expect(ai.turnPrompt(session, message, work).at(-1).text).toContain("用户引用：技能里的 .claude/skills/motion/references/index.md");
    session.process = { agent: "codex" };
    expect(ai.turnPrompt(session, message, work).at(-1).text).toContain("技能里的 .agents/skills/motion/references/index.md");
  });

  it("asks the AI to have the user agree before changing them", () => {
    expect(platformInstructions()).toContain("新建、修改或删除技能");
  });
});
