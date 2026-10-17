import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { git } from "../server/git.mjs";
import { closestLibraries, findLibrary, looseName, searchLibraries, seriesOf, suitability, tokens } from "../server/libraries.mjs";

describe("picking libraries", () => {
  const libraries = [
    { id: "Lottie动效", title: "Lottie动效", about: "可以直接放进图层的 Lottie 小动画" },
    { id: "动态文字", title: "动态文字", about: "标题、歌词的入场动画" },
    { id: "三维示例", title: "三维示例", about: "三维模型和产品展示用的环境光" },
    { id: "brand", title: "品牌素材", about: "logo 和配色" },
  ];

  it("finds a library by a name written a little differently, and only then", () => {
    expect(findLibrary("lottie 动效", libraries)?.id).toBe("Lottie动效");
    expect(findLibrary("三维示例素材库", libraries)?.id).toBe("三维示例");
    expect(findLibrary("品牌素材", libraries)?.id).toBe("brand");
    expect(findLibrary("动效", libraries)).toBeNull();
    expect(looseName("「Lottie 动效」库")).toBe("lottie动效");
    expect(closestLibraries("动效", libraries).map((item) => item.id)).toEqual(["Lottie动效"]);
    expect(closestLibraries("动态文本", libraries).map((item) => item.id)).toEqual(["动态文字"]);
    expect(closestLibraries("完全无关", libraries)).toEqual([]);
  });

  it("searches names, introductions and other text, more words first", () => {
    expect(searchLibraries(libraries, "产品 三维").map((item) => item.id)).toEqual(["三维示例"]);
    expect(searchLibraries(libraries, "logo").map((item) => item.id)).toEqual(["brand"]);
    // No word in full: the Chinese pairs it shares still find it.
    expect(searchLibraries(libraries, "产品模型展示").map((item) => item.id)).toEqual(["三维示例"]);
    expect([...tokens("三维的产品 Lottie")]).toEqual(["lottie", "三维", "产品"]);
  });

  it("knows a series by the way people name episodes", () => {
    expect(["数学：勾股定理", "Vlog | 京都", "猫咪日常 第3期", "第一集：开场", "城市夜景MV"].map(seriesOf)).toEqual(["数学", "vlog", "猫咪日常", "", ""]);
  });

  it("says which libraries suit a work: its words, and what works like it link", () => {
    const works = [
      { id: "a", title: "手机产品展示 第一集", text: "手机产品展示 第一集", links: new Set(["materials:brand", "experiences:产品"]) },
      { id: "b", title: "猫咪日常", text: "猫咪日常 vlog", links: new Set(["materials:动态文字"]) },
    ];
    const work = { id: "c", title: "手机产品展示 第二集", text: "手机产品展示 第二集", links: new Set() };
    const fit = suitability({ kind: "materials", work, libraries, works });
    expect(fit.get("三维示例").why).toEqual(["名称、介绍或内容和作品相近"]);
    expect(fit.get("brand").why).toEqual(["类似的作品「手机产品展示 第一集」在用"]);
    expect(fit.get("动态文字").score).toBe(0);
    // A library shared with other works makes them alike too.
    const linked = { ...work, text: "", links: new Set(["experiences:产品"]) };
    expect(suitability({ kind: "materials", work: linked, libraries, works }).get("brand").score).toBeGreaterThan(0.3);
  });
});

