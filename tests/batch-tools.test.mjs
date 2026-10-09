import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { importFromUrl } from "../server/tools/asset-tools.mjs";

describe("tools that save the AI calls", () => {
  let app, base, works, work, files;
  const tool = async (name, args) => {
    const response = await fetch(`${base}/api/tools/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) });
    return { status: response.status, body: await response.json() };
  };
  const read = (file) => fs.readFileSync(path.join(work.dir, file), "utf8");

  beforeAll(async () => {
    app = await createApp({ env: { FRAME_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "frame-batch-")), FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    works = app.services.works;
    work = await works.create({ title: "批量" });
    // A small web server standing in for the internet.
    files = http.createServer((req, res) => {
      if (req.url === "/a.png") return sharp({ create: { width: 4, height: 4, channels: 3, background: "#f00" } }).png().toBuffer().then((png) => res.end(png));
      if (req.url === "/moved") return res.writeHead(302, { location: "/a.png" }).end();
      res.writeHead(404).end();
    });
    await new Promise((resolve) => files.listen(0, "127.0.0.1", resolve));
  });
  afterAll(async () => {
    files.close();
    await app.close();
  });

  it("does what it can in a batch and says exactly what failed", async () => {
    fs.writeFileSync(path.join(work.dir, "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(work.dir, "b.ts"), "export const b = 1;\n");
    const result = await tool("files_batch", {
      work: work.id,
      operations: [
        { op: "edit", path: "a.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] },
        { op: "edit", path: "b.ts", edits: [{ oldText: "not there", newText: "x" }] },
        { op: "write", path: "b.ts", content: "skipped" },
        { op: "write", path: "c.ts", content: "export const c = 3;\n" },
        { op: "move", from: "c.ts", to: "lib/c.ts" },
        { op: "read", path: "lib/c.ts" },
        { op: "delete", path: "missing.ts" },
      ],
    });
    expect(result.status).toBe(200);
    expect(result.body.data.applied).toBe(true);
    expect(result.body.data.results.map((item) => item.status)).toEqual(["ok", "failed", "skipped", "ok", "ok", "ok", "failed"]);
    expect(result.body.text).toContain("完成 4 项，3 项没有完成");
    expect(result.body.text).toContain("✗ 2. edit b.ts：第 1 处替换找不到 oldText");
    expect(result.body.text).toContain("– 3. write b.ts：跳过：b.ts 前面的操作失败");
    expect(result.body.text).toContain("=== lib/c.ts");
    expect(result.body.text).toContain("export const c = 3;");
    expect(read("a.ts")).toBe("export const a = 2;\n");
    expect(read("b.ts")).toBe("export const b = 1;\n");
    expect(read("lib/c.ts")).toBe("export const c = 3;\n");
  });

  it("changes nothing in an atomic batch when one part fails, and reports a stale copy with the new hash", async () => {
    const before = read("a.ts");
    const atomic = await tool("files_batch", {
      work: work.id,
      atomic: true,
      operations: [
        { op: "edit", path: "a.ts", edits: [{ oldText: "a = 2", newText: "a = 3" }] },
        { op: "write", path: "b.ts", content: "x", expectedSha256: "stale" },
      ],
    });
    expect(atomic.body.data.applied).toBe(false);
    expect(atomic.body.text).toContain("所有改动都没有写入");
    expect(atomic.body.data.results[1]).toMatchObject({ status: "failed", currentSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(read("a.ts")).toBe(before);
    // Reads alone work on a published work; changes do not.
    await app.services.works.setPublished(work, true);
    expect((await tool("files_batch", { work: work.id, operations: [{ op: "read", path: "a.ts" }] })).status).toBe(200);
    expect((await tool("files_batch", { work: work.id, operations: [{ op: "delete", path: "a.ts" }] })).status).toBe(423);
    await app.services.works.setPublished(work, false);
  });

  it("imports several files at once, from the web or as base64, and keeps going past failures", async () => {
    const png = (await sharp({ create: { width: 2, height: 2, channels: 3, background: "#0f0" } }).png().toBuffer()).toString("base64");
    const url = `http://127.0.0.1:${files.address().port}`;
    const result = await tool("asset_import", {
      work: work.id,
      items: [{ url: `${url}/moved`, name: "red.png" }, { url: `${url}/nothing.png` }, { data: png, name: "green.png", license: "自己做的" }],
    });
    expect(result.body.data.map((item) => item.ok)).toEqual([true, false, true]);
    expect(result.body.text).toContain("完成 2 项，失败 1 项");
    expect(result.body.data[2]).toMatchObject({ path: "public/imports/green.png", url: `films/${work.slug}/imports/green.png`, kind: "image", width: 2 });
    expect(read("production/licenses.md")).toContain("public/imports/green.png: 自己做的");
    // A studio on the network never fetches private addresses for whoever asks (redirects included).
    await expect(importFromUrl(work, `${url}/a.png`, { publicOnly: true })).rejects.toMatchObject({ code: "PRIVATE_ADDRESS" });
    expect((await tool("asset_import", { work: work.id, data: "aGVsbG8=", name: "noext" })).body.error.message).toContain("带扩展名");
  });

  it("hands out one-time upload addresses for files on the AI's own computer", async () => {
    const link = await tool("upload_link", { work: work.id, files: [{ path: "public/up/clip.bin" }, { path: "logo.svg", library: "上传库" }] });
    expect(link.status).toBe(404); // the library does not exist yet
    await app.services.materials.create("local", "上传库");
    const links = (await tool("upload_link", { work: work.id, files: [{ path: "public/up/clip.bin", license: "CC0" }, { path: "logo.svg", library: "上传库" }] })).body.data.uploads;
    expect(links[0].command).toMatch(/^curl -fsS -T '<本机文件>' 'http:\/\/127\.0\.0\.1:\d+\/api\/uploads\/[\w-]+'$/);
    const put = (address, body) => fetch(address, { method: "PUT", body }).then(async (response) => ({ status: response.status, body: await response.json() }));
    const first = await put(links[0].url, "bytes");
    expect(first.body).toMatchObject({ ok: true, path: "public/up/clip.bin", url: `films/${work.slug}/up/clip.bin`, size: 5 });
    expect(read("public/up/clip.bin")).toBe("bytes");
    expect((await put(links[0].url, "again")).status).toBe(404); // used up
    expect((await put(links[1].url, "<svg/>")).body).toMatchObject({ ok: true, ref: "上传库/logo.svg" });
    expect((await tool("upload_link", { work: work.id, files: [{ path: "scene.ts" }] })).status).toBe(400);
  });

  it("reads several guide topics, experience documents and library files in one call", async () => {
    const guide = await tool("frame_guide", { topics: ["scene", "layers"] });
    expect(guide.body.text).toContain("---");
    expect(guide.body.data.topics).toEqual(["scene", "layers"]);
    await app.services.experience.create("local", "规范");
    await fetch(`${base}/api/works/local/${work.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ experiences: ["规范"] }) });
    await tool("experience_write", { work: work.id, operations: [{ op: "write", path: "节奏.md", content: "# 节奏\n\n- 快\n" }] });
    const docs = await tool("experience_read", { work: work.id, paths: ["README.md", "节奏.md", "没有.md"] });
    expect(docs.body.data.documents.map((item) => item.ok)).toEqual([true, true, false]);
    expect(docs.body.text).toContain("=== 节奏.md\n# 节奏");
    await tool("material_write", {
      work: work.id,
      library: "上传库",
      operations: [
        { op: "put", path: "a.json", content: "{}" },
        { op: "put", path: "b.txt", content: "b" },
        { op: "put", library: "没有", path: "c.txt", content: "c" },
      ],
    }).then((result) => {
      expect(result.body.data.map((item) => item.ok)).toEqual([true, true, false]);
      expect(result.body.text).toContain("新建用 materials_link 的 create");
    });
    const many = await tool("material_read", { work: work.id, paths: ["上传库/a.json", "上传库/b.txt"] });
    expect(many.body.text).toContain("=== materials/上传库/b.txt\nb");
  });

  it("searches the work, the libraries, the guide and the engine in one call", async () => {
    const { globTest } = await import("../server/tools/search-tools.mjs");
    expect(["a.ts", "scenes/b.ts", "scenes/x.md"].filter(globTest("*.ts"))).toEqual(["a.ts", "scenes/b.ts"]);
    expect(["a.ts", "scenes/b.ts", "scenes/deep/c.ts"].filter(globTest("scenes/**"))).toEqual(["scenes/b.ts", "scenes/deep/c.ts"]);
    fs.writeFileSync(path.join(work.dir, "a.ts"), "// 第一行\nexport const Glow = 1;\nconst other = Glow + 1;\n// 结尾\n");
    const found = await tool("search", { work: work.id, pattern: "glow", context: 1 });
    expect(found.body.text).toContain("a.ts\n  1- // 第一行\n  2: export const Glow = 1;\n  3: const other = Glow + 1;\n  4- // 结尾");
    expect(found.body.data.total).toBe(2);
    expect((await tool("search", { work: work.id, pattern: "glow", caseSensitive: true })).body.text).toContain("没有找到");
    // Several words, regex, other scopes.
    await app.services.materials.put("local", "上传库", "fx.ts", { content: "export function sparkle() {}\n" });
    const wide = await tool("search", { work: work.id, patterns: ["sparkle", "快"], scope: ["materials", "experience"] });
    expect(wide.body.text).toContain("materials/上传库/fx.ts");
    expect(wide.body.text).toContain("经验库 规范/节奏.md");
    expect((await tool("search", { work: work.id, pattern: "export (const|function) \\w+", regex: true, scope: ["work", "materials"], filesOnly: true })).body.text).toMatch(/a\.ts（1 处）[\s\S]*materials\/上传库\/fx\.ts（1 处）/);
    expect((await tool("search", { work: work.id, pattern: "assetUrl", scope: ["guide", "engine"], glob: "*.md", limit: 3 })).body.text).toContain("frame_guide");
    expect((await tool("search", { work: work.id, pattern: "(", regex: true })).status).toBe(400);
  });

  it("searches like grep: any text file, long lines, big files, whole words, across lines, locked versions", async () => {
    const w = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(work.dir, file)), { recursive: true });
      fs.writeFileSync(path.join(work.dir, file), text);
    };
    w("tools/build.py", "def render_frame():\n    pass\n"); // not a known extension: judged by content
    w("public/data.dat", Buffer.concat([Buffer.from("render_frame"), Buffer.alloc(10)])); // binary content
    w("anim.json", JSON.stringify({ layers: Array.from({ length: 400 }, (_, i) => ({ nm: i === 399 ? "深处的图层" : `layer${i}` })) })); // one long line
    w("big.txt", "x".repeat(1.5 * 1024 * 1024) + "\n大文件里的词\n");
    w("words.ts", "const spark = 1;\nconst sparkle = 2;\n// 火花效果和火花\n");
    w("multi.ts", "function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n");
    const run = (args) => tool("search", { work: work.id, ...args }).then((result) => result.body);

    const py = await run({ pattern: "render_frame" });
    expect(py.text).toContain("tools/build.py\n  1: def render_frame():");
    expect(py.text).not.toContain("data.dat");
    expect(py.text).toContain("1 个二进制文件");
    const deep = await run({ pattern: "深处的图层" });
    expect(deep.text).toMatch(/anim\.json\n {2}1: …[^\n]*深处的图层/);
    expect((await run({ pattern: "大文件里的词" })).text).toContain("big.txt");
    // Whole words (Chinese included), several file patterns, exclusions.
    expect((await run({ pattern: "spark", wholeWord: true })).data.total).toBe(1);
    expect((await run({ pattern: "火花", wholeWord: true, glob: "*.{ts,tsx}" })).data.total).toBe(0);
    expect((await run({ pattern: "spark", glob: ["*.ts", "*.py"], exclude: "words.*" })).text).toContain("没有找到");
    // Across lines, with separate before / after context and a per-file cap.
    const multi = await run({ pattern: "function \\w\\(\\) \\{\\n\\s+return 2", regex: true, multiline: true, before: 0, after: 1 });
    expect(multi.text).toContain("multi.ts\n  4: function b() {\n  5:   return 2;\n  6- }");
    expect(multi.data.files[0].matches).toEqual([{ line: 4, endLine: 5 }]);
    const capped = await run({ pattern: "return", maxPerFile: 1, context: 0 });
    expect(capped.data.files.find((item) => item.file === "multi.ts").matches).toHaveLength(1);
    expect(capped.text).toContain("只显示了");

    // "used": the library code at the version the work locked, not as the library is now.
    await app.services.materials.create("local", "代码库");
    await app.services.materials.put("local", "代码库", "fx.ts", { content: "export const version = 'old';\n" });
    w("uses.ts", 'import { version } from "@materials/代码库/fx";\n');
    await fetch(`${base}/api/works/local/${work.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ materials: ["上传库", "代码库"] }) });
    await app.services.materials.lockReferenced(work);
    await app.services.materials.put("local", "代码库", "fx.ts", { content: "export const version = 'new';\n" }, { replace: true });
    expect((await run({ pattern: "version =", scope: ["used"] })).text).toContain("materials/代码库/fx.ts（本作品锁定的版本）\n  1: export const version = 'old';");
    expect((await run({ pattern: "version =", scope: ["materials"], glob: "代码库/**" })).text).toContain("'new'");
  });

  it("shows assets as pictures and music as beats", async () => {
    const { ffmpegExecutable } = await import("../server/render.mjs");
    const publicDir = path.join(work.dir, "public", "look");
    fs.mkdirSync(publicDir, { recursive: true });
    await sharp({ create: { width: 64, height: 32, channels: 3, background: "#0a0" } }).png().toFile(path.join(publicDir, "green.png"));
    fs.writeFileSync(path.join(publicDir, "mark.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8" fill="red"/></svg>');
    // A drum loop at 120 BPM: a low thump on every beat from 0.25 s.
    const rate = 22050;
    const samples = new Int16Array(rate * 12);
    for (let beat = 0.25; beat < 12; beat += 0.5)
      for (let i = 0; i < 0.12 * rate; i++) {
        const at = Math.round(beat * rate) + i;
        if (at < samples.length) samples[at] += Math.round(20000 * Math.exp(-i / (0.03 * rate)) * Math.sin((2 * Math.PI * 70 * i) / rate));
      }
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + samples.length * 2, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(samples.length * 2, 40);
    fs.writeFileSync(path.join(publicDir, "drums.wav"), Buffer.concat([header, Buffer.from(samples.buffer)]));

    const one = await tool("asset_view", { work: work.id, files: [`films/${work.slug}/look/green.png`] });
    expect(one.body.images).toHaveLength(1);
    expect(one.body.text).toContain("图片 64×32");
    const sheet = await tool("asset_view", { work: work.id, files: ["public/look/green.png", "public/look/mark.svg", "public/look/drums.wav"] });
    expect(sheet.body.text).toContain("#2 public/look/mark.svg");
    expect(sheet.body.text).toContain("没有画面的文件");
    expect((await sharp(Buffer.from(sheet.body.images[0].data, "base64")).metadata()).width).toBeGreaterThan(480);
    expect((await tool("asset_view", { work: work.id, files: ["films/other-work/a.png"] })).status).toBe(400);
    if (ffmpegExecutable()) {
      const music = await tool("preview_audio", { work: work.id, src: `films/${work.slug}/look/drums.wav`, beats: true });
      expect(music.status).toBe(200);
      expect(Math.abs(music.body.data.rhythm.bpm - 120)).toBeLessThan(3);
      const beats = music.body.data.rhythm.beats;
      expect(beats.length).toBeGreaterThan(18);
      for (const time of beats) expect(Math.abs(((time - 0.25 + 0.25) % 0.5) - 0.25)).toBeLessThan(0.03);
      expect(music.body.text).toContain("节奏约");
    }
  });

  it("reads documents compactly, edits parts and says where things are", async () => {
    const layers = await tool("layers_get", { work: work.id });
    expect(layers.body.text).toMatch(/\n {2}\{"id":"title"/);
    expect(layers.body.text).not.toContain('"rate":1');
    fs.mkdirSync(path.join(work.dir, "public"), { recursive: true });
    fs.writeFileSync(path.join(work.dir, "public", "hit.wav"), fs.readFileSync(path.join(work.dir, "public", "look", "drums.wav")));
    const placed = await tool("audio_place", { work: work.id, src: "public/hit.wav", start: 1, duration: 1 });
    const clip = placed.body.data.clip.id;
    expect(placed.body.text).toContain(`片段 ${clip}`);
    expect(placed.body.data.clip.source).toBeDefined();
    await tool("audio_edit", { work: work.id, operations: [{ op: "update", collection: "clips", id: clip, patch: { gain: 0.5 } }] });
    const mix = await tool("audio_get", { work: work.id });
    expect(mix.body.text).toContain(`"id":"${clip}"`);
    expect(mix.body.text).toContain('"gain":0.5');
    expect(mix.body.text).not.toContain('"pan":0');
    expect(mix.body.text).toContain(`films/${work.slug}/hit.wav`);

    // work_context: exports, publishing and GitHub (a local repository has none).
    const context = await tool("work_context", { work: work.id });
    expect(context.body.data.work).toMatchObject({ published: false, github: null });
    expect(context.body.data.exports).toEqual([]);
    expect(context.body.data.warnings).toBeUndefined();

    // A download address serves one file, without a login, for a while.
    const file = path.join(work.dir, "public", "hit.wav");
    const link = app.services.downloads.link(file, "成片.wav");
    const response = await fetch(link.url.replace(/^https?:\/\/[^/]+/, base));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(encodeURIComponent("成片.wav"));
    expect(Buffer.from(await response.arrayBuffer()).equals(fs.readFileSync(file))).toBe(true);
    expect((await fetch(`${base}/api/downloads/nope`)).status).toBe(404);
  });
});
