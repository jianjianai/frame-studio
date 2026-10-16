import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";

describe("a work's AI reads the other works of its repository", () => {
  let app, tools, done, draft, scope;

  beforeAll(async () => {
    app = await createApp({ env: { FRAME_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "frame-cross-")), FRAME_PORT: "0" }, plugins });
    await app.listen();
    tools = app.services.tools;
    done = await app.services.works.create({ title: "成品" });
    draft = await app.services.works.create({ title: "草稿" });
    fs.writeFileSync(path.join(draft.dir, "故事.md"), "# 引力\n\n镜头一：她抬头看见白光。\n");
    fs.writeFileSync(path.join(draft.dir, "scenes", "act1.ts"), "// 镜头一的运镜\nexport const SHOT_ONE = 1.5;\n");
    fs.mkdirSync(path.join(draft.dir, "public"), { recursive: true });
    await sharp({ create: { width: 8, height: 4, channels: 3, background: "#0a0" } })
      .png()
      .toFile(path.join(draft.dir, "public", "cover.png"));
    // The session of the finished work, as its built-in AI calls the tools.
    scope = { work: done.id, repo: "local", agent: true };
  });
  afterAll(() => app.close());

  it("lists the works of its repository, its own marked", async () => {
    const result = await tools.call("works_list", {}, scope);
    expect(result.text).toContain(`${draft.id}「草稿」`);
    expect(result.text).toContain(`${done.id}「成品」（当前作品）`);
  });

  it("reads another work's files: the list, texts, media facts", async () => {
    const list = await tools.call("work_read", { work: draft.id }, scope);
    expect(list.text).toContain(`作品 ${draft.id}「草稿」（另一个作品，只读）`);
    expect(list.text).toContain("故事.md");
    const read = await tools.call("work_read", { work: draft.id, paths: ["故事.md", "public", "public/cover.png", "nope.md"] }, scope);
    expect(read.text).toContain("=== 故事.md （3 行）\n# 引力");
    expect(read.text).toContain("=== public/\npublic/cover.png");
    expect(read.text).toMatch(/=== public\/cover\.png\n（image，8×4，.*代码里的地址 films\/[\w-]+\/cover\.png）/);
    expect(read.text).toContain("=== nope.md\n（不存在）");
    const part = await tools.call("work_read", { work: draft.id, paths: ["故事.md"], startLine: 3, lineCount: 1 }, scope);
    expect(part.text).toContain("（第 3–3 行，共 3 行）\n镜头一：她抬头看见白光。");
    await expect(tools.call("work_read", { work: draft.id, paths: ["../../x"] }, scope)).rejects.toMatchObject({ status: 400 });
  });

  it("searches the other works' code", async () => {
    const found = await tools.call("search", { pattern: "镜头一", scope: ["works"] }, scope);
    expect(found.text).toContain(`作品 ${draft.id}「草稿」/scenes/act1.ts`);
    expect(found.text).toContain(`作品 ${draft.id}「草稿」/故事.md`);
    // Its own work is "work", not "works".
    fs.writeFileSync(path.join(done.dir, "notes.md"), "镜头一\n");
    expect((await tools.call("search", { pattern: "镜头一", scope: ["works"] }, scope)).text).not.toContain(`作品 ${done.id}`);
  });

  it("copies an asset from another work, and changes only its own", async () => {
    const copied = await tools.call("asset_import", { fromWork: { work: draft.id, path: `films/${draft.slug}/cover.png` } }, scope);
    expect(copied.data.path).toBe("public/imports/cover.png");
    expect(fs.existsSync(path.join(done.dir, "public", "imports", "cover.png"))).toBe(true);
    expect(fs.readFileSync(path.join(done.dir, "production", "licenses.md"), "utf8")).toContain(`来自同一作品库的作品 ${draft.id}`);
    await expect(tools.call("asset_import", { fromWork: { work: draft.id, path: "public/none.png" } }, scope)).rejects.toThrow(
      `作品 ${draft.id} 里没有 public/none.png`,
    );
    // Changing tools refuse another work.
    await expect(tools.call("layers_edit", { work: draft.id, operations: [{ op: "remove", id: "title" }] }, scope)).rejects.toThrow(/只能修改当前作品/);
    // Reading tools look at it.
    const context = await tools.call("work_context", { work: draft.id, sections: ["work"] }, scope);
    expect(context.data.work.id).toBe(draft.id);
  });
});