describe("many libraries", () => {
  let app, base, works;
  const call = async (route, { method = "GET", body } = {}) => {
    const response = await fetch(base + route, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const tool = (name, args) => call(`/api/tools/${name}`, { method: "POST", body: args });
  const ids = {};

  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-libraries-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    ({ works } = app.services);
    // Sixty material libraries and forty experience libraries, each its own branch.
    for (let index = 0; index < 60; index++) {
      const id = index === 7 ? "三维模型库" : `素材${String(index).padStart(2, "0")}`;
      const files = { "README.md": `# ${id}\n\n${index === 7 ? "产品展示用的三维模型和摄影棚光。" : `第 ${index} 组通用背景图片。`}\n` };
      for (let file = 0; file < (index === 7 ? 45 : 1); file++) files[`${file < 40 ? "img/" : ""}bg${file}.svg`] = `<svg>${file}</svg>`;
      // Six resources in three kinds each: too many for a full directory of every library.
      const declared = ["character", "set", "prop"].flatMap((kind) => [1, 2].map((n) => `  ${kind}${n}: resource({ kind: "${kind}", title: "${id} 的第 ${n} 个${kind}资源（名字很长）", preview: { width: 400, height: 300, draw() {} } }),`));
      files["code/shapes.ts"] = `import { defineResources, resource } from "@frame/engine/resources";\n\nexport const resources = defineResources({\n${declared.join("\n")}\n});\n`;
      await app.services.materials.branches.create("local", id, { files, message: "素材库" });
    }
    app.services.events.emit({ type: "materials", repo: "local", paths: [] });
    for (let index = 0; index < 40; index++) {
      const id = index === 3 ? "产品视频" : `经验${String(index).padStart(2, "0")}`;
      const files = { "README.md": `# ${id}\n\n${index === 3 ? "产品展示类短片的节奏和镜头。" : `第 ${index} 类作品的经验。`}\n` };
      if (index === 3) files["开场.md"] = "# 开场\n\n前两秒亮出产品。\n";
      await app.services.experience.branches.create("local", id, { files, message: "经验库" });
    }
    for (const [key, title] of [
      ["a", "三维产品展示 第一集"],
      ["b", "三维产品展示 第二集"],
      ["c", "三维产品展示 第三集"],
    ]) {
      const work = (await call("/api/works", { method: "POST", body: { title } })).body;
      ids[key] = work.id;
      if (key !== "c") await call(`/api/works/local/${work.id}`, { method: "PATCH", body: { materials: ["三维模型库"], experiences: ["产品视频"] } });
    }
    // A hundred branches with their checkouts take a while on a busy machine.
  }, 240000);
  afterAll(() => app.close());

  it("lists how many works use each library and which suit a work", async () => {
    const listed = (await call(`/api/repos/local/materials/libraries?work=${ids.c}`)).body;
    expect(listed).toHaveLength(60);
    const model = listed.find((item) => item.id === "三维模型库");
    expect(model).toMatchObject({ works: 2, linked: false, about: "产品展示用的三维模型和摄影棚光。" });
    expect(model.why.join("")).toContain("类似的作品");
    expect(Math.max(...listed.filter((item) => item.id !== "三维模型库").map((item) => item.score))).toBeLessThan(model.score);
    const experiences = (await call(`/api/repos/local/experience/libraries?work=${ids.c}`)).body;
    expect(experiences.find((item) => item.id === "产品视频")).toMatchObject({ works: 2, files: 2 });
  });

  it("keeps the session brief small and names the libraries that suit the work", async () => {
    const work = await app.services.openWork(ids.c, "local");
    await app.services.resources.overview("local");
    await app.services.libraries.prepare(work);
    works.writeBrief(work);
    const brief = fs.readFileSync(path.join(work.root, "AGENTS.md"), "utf8");
    expect(Buffer.byteLength(brief)).toBeLessThan(32 * 1024);
    const materials = brief.slice(brief.indexOf("## 素材库\n"));
    expect(materials).toMatch(/「三维模型库」（名称、介绍或内容和作品相近；类似的作品「三维产品展示 第.集」「三维产品展示 第.集」在用）：资源 6 个（角色 2、物品 2、场景 2）、文件 46 个。/);
    expect(materials).toContain("作品库里共有 60 个素材库，下面是可能适合本作品的，还有 59 个没有列出");
    expect(materials).not.toContain("素材42");
    expect(brief).toMatch(/本作品没有关联经验库。可能适合本作品的（作品库里共 40 个[^\n]*）：\n- 「产品视频」：产品展示类短片的节奏和镜头。/);
    // A work linking every library still gets a brief Codex reads in full.
    await works.update(work, { materials: listedIds(await call("/api/repos/local/materials/libraries")) });
    await app.services.libraries.prepare(work);
    works.writeBrief(work);
    const crowded = fs.readFileSync(path.join(work.root, "AGENTS.md"), "utf8");
    await works.update(work, { materials: [] });
    expect(Buffer.byteLength(crowded.slice(crowded.indexOf("## 素材库\n")))).toBeLessThan(7000);
    expect(crowded).toContain("「素材59」（本作品已关联）");
  });

  it("pages and searches the libraries for the AI", async () => {
    const first = await tool("materials_list", { work: ids.c });
    expect(first.body.text).toContain("作品库 local 有 60 个素材库，本作品引用了 0 个");
    expect(first.body.data.libraries).toHaveLength(30);
    // The library works like this one use comes first.
    expect(first.body.data.libraries[0].id).toBe("三维模型库");
    expect(first.body.text).toContain("还有 30 个：offset: 30 看下一页");
    expect((await tool("materials_list", { work: ids.c, offset: 55 })).body.data.libraries).toHaveLength(5);
    const found = await tool("materials_list", { work: ids.c, query: "摄影棚" });
    expect(found.body.data.libraries.map((item) => item.id)).toEqual(["三维模型库"]);
    // A library's files, a page at a time, with where the rest are.
    const files = await tool("materials_list", { work: ids.c, library: "三维模型库", limit: 10 });
    expect(files.body.data).toMatchObject({ total: 46, matched: 46 });
    expect(files.body.text).toContain("还有 36 个：img/（31）、（根目录）（5）");
    expect((await tool("materials_list", { work: ids.c, library: "三维模型库", query: "bg4" })).body.data.matched).toBe(6);
  });

  it("finds experience libraries by topic and tells the AI how many there are", async () => {
    const listed = await tool("experience_list", { work: ids.c, query: "开场" });
    expect(listed.body.text).toContain("作品库 local 有 40 个经验库");
    expect(listed.body.text).toContain("相关文档：开场.md（开场）");
    expect(listed.body.data.libraries.map((item) => item.id)).toEqual(["产品视频"]);
    const all = await tool("experience_list", { work: ids.c, limit: 5 });
    expect(all.body.data.libraries[0].id).toBe("产品视频");
    expect(all.body.text).toContain("还有 35 个");
    const context = (await tool("work_context", { work: ids.c, sections: ["experiences", "materials"] })).body.data;
    expect(context.experiences).toMatchObject({ available: 40, offers: [{ library: "产品视频" }] });
    expect(context.materials.libraries.length).toBeLessThanOrEqual(6);
    expect(context.materials.more).toContain("还有");
  });

  it("links by a loosely written name and answers unknown names with the closest ones", async () => {
    const linked = await tool("experience_link", { work: ids.c, add: ["产品 视频"] });
    expect(linked.body.data.added).toEqual(["产品视频"]);
    const unknown = await tool("experience_link", { work: ids.c, add: ["产品类"] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toContain("最接近的：「产品视频」");
    expect(unknown.body.error.message).toContain("作品库里共有 40 个经验库");
    expect(unknown.body.error.message).not.toContain("经验39");
    const material = await tool("materials_link", { work: ids.c, add: ["三维模型"] });
    expect(material.body.data.added).toEqual(["三维模型库"]);
    const wrong = await tool("materials_link", { work: ids.c, add: ["三维"] });
    expect(wrong.body.error.message).toContain("最接近的：「三维模型库」");
  });

  it("lists the resources of many libraries by library, the work's own in full", async () => {
    const listed = (await tool("resources_search", { work: ids.a })).body.text;
    expect(listed).toMatch(/^## 素材库「三维模型库」（本作品已关联）\n角色（2）：/);
    expect(listed).toContain("## 其他素材库（59 个，本作品未关联；用 library 看一个的目录）\n- 「素材00」：角色 2、物品 2、场景 2");
    expect(listed.length).toBeLessThan(8000);
    const one = (await tool("resources_search", { work: ids.a, library: "素材42" })).body.text;
    expect(one).toContain("## 素材库「素材42」（本作品未关联，materials_use 时会自动关联）");
  });

  it("lists the resources of the work's libraries only, when asked", async () => {
    const work = (await call(`/api/works/local/${ids.a}/resources?scope=linked`)).body;
    expect(work.libraries).toHaveLength(60);
    expect(new Set(work.items.map((item) => item.library))).toEqual(new Set(["三维模型库"]));
  });
});

const listedIds = (response) => response.body.map((item) => item.id);

describe("the recycle bin of libraries", () => {
  let app, base;
  const call = async (route, { method = "GET", body, raw } = {}) => {
    const response = await fetch(base + route, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: raw ?? (body ? JSON.stringify(body) : undefined) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const tool = (name, args) => call(`/api/tools/${name}`, { method: "POST", body: args });
  const materials = "/api/repos/local/materials";
  const experience = "/api/repos/local/experience";
  const enc = encodeURIComponent;

  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-library-trash-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
  });
  afterAll(() => app.close());

  const log = (dir, count = 1) => git(dir, ["log", `-${count}`, "--format=%s"]).then((out) => out.trim().split("\n"));
  const branches = (prefix) =>
    git(app.services.repos.dir("local"), ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).then((out) => out.split("\n").filter((branch) => branch.startsWith(prefix)));

  it("keeps a deleted material library in the bin until it is restored or purged", async () => {
    await call(`${materials}/libraries`, { method: "POST", body: { name: "旧素材" } });
    await call(`${materials}/libraries/${enc("旧素材")}/upload?path=logo.svg`, { method: "POST", raw: "<svg/>" });
    const work = (await call("/api/works", { method: "POST", body: { title: "用旧素材" } })).body;
    await call(`/api/works/local/${work.id}`, { method: "PATCH", body: { materials: ["旧素材"] } });
    const dir = await app.services.materials.dir("local");

    const removed = await call(`${materials}/libraries/${enc("旧素材")}`, { method: "DELETE" });
    expect(removed.body).toMatchObject({ key: "旧素材", id: "旧素材", title: "旧素材" });
    expect((await call(`${materials}/libraries`)).body.map((item) => item.id)).toEqual([]);
    expect((await call(`${materials}/trash`)).body).toMatchObject([{ key: "旧素材", id: "旧素材", title: "旧素材", files: 1 }]);
    expect((await call(`/api/works/local/${work.id}/materials`)).body.missing).toEqual(["旧素材"]);
    // Nothing in the bin is searched or listed for the AI.
    expect((await tool("search", { work: work.id, pattern: "svg", scope: ["materials"] })).body.text).toContain("没有找到");
    expect((await tool("materials_list", { work: work.id })).body.text).toContain("有 0 个素材库");
    // The bin is a branch of its own, its last version says so.
    expect(await branches("materials")).toEqual(["materials-trash/旧素材"]);
    expect(await log(path.join(dir, ".trash", "旧素材"))).toEqual(["删除素材库：旧素材（移到回收站）"]);

    expect((await call(`${materials}/trash/${enc("旧素材")}/restore`, { method: "POST" })).body).toEqual({ id: "旧素材", title: "旧素材", renamed: false });
    expect((await call(`/api/works/local/${work.id}/materials`)).body.libraries.map((item) => item.id)).toEqual(["旧素材"]);
    expect((await call(`${materials}/trash`)).body).toEqual([]);
    expect(await branches("materials")).toEqual(["materials/旧素材"]);
    expect(await log(path.join(dir, "旧素材"), 3)).toEqual(["恢复素材库：旧素材", "删除素材库：旧素材（移到回收站）", "添加 logo.svg"]);

    // Deleted again, its id taken meanwhile: it comes back under another one.
    await call(`${materials}/libraries/${enc("旧素材")}`, { method: "DELETE" });
    await call(`${materials}/libraries`, { method: "POST", body: { name: "旧素材" } });
    expect((await call(`${materials}/trash/${enc("旧素材")}/restore`, { method: "POST" })).body).toEqual({ id: "旧素材-2", title: "旧素材", renamed: true });
    await call(`${materials}/libraries/${enc("旧素材-2")}`, { method: "DELETE" });
    await call(`${materials}/libraries/${enc("旧素材")}`, { method: "DELETE" });
    expect((await call(`${materials}/trash`)).body.map((item) => item.key).sort()).toEqual(["旧素材", "旧素材-2"]);
    expect((await call(`${materials}/trash/${enc("旧素材-2")}`, { method: "DELETE" })).body).toEqual({ purged: ["旧素材-2"] });
    // Its versions go for good: not while a work still references it.
    const refused = await call(`${materials}/trash`, { method: "DELETE" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("还有作品引用素材库「旧素材」：「用旧素材」");
    await call(`/api/works/local/${work.id}`, { method: "PATCH", body: { materials: [] } });
    expect((await call(`${materials}/trash`, { method: "DELETE" })).body).toEqual({ purged: ["旧素材"] });
    expect((await call(`${materials}/trash`)).body).toEqual([]);
    expect(await branches("materials")).toEqual([]);
    expect(fs.existsSync(path.join(dir, ".trash"))).toBe(false);
    expect((await call(`${materials}/trash/${enc("旧素材")}/restore`, { method: "POST" })).status).toBe(404);
    expect((await call(`${materials}/trash/${enc("../x")}/restore`, { method: "POST" })).status).toBe(404);
  });

  it("bins an experience library with its unsaved edits and leaves the others' unsaved", async () => {
    await call(`${experience}/libraries`, { method: "POST", body: { name: "旧经验" } });
    await call(`${experience}/libraries`, { method: "POST", body: { name: "留着" } });
    // Renaming changes the title; the id works link stays.
    expect((await call(`${experience}/libraries/${enc("旧经验")}/rename`, { method: "POST", body: { name: "更旧的经验" } })).body).toEqual({ id: "旧经验", title: "更旧的经验" });
    await call(`${experience}/file`, { method: "PUT", body: { path: "旧经验/没保存.md", content: "# 没保存\n", expectedHash: null } });
    await call(`${experience}/file`, { method: "PUT", body: { path: "留着/草稿.md", content: "# 草稿\n", expectedHash: null } });

    expect((await call(`${experience}/libraries/${enc("旧经验")}`, { method: "DELETE" })).body).toMatchObject({ key: "旧经验", title: "更旧的经验" });
    expect((await call(`${experience}/libraries/${enc("留着")}/status`)).body.files.map((file) => file.path)).toEqual(["草稿.md"]);
    expect((await call(`${experience}/libraries`)).body.map((item) => item.id)).toEqual(["留着"]);
    expect((await call(`${experience}/trash`)).body).toMatchObject([{ key: "旧经验", id: "旧经验", title: "更旧的经验", files: 1 }]);

    // The AI hears where it is; restored, the work's link works again.
    const work = (await call("/api/works", { method: "POST", body: { title: "用旧经验" } })).body;
    expect((await tool("experience_link", { work: work.id, add: ["更旧的经验"] })).body.error.message).toBe(
      "「更旧的经验」在经验库的回收站里：请用户在「经验库」选项卡（管理…）的回收站中恢复。",
    );
    await call(`/api/works/local/${work.id}`, { method: "PATCH", body: { experiences: ["旧经验"] } });
    expect((await call(`${experience}/trash/${enc("旧经验")}/restore`, { method: "POST" })).body).toEqual({ id: "旧经验", title: "更旧的经验", renamed: false });
    expect((await tool("experience_read", { work: work.id })).body.text).toContain("经验库「更旧的经验」");
    const restored = (await app.services.experience.dir("local")) + "/旧经验";
    expect(await log(restored, 4)).toEqual(["恢复经验库：更旧的经验", "删除经验库：更旧的经验（移到回收站）", "经验库改名为「更旧的经验」", "新建经验库：旧经验"]);

    // Purged: its branch goes.
    await call(`${experience}/libraries/${enc("旧经验")}`, { method: "DELETE" });
    expect((await call(`${experience}/trash/${enc("旧经验")}`, { method: "DELETE" })).body).toEqual({ purged: ["旧经验"] });
    const dir = await app.services.experience.dir("local");
    expect(fs.existsSync(path.join(dir, ".trash"))).toBe(false);
    expect(await branches("experience")).toEqual(["experience/留着"]);
    expect((await call(`${experience}/libraries/${enc("留着")}/status`)).body.files.map((file) => file.path)).toEqual(["草稿.md"]);
  });
});
