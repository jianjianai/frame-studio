import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
