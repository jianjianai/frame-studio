import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { git } from "../server/git.mjs";

describe("material libraries", () => {
  let app, base, materials, works;
  const call = async (route, { method = "GET", body, raw } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const type = response.headers.get("content-type") || "";
    return { status: response.status, body: type.includes("json") ? await response.json() : await response.text() };
  };
  const tool = (name, args) => call(`/api/tools/${name}`, { method: "POST", body: args });
  const lib = "/api/repos/local/materials";
  /** Save a library's unsaved changes as a version, as 版本与同步 does. */
  const save = (id, message = "保存") => call(`${lib}/libraries/${encodeURIComponent(id)}/commit`, { method: "POST", body: { message } });

  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-materials-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    ({ materials, works } = app.services);
  });
  afterAll(() => app.close());

  it("keeps each library on its own branch, its changes unsaved until saved as a version", async () => {
    expect((await call(`${lib}/libraries`, { method: "POST", body: { name: "品牌" } })).body).toEqual({ id: "品牌", title: "品牌" });
    expect((await call(`${lib}/libraries`, { method: "POST", body: { name: "品牌" } })).status).toBe(409);
    const uploaded = await call(`${lib}/libraries/${encodeURIComponent("品牌")}/upload?path=logo.svg&source=${encodeURIComponent("自己画的")}&license=CC0`, {
      method: "POST",
      raw: "<svg>v1</svg>",
    });
    expect(uploaded.body).toMatchObject({ ref: "品牌/logo.svg", url: "materials/品牌/logo.svg", kind: "image" });
    const files = (await call(`${lib}/libraries/${encodeURIComponent("品牌")}/files`)).body;
    expect(files).toMatchObject([{ path: "logo.svg", kind: "image", size: 13 }]);
    expect(files[0].blob).toMatch(/^[0-9a-f]{40}$/);
    const readme = fs.readFileSync(path.join(await materials.dir("local"), "品牌", "README.md"), "utf8");
    expect(readme).toContain("- `logo.svg`：来源 自己画的；许可 CC0");
    expect((await call(`${lib}/libraries/${encodeURIComponent("品牌")}/history`)).body.map((version) => version.message)).toEqual(["新建素材库：品牌"]);
    expect((await call(`${lib}/libraries/${encodeURIComponent("品牌")}/status`)).body.files.map((file) => file.path).sort()).toEqual(["README.md", "logo.svg"]);
    expect((await call(`${lib}/versions`)).body).toMatchObject([{ id: "品牌", files: 2 }]);
    expect((await save("品牌", "添加 logo.svg")).body.commit).toMatch(/^[0-9a-f]{40}$/);
    expect((await call(`${lib}/libraries/${encodeURIComponent("品牌")}/history`)).body.map((version) => version.message)).toEqual(["添加 logo.svg", "新建素材库：品牌"]);
    expect((await call(`${lib}/libraries/${encodeURIComponent("品牌")}/status`)).body.files).toEqual([]);
    expect((await call(`${lib}/libraries`)).body).toMatchObject([{ id: "品牌", title: "品牌", files: 1, size: 13, about: "", works: 0 }]);
    expect((await call(`${lib}/versions`)).body).toMatchObject([{ id: "品牌", title: "品牌", files: 0, head: { message: "添加 logo.svg" } }]);
    // An id is a branch name: no spaces or the characters Git refuses.
    expect((await call(`${lib}/libraries`, { method: "POST", body: { name: "通用 背景~1" } })).body).toEqual({ id: "通用-背景-1", title: "通用 背景~1" });
    expect((await git(app.services.repos.dir("local"), ["for-each-ref", "--format=%(refname:short)", "refs/heads/materials/"])).trim().split("\n")).toEqual(["materials/品牌", "materials/通用-背景-1"]);
    await call(`${lib}/libraries/${encodeURIComponent("通用-背景-1")}`, { method: "DELETE" });
    await call(`${lib}/trash/${encodeURIComponent("通用-背景-1")}`, { method: "DELETE" });
  });

  it("reads and saves a library's text file for an editor tab, left unsaved", async () => {
    await call(`${lib}/libraries`, { method: "POST", body: { name: "人物" } });
    await call(`${lib}/libraries/${encodeURIComponent("人物")}/upload?path=a.svg`, { method: "POST", raw: "<svg>1</svg>" });
    const text = (path) => call(`${lib}/text?path=${encodeURIComponent(path)}`);
    const read = (await text("人物/a.svg")).body;
    expect(read).toMatchObject({ path: "人物/a.svg", content: "<svg>1</svg>" });
    const save = (content, expectedHash) => call(`${lib}/text`, { method: "PUT", body: { path: "人物/a.svg", content, expectedHash } });
    expect((await save("<svg>2</svg>", read.hash)).body.hash).not.toBe(read.hash);
    expect((await save("<svg>3</svg>", read.hash)).status).toBe(409);
    expect((await text("人物/a.svg")).body.content).toBe("<svg>2</svg>");
    expect((await call(`${lib}/libraries/${encodeURIComponent("人物")}/history`)).body.map((version) => version.message)).toEqual(["新建素材库：人物"]);
    expect((await call(`${lib}/libraries/${encodeURIComponent("人物")}/status`)).body.files).toEqual([{ path: "a.svg", status: "?" }]);
    expect((await text("../secrets.json")).status).toBe(400);
    expect((await call(`${lib}/text`, { method: "PUT", body: { path: "人物/../../x.svg", content: "x" } })).status).toBe(400);
    await call(`${lib}/libraries/${encodeURIComponent("人物")}`, { method: "DELETE" });
    await call(`${lib}/trash/${encodeURIComponent("人物")}`, { method: "DELETE" });
  });

  it("lists library files with their size and length for previews", async () => {
    // One second of silence: 8 kHz, 16-bit mono PCM.
    const samples = 8000;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + samples * 2, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(samples * 2, 40);
    const png = await sharp({ create: { width: 32, height: 18, channels: 3, background: "#000" } }).png().toBuffer();
    await call(`${lib}/libraries`, { method: "POST", body: { name: "预览" } });
    await call(`${lib}/libraries/${encodeURIComponent("预览")}/upload?path=silence.wav`, { method: "POST", raw: wav });
    await call(`${lib}/libraries/${encodeURIComponent("预览")}/upload?path=dot.png`, { method: "POST", raw: png });
    const files = (await call(`${lib}/libraries/${encodeURIComponent("预览")}/files`)).body;
    expect(files).toMatchObject([
      { path: "dot.png", kind: "image", width: 32, height: 18 },
      { path: "silence.wav", kind: "audio", duration: 1 },
    ]);
    await call(`${lib}/libraries/${encodeURIComponent("预览")}`, { method: "DELETE" });
  });

  it("serves a work the version it locked, and the current one until it locks", async () => {
    const work = await works.create({ title: "用素材" });
    const route = `/api/works/local/${work.id}`;
    await call(route, { method: "PATCH", body: { materials: ["品牌"] } });
    const asset = `/files/local/${work.id}/materials/${encodeURIComponent("品牌")}/logo.svg`;
    expect((await call(asset)).body).toBe("<svg>v1</svg>");

    // Placing it on a layer locks it.
    await call(`${route}/layers`, { method: "POST", body: { operations: [{ op: "add", clip: { id: "logo", source: { kind: "image", src: "materials/品牌/logo.svg" }, start: 0, duration: 2 } }] } });
    const locks = JSON.parse(fs.readFileSync(path.join(work.dir, "materials.lock.json"), "utf8"));
    expect(Object.keys(locks)).toEqual(["品牌/logo.svg"]);

    // The library changes; the work does not, until its lock is updated.
    await call(`${lib}/libraries/${encodeURIComponent("品牌")}/upload?path=logo.svg&replace=1`, { method: "POST", raw: "<svg>v2</svg>" });
    expect((await call(asset)).body).toBe("<svg>v1</svg>");
    expect((await call(`${lib}/file?path=${encodeURIComponent("品牌/logo.svg")}`)).body).toBe("<svg>v2</svg>");
    const status = (await call(`${route}/materials`)).body;
    expect(status.libraries).toEqual([{ id: "品牌", title: "品牌" }]);
    expect(status.files).toMatchObject([{ ref: "品牌/logo.svg", used: true, outdated: true, unsaved: true }]);
    // An unsaved change is never locked: updating unlocks the file, and the work uses it as it is now.
    expect((await call(`${route}/materials/lock`, { method: "POST", body: { update: true } })).body).toMatchObject({ locked: [], unsaved: ["品牌/logo.svg"] });
    expect(materials.readLocks(work.dir)).toEqual({});
    expect((await call(asset)).body).toBe("<svg>v2</svg>");
    await save("品牌", "新标志");
    expect((await call(`${route}/materials/lock`, { method: "POST", body: { refs: ["品牌/logo.svg"] } })).body.locked).toEqual(["品牌/logo.svg"]);
    expect((await call(asset)).body).toBe("<svg>v2</svg>");

    // References only in code are locked when a version is saved (once the library saved them); the lock file is part of it.
    await call(`${lib}/libraries/${encodeURIComponent("品牌")}/upload?path=bg.svg`, { method: "POST", raw: "<svg>bg</svg>" });
    fs.writeFileSync(path.join(work.dir, "scene.ts"), fs.readFileSync(path.join(work.dir, "scene.ts"), "utf8") + '\n// assetUrl("materials/品牌/bg.svg")\n');
    await works.commit(work, "用背景（素材库还没保存）");
    expect(Object.keys(materials.readLocks(work.dir))).toEqual(["品牌/logo.svg"]);
    await save("品牌", "背景");
    await works.commit(work, "用背景");
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(work.dir, "materials.lock.json"), "utf8")))).toEqual(["品牌/bg.svg", "品牌/logo.svg"]);
    expect((await works.status(work)).files).toEqual([]);

    // Deleting the file from the library leaves the work its locked version.
    await call(`${lib}/libraries/${encodeURIComponent("品牌")}/file?path=bg.svg`, { method: "DELETE" });
    await save("品牌", "删除背景");
    expect((await call(`/files/local/${work.id}/materials/${encodeURIComponent("品牌")}/bg.svg`)).body).toBe("<svg>bg</svg>");
    const check = await app.services.checks.get?.(`local/${work.id}`);
    expect(check ?? null).toBeNull(); // no check stored yet: nothing to assert here

    // A version keeps the locks of what the work uses: an address built at run time keeps those it may name…
    const sceneFile = path.join(work.dir, "scene.ts");
    const dynamic = "// assetUrl(`materials/品牌/${name}.svg`)";
    fs.writeFileSync(sceneFile, fs.readFileSync(sceneFile, "utf8").replace('// assetUrl("materials/品牌/bg.svg")', dynamic));
    await works.commit(work, "动态地址");
    expect(Object.keys(materials.readLocks(work.dir))).toEqual(["品牌/bg.svg", "品牌/logo.svg"]);
    // …and the others go.
    fs.writeFileSync(sceneFile, fs.readFileSync(sceneFile, "utf8").replace(dynamic, ""));
    await works.commit(work, "不用背景");
    expect(Object.keys(materials.readLocks(work.dir))).toEqual(["品牌/logo.svg"]);
    // Nothing used any more: the lock file goes with the version.
    await call(`${route}/layers`, { method: "POST", body: { operations: [{ op: "remove", id: "logo" }] } });
    await works.commit(work, "不用素材");
    expect(fs.existsSync(path.join(work.dir, "materials.lock.json"))).toBe(false);
    expect((await works.status(work)).files).toEqual([]);
  });

  it("lets the browser keep the library files a work plays", async () => {
    await call(`${lib}/libraries`, { method: "POST", body: { name: "缓存" } });
    const put = (file, raw) =>
      call(`${lib}/libraries/${encodeURIComponent("缓存")}/upload?path=${encodeURIComponent(file)}&replace=1`, { method: "POST", raw });
    await put("logo.svg", "<svg>v1</svg>");
    await put("fonts/a.ttf", "font-a");
    await put("fonts/b.ttf", "font-b");
    await put("code/draw.ts", "export const draw = 1;");
    await save("缓存");
    const work = await works.create({ title: "缓存素材" });
    const route = `/api/works/local/${work.id}`;
    await call(route, { method: "PATCH", body: { materials: ["缓存"] } });
    // A placed file is locked; fonts are named by an address built at run time; code runs from .materials.
    await call(`${route}/layers`, {
      method: "POST",
      body: { operations: [{ op: "add", clip: { id: "logo", source: { kind: "image", src: "materials/缓存/logo.svg" }, start: 0, duration: 2 } }] },
    });
    const scene = path.join(work.dir, "scene.ts");
    fs.writeFileSync(scene, fs.readFileSync(scene, "utf8") + '\nimport "@materials/缓存/code/draw";\n// assetUrl(`materials/缓存/fonts/${name}.ttf`)\n');
    const listed = async () => Object.fromEntries((await call(`${route}/precache`)).body.files.map((item) => [item.path, item]));
    const locks = () => materials.readLocks(work.dir);
    let files = await listed();
    expect(Object.keys(files).sort()).toEqual(["materials/缓存/fonts/a.ttf", "materials/缓存/fonts/b.ttf", "materials/缓存/logo.svg"]);
    expect(files["materials/缓存/logo.svg"]).toEqual({ path: "materials/缓存/logo.svg", size: 13, version: "git-" + locks()["缓存/logo.svg"] });
    expect(files["materials/缓存/fonts/a.ttf"]).toMatchObject({ size: 6, version: expect.stringMatching(/^[0-9a-f]{32}$/) });

    // The bundle sends the version the work uses, with the version the list promised.
    const response = await fetch(`${base}${route}/precache/bundle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["materials/缓存/logo.svg"] }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const header = JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32BE(0)).toString());
    expect(header).toMatchObject({ path: "materials/缓存/logo.svg", size: 13, version: files["materials/缓存/logo.svg"].version });
    expect(bytes.subarray(4 + bytes.readUInt32BE(0)).toString()).toBe("<svg>v1</svg>");

    // A new library version changes nothing until the work locks it.
    await put("logo.svg", "<svg>v2!</svg>");
    await save("缓存");
    expect((await listed())["materials/缓存/logo.svg"].version).toBe(files["materials/缓存/logo.svg"].version);
    await call(`${route}/materials/lock`, { method: "POST", body: { update: true } });
    files = await listed();
    expect(files["materials/缓存/logo.svg"]).toMatchObject({ size: 14, version: "git-" + locks()["缓存/logo.svg"] });

    // A Git LFS pointer counts as the size of the object it stands for.
    const text = "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 12345678\n";
    const pointer = (await git(app.services.repos.dir("local"), ["hash-object", "-w", "--stdin"], { input: text })).trim();
    expect(await materials.blobSize("local", pointer)).toBe(12345678);
    expect(await materials.blobSize("local", "0".repeat(40))).toBeNull();

    // Locked but no longer placed (until the next version drops the lock): kept when asked for, not as the work opens.
    await call(`${route}/layers`, { method: "POST", body: { operations: [{ op: "remove", id: "logo" }] } });
    files = await listed();
    expect(files["materials/缓存/logo.svg"]).toMatchObject({ lazy: true, version: "git-" + locks()["缓存/logo.svg"] });
    expect(files["materials/缓存/fonts/a.ttf"].lazy).toBeUndefined();
    await call(`${lib}/libraries/${encodeURIComponent("缓存")}`, { method: "DELETE" });
  });

  it("shows libraries before there is a work, by repository", async () => {
    const listed = await tool("materials_list", { repo: "local" });
    expect(listed.body.data.libraries.map((item) => item.id)).toContain("品牌");
    expect((await tool("materials_list", { repo: "local", library: "品牌" })).body.data.files[0]).toMatchObject({ path: "logo.svg", locked: null });
    expect((await tool("material_read", { repo: "local", library: "品牌", path: "README.md" })).body.text).toMatch(/^# 品牌/);
    expect((await tool("material_read", { repo: "local", library: "品牌", path: "README.md", locked: true })).status).toBe(400);
    expect((await tool("resources_search", { repo: "local" })).status).toBe(200);
    expect((await tool("asset_view", { repo: "local", files: ["public/a.png"] })).body.error.message).toMatch(/materials/);
    expect((await tool("materials_list", {})).body.error.message).toMatch(/repo/);
    expect((await tool("materials_list", { repo: "nope" })).status).toBe(404);
    // Libraries can be made and kept up without a work too.
    const made = await tool("materials_link", { repo: "local", create: ["图标"] });
    expect(made.body.data.created).toEqual(["图标"]);
    expect((await tool("materials_link", { repo: "local", add: ["品牌"] })).status).toBe(400);
    expect((await tool("search", { repo: "local", pattern: "品牌", scope: ["materials"] })).status).toBe(200);
    expect((await tool("search", { pattern: "createScene", scope: ["guide"] })).status).toBe(200);
    expect((await tool("search", { repo: "local", pattern: "x", scope: ["work"] })).status).toBe(400);
    const kept = await tool("material_write", { repo: "local", library: "品牌", operations: [{ op: "put", path: "notes.md", content: "备注" }, { op: "put", path: "x.png", work_file: "a.png" }] });
    expect(kept.body.data.map((item) => item.ok)).toEqual([true, false]);
    expect(kept.body.text).toContain("需要 work");
  });

  it("lets the AI link libraries, add files and use them", async () => {
    const work = (await call("/api/works", { method: "POST", body: { title: "AI 用素材" } })).body;
    // Using a library's file links the library on the way.
    const auto = await tool("materials_use", { work: work.id, files: ["品牌/logo.svg"] });
    expect(auto.body.data.linked).toEqual(["品牌"]);
    expect(auto.body.text).toContain("已为作品关联素材库：品牌");
    await tool("materials_link", { work: work.id, remove: ["品牌"] });
    const linked = await tool("materials_link", { work: work.id, add: ["品牌"], create: ["音效"] });
    expect(linked.body.data.materials).toEqual(["品牌", "音效"]);
    const written = await tool("material_write", { work: work.id, operations: [{ op: "put", library: "音效", path: "notes/readme.txt", content: "说明" }] });
    expect(written.body.data[0]).toMatchObject({ ok: true, ref: "音效/notes/readme.txt", url: "materials/音效/notes/readme.txt" });
    expect(written.body.text).toContain("未保存的修改：「音效」1 个");
    // Not locked while unsaved; the AI saves the library's version itself.
    expect((await tool("materials_use", { work: work.id, files: ["音效/notes/readme.txt"] })).body.data).toMatchObject({ locked: [], unsaved: ["音效/notes/readme.txt"] });
    const committed = await tool("materials_commit", { work: work.id, library: "音效素材库", message: "说明" });
    expect(committed.body.data.saved).toMatchObject([{ library: "音效", files: ["音效/notes/readme.txt"], pushed: null }]);
    // Without library: each library with changes gets a version of its own (品牌 has a note written earlier).
    expect((await tool("materials_commit", { work: work.id, message: "备注" })).body.data.saved.map((item) => item.library)).toEqual(["品牌"]);
    expect((await tool("materials_commit", { work: work.id, message: "再存" })).body.text).toBe("素材库没有未保存的修改");
    // Written as listings and layers write it, with materials/ in front.
    const used = await tool("materials_use", { work: work.id, files: ["materials/音效/notes/readme.txt"] });
    expect((await tool("material_read", { work: work.id, paths: ["materials/音效/notes/readme.txt"] })).body.text).toContain("说明");
    expect(used.body.text).toContain("materials/音效/notes/readme.txt");
    const opened = await app.services.openWork(work.id, "local");
    expect(materials.readLocks(opened.dir)).toHaveProperty(["音效/notes/readme.txt"]);
    const list = await tool("materials_list", { work: work.id });
    // The work's libraries first, in its order; then the others.
    expect(list.body.data.libraries.map((item) => [item.id, item.linked])).toEqual([
      ["品牌", true],
      ["音效", true],
      ["图标", false],
    ]);
    expect(list.body.text).toContain("本作品引用了 2 个：「品牌」「音效」");
    expect((await tool("materials_list", { work: work.id, library: "音效" })).body.data.files).toMatchObject([{ path: "notes/readme.txt", locked: "locked" }]);
    expect((await tool("materials_list", { work: work.id, library: "音效素材库" })).body.text).toContain("materials/音效/notes/readme.txt · 数据");
    const changed = await tool("material_write", {
      work: work.id,
      library: "音效",
      operations: [
        { op: "move", from: "notes/readme.txt", to: "readme.txt" },
        { op: "delete", path: "README.md" },
      ],
    });
    expect(changed.body.data.map((item) => item.ok)).toEqual([true, false]);

    // The README is the library's description: written like any text file, its source notes kept.
    const dir = await materials.dir("local");
    const readme = () => fs.readFileSync(path.join(dir, "音效", "README.md"), "utf8");
    await tool("material_write", {
      work: work.id,
      library: "音效",
      operations: [
        { op: "put", path: "hit.txt", content: "咚", source: "https://example.com/hit", license: "CC0" },
        { op: "put", path: "old.txt", content: "旧", source: "自己录的", license: "CC0" },
      ],
    });
    const described = await tool("material_write", {
      work: work.id,
      library: "音效",
      operations: [
        { op: "put", path: "README.md", content: "# 打击音效\n\n短促的打击声，适合卡点。\n\n## 清单\n\n- hit.txt\n" },
        { op: "edit", path: "README.md", edits: [{ oldText: "适合卡点", newText: "适合卡点和转场" }] },
        { op: "move", from: "hit.txt", to: "sfx/hit.txt" },
        { op: "delete", path: "old.txt" },
        { op: "move", from: "README.md", to: "about.md" },
        { op: "put", path: "README.md", content: "没有标题" },
      ],
    });
    expect(described.body.data.map((item) => item.ok)).toEqual([true, true, true, true, false, false]);
    expect(described.body.text).toContain("2 条素材来源记录已保留");
    expect(described.body.text).toContain("README 的来源记录跟着改了 1 条");
    expect(described.body.text).toContain("README 里它的来源记录也删了 1 条");
    expect(readme()).toMatch(/^# 打击音效\n\n短促的打击声，适合卡点和转场。/);
    expect(readme()).toContain("- `sfx/hit.txt`：来源 https://example.com/hit；许可 CC0");
    expect(readme()).not.toContain("old.txt");
    expect(readme()).not.toContain("readme.txt`：");
    expect((await call(`${lib}/libraries`)).body.find((item) => item.id === "音效").title).toBe("打击音效");
    // Moving a file to another library moves its source note with it.
    await tool("material_write", { work: work.id, library: "音效", operations: [{ op: "move", from: "sfx/hit.txt", to: "hit.txt", to_library: "品牌" }] });
    expect(readme()).not.toContain("hit.txt`：");
    expect(fs.readFileSync(path.join(dir, "品牌", "README.md"), "utf8")).toContain("- `hit.txt`：来源 https://example.com/hit；许可 CC0");

    expect((await tool("materials_link", { work: work.id, remove: ["音效"] })).body.data.materials).toEqual(["品牌"]);
    // The locked file is still served after the move.
    expect((await call(`/files/local/${work.id}/materials/${encodeURIComponent("音效")}/notes/readme.txt`)).body).toBe("说明");
  });

  it("lets works import library code at the versions they lock", async () => {
    const enc = encodeURIComponent;
    const put = (file, content, replace = false) =>
      call(`${lib}/libraries/${enc("特效")}/upload?path=${enc(file)}${replace ? "&replace=1" : ""}`, { method: "POST", raw: content });
    await call(`${lib}/libraries`, { method: "POST", body: { name: "特效" } });
    await put(
      "particles.ts",
      'import { noise } from "./noise";\nimport { assetUrl } from "../../src/engine/types";\nexport const sprite = assetUrl("materials/特效/spark.svg");\nexport const particles = (n: number): number => noise(n) * 2;\n',
    );
    await put("noise.ts", "export const noise = (n: number): number => n + 1;\n");
    await put("spark.svg", "<svg/>");
    await save("特效");

    const work = await works.create({ title: "用代码" });
    await call(`/api/works/local/${work.id}`, { method: "PATCH", body: { materials: ["特效"] } });
    const scene = path.join(work.dir, "scene.ts");
    fs.writeFileSync(scene, 'import { particles } from "@materials/特效/particles";\nexport const amount: number = particles(1);\n' + fs.readFileSync(scene, "utf8"));

    // The work uses the code, what it imports and the material it uses.
    const status = (await call(`/api/works/local/${work.id}/materials`)).body;
    expect(status.files.filter((file) => file.used).map((file) => file.ref)).toEqual(["特效/noise.ts", "特效/particles.ts", "特效/spark.svg"]);
    expect(status.unresolved).toEqual([]);

    // The preview resolves the import to a copy in .materials/, and the copy's own imports next to it.
    const { pluginContainer } = app.services.preview.vite.environments.client;
    const copy = path.join(work.root, ".materials", "特效", "particles.ts");
    expect((await pluginContainer.resolveId("@materials/特效/particles", scene)).id).toBe(copy);
    expect(fs.readFileSync(copy, "utf8")).toContain("noise(n) * 2");
    expect((await pluginContainer.resolveId("./noise", copy)).id).toBe(path.join(work.root, ".materials", "特效", "noise.ts"));
    const engine = (await pluginContainer.resolveId("../../src/engine/types", copy)).id;
    expect(engine).not.toContain(".materials");
    expect(fs.existsSync(engine.split("?")[0])).toBe(true);
    await expect(pluginContainer.resolveId("@materials/特效/nothing", scene)).rejects.toThrow("素材库里没有 @materials/特效/nothing");
    // Copies are never part of the work's versions.
    expect((await works.status(work)).files.map((file) => file.path).some((file) => file.includes(".materials"))).toBe(false);

    // Type checks see the library code like the work's own.
    const { checkWork } = await import("../server/checks.mjs");
    const checked = await checkWork(app.services, work, { runtime: false });
    expect(checked.problems.filter((problem) => problem.source === "types")).toEqual([]);

    // Saving a version locks all three; a later change in the library leaves the work as it was.
    await works.commit(work, "用粒子");
    expect(Object.keys(materials.readLocks(work.dir))).toEqual(expect.arrayContaining(["特效/noise.ts", "特效/particles.ts", "特效/spark.svg"]));
    await put("noise.ts", "export const noise = (n: number): number => n + 100;\n", true);
    await save("特效");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const noiseCopy = path.join(work.root, ".materials", "特效", "noise.ts");
    expect(fs.readFileSync(noiseCopy, "utf8")).toContain("n + 1;");
    expect((await tool("material_read", { work: work.id, library: "特效", path: "noise.ts" })).body.text).toContain("n + 100");
    expect((await tool("material_read", { work: work.id, library: "特效", path: "noise.ts", locked: true })).body.text).toContain("n + 1;");
    // Updating the code (extension optional) brings its imports' new versions too.
    const used = await tool("materials_use", { work: work.id, files: ["特效/particles"], update: true });
    expect(used.body.data.files).toEqual([{ ref: "特效/particles", import: "@materials/特效/particles" }]);
    expect(used.body.data.locked).toEqual(["特效/noise.ts"]);
    expect(fs.readFileSync(noiseCopy, "utf8")).toContain("n + 100");

    // The AI edits library code in place; a missing import is a check error.
    const edited = await tool("material_write", { work: work.id, library: "特效", operations: [{ op: "edit", path: "noise.ts", edits: [{ oldText: "n + 100", newText: "n * 3" }] }] });
    expect(edited.body.data[0].ok).toBe(true);
    expect((await tool("material_read", { work: work.id, library: "特效", path: "noise.ts" })).body.text).toContain("n * 3");
    fs.appendFileSync(scene, 'import "@materials/特效/missing";\n');
    const missing = await checkWork(app.services, work, { runtime: false });
    expect(missing.problems.map((problem) => problem.message)).toContain("素材库里没有 @materials/特效/missing（scene.ts 导入）");
  });

  it("syncs each library through its own branch, binning and renaming too", async () => {
    process.env.FRAME_ALLOW_FILE_REMOTES = "1";
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "frame-remote-")) + "/works.git";
    await git(os.tmpdir(), ["init", "--bare", "--initial-branch=main", remote]);
    const other = await createApp({ env: { FRAME_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "frame-materials-b-")), FRAME_PORT: "0" }, plugins });
    const branches = async (dir) => (await git(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).split("\n").filter((name) => /^materials/.test(name));
    try {
      const a = await app.services.repos.clone({ url: "file://" + remote });
      const b = await other.services.repos.clone({ url: "file://" + remote });
      await materials.create(a.id, "共享");
      await materials.put(a.id, "共享", "a.txt", { content: "from a" });
      await materials.commit(a.id, ["共享"], "a");
      await works.push(await materials.scope(a.id, "共享"));
      // The other device asks GitHub and finds the library.
      await other.services.repos.fetch(b.id);
      expect((await other.services.materials.libraries(b.id)).map((library) => library.id)).toEqual(["共享"]);
      expect((await other.services.materials.files(b.id, "共享")).map((file) => file.path)).toEqual(["a.txt"]);
      // A later version comes in by pulling that library alone.
      await materials.put(a.id, "共享", "b.txt", { content: "from a" });
      await materials.rename(a.id, "共享", "大家的素材");
      await materials.commit(a.id, ["共享"], "b");
      await works.push(await materials.scope(a.id, "共享"));
      await other.services.works.pull(await other.services.materials.scope(b.id, "共享"));
      expect((await other.services.materials.files(b.id, "共享")).map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
      expect((await other.services.materials.libraries(b.id))[0]).toMatchObject({ id: "共享", title: "大家的素材" });
      // Binned on one device: the branch is renamed on GitHub; the other device follows.
      await materials.remove(a.id, "共享");
      expect(await branches(remote)).toEqual(["materials-trash/共享"]);
      await other.services.repos.fetch(b.id);
      expect((await other.services.materials.libraries(b.id)).map((library) => library.id)).toEqual([]);
      expect((await other.services.materials.trash(b.id)).map((item) => item.key)).toEqual(["共享"]);
      expect(await branches(other.services.repos.dir(b.id))).toEqual(["materials-trash/共享"]);
    } finally {
      await other.close();
    }
  });
});
