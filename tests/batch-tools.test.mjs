import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { importFromUrl } from "../server/tools/asset-tools.mjs";
import { browserExecutable } from "../server/render.mjs";

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
    // A drum loop at 120 BPM from 0.25 s: kick and snare on alternate beats, hi-hats on eighths.
    const rate = 22050;
    const samples = new Int16Array(rate * 12);
    let seed = 7;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const add = (at, value) => at < samples.length && (samples[at] = Math.max(-32767, Math.min(32767, samples[at] + Math.round(value * 32767))));
    for (let beat = 0.25, k = 0; beat < 12; beat += 0.5, k++) {
      const s = Math.round(beat * rate);
      for (let i = 0; i < 0.15 * rate; i++)
        add(s + i, k % 2 ? 0.4 * Math.exp(-i / (0.03 * rate)) * noise() : 0.7 * Math.exp(-i / (0.04 * rate)) * Math.sin((2 * Math.PI * (55 + 80 * Math.exp(-i / (0.01 * rate))) * i) / rate));
      for (const hat of [s, s + Math.round(0.25 * rate)]) for (let i = 0; i < 0.03 * rate; i++) add(hat + i, 0.12 * Math.exp(-i / (0.006 * rate)) * noise());
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
      if (process.env.FRAME_BEAT_PYTHON) {
        expect(music.status).toBe(200);
        expect(Math.abs(music.body.data.rhythm.bpm - 120)).toBeLessThan(3);
        const beats = music.body.data.rhythm.beats;
        expect(beats.length).toBeGreaterThan(18);
        for (const time of beats) expect(Math.abs((time % 0.5) - 0.25)).toBeLessThan(0.05);
        expect(music.body.text).toContain("小节第一拍");
      } else {
        // Without Beat This! installed the AI is told what is missing.
        expect(music.status).toBe(503);
        expect(music.body.error.code).toBe("NO_BEAT_THIS");
      }
    }
  });

  it("derives tempo and meter from beats and downbeats", async () => {
    const { describeRhythm } = await import("../server/audio-analysis.mjs");
    const beats = Array.from({ length: 13 }, (_, index) => 0.5 + index * 0.5);
    const rhythm = describeRhythm(beats, [0.5, 2, 3.5, 5, 6.5]);
    expect(rhythm).toMatchObject({ bpm: 120, beatsPerBar: 3 });
    expect(describeRhythm([], [])).toMatchObject({ bpm: null, beatsPerBar: null });
  });

  it("tells which tracks are heard and whether the voice stands out", async () => {
    const { voiceBalance } = await import("../server/audio-analysis.mjs");
    const { audibleTracks } = await import("../server/tools/preview-tools.mjs");
    // Tracks heard in 0–10 s: the music, and speech by its files (public/voice/) though its name says nothing.
    const meta = {
      visual: { clips: [] },
      audioDocument: {
        schemaVersion: 1,
        sources: [
          { id: "m", kind: "file", src: "films/x/music/a.mp3" },
          { id: "v", kind: "file", src: "films/x/voice/b.mp3" },
          { id: "e", kind: "file", src: "films/x/rain.mp3" },
        ],
        tracks: [{ id: "t1", name: "音乐" }, { id: "t2", name: "Track 2" }, { id: "t3", name: "环境" }],
        clips: [
          { id: "c1", track: "t1", source: "m", start: 0, duration: 10 },
          { id: "c2", track: "t2", source: "v", start: 2, duration: 3 },
          { id: "c3", track: "t3", source: "e", start: 20, duration: 5 },
        ],
      },
    };
    expect(audibleTracks(meta, 0, 10)).toEqual([
      { id: "t1", name: "音乐", voice: false },
      { id: "t2", name: "Track 2", voice: true },
    ]);
    const windows = (...levels) => levels.map((rmsDb, index) => ({ time: index, rmsDb }));
    // Voice 12 dB over the music where it speaks; silent windows do not count.
    expect(voiceBalance([{ voice: true, windows: windows(-80, -12, -12) }, { voice: false, windows: windows(-24, -24, -24) }], 0.5)).toEqual({ seconds: 1, differenceDb: 12 });
    expect(voiceBalance([{ voice: false, windows: windows(-10) }], 0.5)).toBeNull();
  });

  it.skipIf(!browserExecutable())("measures each track of the mix, and a change counts at once", async () => {
    const src = `films/${work.slug}/look/drums.wav`;
    await tool("audio_place", { work: work.id, src, track: "音乐", start: 0, duration: 2 });
    await tool("audio_place", { work: work.id, src, track: "配音", start: 0, duration: 2, gain: 0.1 });
    const first = await tool("preview_audio", { work: work.id, start: 0, duration: 2 });
    expect(first.body.text).toContain("「配音」（人声）");
    expect(first.body.text).toMatch(/人声比其他声音还低 \d+(\.\d+)? dB，会被盖住/);
    // Lower the music and measure straight away: the new mix, not the old one of a warm page.
    const audio = JSON.parse(fs.readFileSync(path.join(work.dir, "audio.json"), "utf8"));
    const musicTrack = audio.tracks.find((track) => track.name === "音乐").id;
    const music = audio.clips.find((clip) => clip.track === musicTrack);
    await tool("audio_edit", { work: work.id, operations: [{ op: "update", collection: "clips", id: music.id, patch: { gain: 0.01 } }] });
    const second = await tool("preview_audio", { work: work.id, start: 0, duration: 2 });
    expect(second.body.text).toMatch(/人声比其他声音响 \d+(\.\d+)? dB，听得清/);
    expect(second.body.data.overall.rmsDb).toBeLessThan(first.body.data.overall.rmsDb);
  }, 120000);

  it("shows the file's own text when an edit misses by quotes or whitespace", async () => {
    const { nearMiss } = await import("../server/tools/file-ops.mjs");
    const code = 'export function createScene(options) {\n  return make(options, {\n    title: () => import("./title"),\n  });\n}\n';
    expect(nearMiss(code, "title: () => import('./title'),", "files_batch")).toContain('引号或空白和文件不一样。文件第 3 行起实际是：\ntitle: () => import("./title"),');
    expect(nearMiss(code, "return make(options, {\ntitle", "files_batch")).toContain("空白（缩进、换行）和文件不一样。文件第 2 行起实际是：\nreturn make(options, {\n    title");
    expect(nearMiss(code, "return make(options, {\n    subtitle", "files_batch")).toContain("第一行出现在第 2 行，但后面的内容不同。文件第 2–3 行是：");
    expect(nearMiss(code, "nothing like it", "files_batch")).toContain("先用 files_batch 读取最新内容");
  });

  it("names the allowed fields when a call has an unknown one", async () => {
    const { describeIssues } = await import("../server/tools/registry.mjs");
    const { z } = await import("zod");
    const schema = z.strictObject({
      operations: z.array(z.union([z.strictObject({ op: z.literal("add"), clip: z.strictObject({ transform: z.strictObject({ x: z.number().optional(), opacity: z.number().optional() }).optional() }) }), z.strictObject({ op: z.literal("remove"), id: z.string() })])),
    });
    const parsed = schema.safeParse({ operations: [{ op: "add", clip: { transform: { scale: 2 } } }] });
    expect(describeIssues(parsed.error.issues, schema)).toBe("operations.0.clip.transform: 不认识的字段 scale（可用：x、opacity）");
    const layers = await tool("layers_edit", { work: work.id, operations: [{ op: "update", id: "title", patch: { transform: { skew: 1.2 } } }] });
    expect(layers.body.error.message).toMatch(/不认识的字段 skew（可用：x、y、width、height、rotation、scale、opacity）/);
  });

  it("finds the exact tempo of each steady stretch from beats on the model's 20 ms grid", async () => {
    const { tempoSegments, loudnessStretches } = await import("../server/audio-analysis.mjs");
    const { rhythmText } = await import("../server/tools/preview-tools.mjs");
    const on20ms = (time) => Math.round(time * 50) / 50;
    // 118 BPM for 120 beats (one missed), then 98 BPM.
    const slow = Array.from({ length: 120 }, (_, k) => on20ms(0.04 + k * (60 / 118))).filter((_, k) => k !== 50);
    const end = 0.04 + 119 * (60 / 118);
    const beats = [...slow, ...Array.from({ length: 30 }, (_, k) => on20ms(end + (k + 1) * (60 / 98)))];
    const segments = tempoSegments(beats);
    expect(segments).toHaveLength(2);
    expect(Math.abs(segments[0].bpm - 118)).toBeLessThan(0.1);
    expect(Math.abs(segments[1].bpm - 98)).toBeLessThan(0.3);
    expect(segments[0].maxError).toBeLessThan(0.03);
    const text = rhythmText({ beats, downbeats: [0.04, 2.07], beatsPerBar: 4, segments }, { file: false }).join("\n");
    expect(text).toContain("中途变速，分 2 段");
    expect(text).toMatch(/tempo: \{ bpm: 11[78](\.\d+)?, firstBeat: 0\.0\d, beatsPerBar: 4 \}/);
    expect(text).toContain("主段以外的节拍 30 个");
    // A steady song: the grid, no list of every beat.
    const steady = tempoSegments(slow.slice(0, 60));
    expect(rhythmText({ beats: slow.slice(0, 60), downbeats: [0.04], beatsPerBar: 4, segments: steady }, { file: true }).join("\n")).not.toContain("节拍 59 个");
    // Loudness: similar windows merge, a drop starts a new stretch, silence is its own.
    const windows = [-8, -8.5, -7.9, -12, -12.4, -80, -80].map((rmsDb, index) => ({ time: index, rmsDb, peakDb: rmsDb + 6 }));
    expect(loudnessStretches(windows, 1).map((item) => [item.start, item.end, item.silent])).toEqual([
      [0, 3, false],
      [3, 5, false],
      [5, 7, true],
    ]);
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
