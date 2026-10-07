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

  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-materials-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    ({ materials, works } = app.services);
  });
  afterAll(() => app.close());

  it("keeps libraries as folders with every change saved as a version", async () => {
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
    expect((await call(`${lib}/history`)).body.map((version) => version.message).slice(0, 2)).toEqual(["素材库「品牌」：添加 logo.svg", "新建素材库：品牌"]);
    expect((await call(`${lib}/status`)).body.files).toEqual([]);
    expect((await call(`${lib}/libraries`)).body).toEqual([{ id: "品牌", title: "品牌", files: 1, size: 13 }]);
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
    expect(status.files).toMatchObject([{ ref: "品牌/logo.svg", used: true, outdated: true }]);
    expect((await call(`${route}/materials/lock`, { method: "POST", body: { update: true } })).body.locked).toEqual(["品牌/logo.svg"]);
    expect((await call(asset)).body).toBe("<svg>v2</svg>");

    // References only in code are locked when a version is saved; the lock file is part of it.
    await call(`${lib}/libraries/${encodeURIComponent("品牌")}/upload?path=bg.svg`, { method: "POST", raw: "<svg>bg</svg>" });
    fs.writeFileSync(path.join(work.dir, "scene.ts"), fs.readFileSync(path.join(work.dir, "scene.ts"), "utf8") + '\n// assetUrl("materials/品牌/bg.svg")\n');
    await works.commit(work, "用背景");
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(work.dir, "materials.lock.json"), "utf8")))).toEqual(["品牌/bg.svg", "品牌/logo.svg"]);
    expect((await works.status(work)).files).toEqual([]);

    // Deleting the file from the library leaves the work its locked version.
    await call(`${lib}/libraries/${encodeURIComponent("品牌")}/file?path=bg.svg`, { method: "DELETE" });
    expect((await call(`/files/local/${work.id}/materials/${encodeURIComponent("品牌")}/bg.svg`)).body).toBe("<svg>bg</svg>");
    const check = await app.services.checks.get?.(`local/${work.id}`);
    expect(check ?? null).toBeNull(); // no check stored yet: nothing to assert here
  });

  it("lets the AI link libraries, add files and use them", async () => {
    const work = (await call("/api/works", { method: "POST", body: { title: "AI 用素材" } })).body;
    expect((await tool("materials_use", { work: work.id, files: ["品牌/logo.svg"] })).body.error.message).toContain("没有引用这些素材库");
    const linked = await tool("materials_link", { work: work.id, add: ["品牌"], create: ["音效"] });
    expect(linked.body.data.materials).toEqual(["品牌", "音效"]);
    const written = await tool("material_write", { work: work.id, library: "音效", path: "notes/readme.txt", content: "说明" });
    expect(written.body.data).toMatchObject({ ref: "音效/notes/readme.txt", url: "materials/音效/notes/readme.txt" });
    const used = await tool("materials_use", { work: work.id, files: ["音效/notes/readme.txt"] });
    expect(used.body.text).toContain("materials/音效/notes/readme.txt");
    const opened = await app.services.openWork(work.id, "local");
    expect(materials.readLocks(opened.dir)).toHaveProperty(["音效/notes/readme.txt"]);
    const list = await tool("materials_list", { work: work.id });
    expect(list.body.data.libraries.map((item) => [item.id, item.referenced])).toEqual([
      ["品牌", true],
      ["音效", true],
    ]);
    expect((await tool("materials_list", { work: work.id, library: "音效" })).body.data).toMatchObject([{ path: "notes/readme.txt", locked: "已锁定" }]);
    expect((await tool("material_move", { work: work.id, library: "音效", from: "notes/readme.txt", to: "readme.txt" })).status).toBe(200);
    expect((await tool("material_delete", { work: work.id, library: "音效", path: "README.md" })).status).toBe(400);
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
    const edited = await tool("material_edit", { work: work.id, library: "特效", path: "noise.ts", edits: [{ oldText: "n + 100", newText: "n * 3" }] });
    expect(edited.status).toBe(200);
    expect((await tool("material_read", { work: work.id, library: "特效", path: "noise.ts" })).body.text).toContain("n * 3");
    fs.appendFileSync(scene, 'import "@materials/特效/missing";\n');
    const missing = await checkWork(app.services, work, { runtime: false });
    expect(missing.problems.map((problem) => problem.message)).toContain("素材库里没有 @materials/特效/missing（scene.ts 导入）");
  });

  it("syncs libraries through the repository's materials branch", async () => {
    process.env.FRAME_ALLOW_FILE_REMOTES = "1";
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "frame-remote-")) + "/works.git";
    await git(os.tmpdir(), ["init", "--bare", "--initial-branch=main", remote]);
    const other = await createApp({ env: { FRAME_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "frame-materials-b-")), FRAME_PORT: "0" }, plugins });
    try {
      const a = await app.services.repos.clone({ url: "file://" + remote });
      const b = await other.services.repos.clone({ url: "file://" + remote });
      await materials.create(a.id, "共享");
      await materials.put(a.id, "共享", "a.txt", { content: "from a" });
      await works.push(await materials.scope(a.id));
      await other.services.works.pull(await other.services.materials.scope(b.id));
      expect((await other.services.materials.files(b.id, "共享")).map((file) => file.path)).toEqual(["a.txt"]);
    } finally {
      await other.close();
    }
  });
});
