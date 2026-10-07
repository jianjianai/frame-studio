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
    await tool("experience_write", { work: work.id, path: "节奏.md", content: "# 节奏\n\n- 快\n" });
    const docs = await tool("experience_read", { work: work.id, paths: ["README.md", "节奏.md", "没有.md"] });
    expect(docs.body.data.documents.map((item) => item.ok)).toEqual([true, true, false]);
    expect(docs.body.text).toContain("=== 节奏.md\n# 节奏");
    await tool("material_write", { work: work.id, items: [{ library: "上传库", path: "a.json", content: "{}" }, { library: "上传库", path: "b.txt", content: "b" }, { library: "没有", path: "c.txt", content: "c" }] }).then(
      (result) => expect(result.body.data.map((item) => item.ok)).toEqual([true, true, false]),
    );
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
});
