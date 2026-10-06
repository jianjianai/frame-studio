import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../server/app.mjs";
import { plugins } from "../server/plugins.mjs";
import { readProjectSource } from "../server/project-meta.mjs";

describe("work covers", () => {
  let app, base, works, covers;
  const rendered = [];
  const events = [];
  const call = async (route, { method = "GET", body, raw, type } = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: raw ? { "Content-Type": type || "application/octet-stream" } : body ? { "Content-Type": "application/json" } : {},
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const contentType = response.headers.get("content-type") || "";
    return {
      status: response.status,
      headers: response.headers,
      body: contentType.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()),
    };
  };
  const listed = async (id) => (await call("/api/works")).body.find((item) => item.id === id);
  const meta = (work) => readProjectSource(fs.readFileSync(path.join(work.dir, "project.ts"), "utf8")).meta;
  const png = (color) => sharp({ create: { width: 160, height: 90, channels: 3, background: color } }).png().toBuffer();

  beforeAll(async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "frame-covers-"));
    app = await createApp({ env: { FRAME_HOME: home, FRAME_PORT: "0" }, plugins });
    base = await app.listen();
    ({ works, covers } = app.services);
    // No browser in tests: the renderer hands back a plain frame and records what was asked.
    app.services.renderer.cover = async (work, { time }) => {
      rendered.push({ id: work.id, time });
      if (works.meta(work).meta?.title === "坏") throw new Error("作品无法加载");
      return { png: await png("#c0392b"), time: time ?? 4.2 };
    };
    app.services.events.subscribe((event) => event.type === "work-cover" && events.push(event));
  });
  afterAll(() => app.close());

  it("makes a missing or stale cover in the background and serves it by version", async () => {
    const work = await works.create({ title: "封面" });
    expect(meta(work).poster).toBeUndefined();
    expect(fs.existsSync(path.join(work.dir, "public", "poster.svg"))).toBe(false);

    expect((await listed(work.id)).cover).toBe("");
    await covers.queue;
    const first = (await listed(work.id)).cover;
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(events.at(-1)).toMatchObject({ repo: "local", work: work.id, cover: first });
    expect(rendered.filter((item) => item.id === work.id)).toEqual([{ id: work.id, time: undefined }]);

    const image = await call(`/api/works/local/${work.id}/cover?v=${first}`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/webp");
    expect(image.headers.get("cache-control")).toContain("immutable");
    expect((await sharp(image.body).metadata()).width).toBe(160);

    // Nothing changed: no new rendering. A changed file: a new cover, the old one meanwhile.
    await listed(work.id);
    await covers.queue;
    expect(rendered.filter((item) => item.id === work.id)).toHaveLength(1);
    fs.appendFileSync(path.join(work.dir, "scene.ts"), "\n// 改动\n");
    expect((await listed(work.id)).cover).toBe(first);
    await covers.queue;
    expect((await listed(work.id)).cover).not.toBe(first);
    expect((await call(`/api/works/local/${work.id}/cover/state`)).body).toMatchObject({ mode: "auto", time: 4.2, updating: false, error: "" });
  });

  it("uses a chosen frame, an uploaded image, or picks automatically again", async () => {
    const work = await works.create({ title: "选封面", duration: 10 });
    const route = `/api/works/local/${work.id}/cover`;
    const chosen = await call(`${route}/frame`, { method: "POST", body: { time: 3.5 } });
    expect(chosen.body).toMatchObject({ mode: "time" });
    expect(meta(work)).toMatchObject({ posterTime: 3.5 });
    await covers.queue;
    expect(rendered.at(-1)).toEqual({ id: work.id, time: 3.5 });
    // Past the end is the last frame.
    await call(`${route}/frame`, { method: "POST", body: { time: 99 } });
    expect(meta(work).posterTime).toBeCloseTo(10 - 1 / 30, 3);
    await covers.queue;

    const uploaded = await call(`${route}/image`, { method: "POST", raw: await png("#2980b9"), type: "image/png" });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.mode).toBe("image");
    expect(meta(work).poster).toBe(`films/${work.slug}/poster.webp`);
    expect(meta(work).posterTime).toBeUndefined();
    expect((await sharp(path.join(work.dir, "public", "poster.webp")).metadata()).format).toBe("webp");
    const calls = rendered.length;
    await covers.queue;
    expect(rendered.length).toBe(calls); // an image needs no rendering
    expect(covers.info("local", work.id)).toMatchObject({ kind: "image" });
    const means = (await sharp((await call(`${route}?v=${(await listed(work.id)).cover}`)).body).stats()).channels.map((c) => c.mean);
    [41, 128, 185].forEach((value, index) => expect(Math.abs(means[index] - value)).toBeLessThan(4));

    expect((await call(`${route}/image`, { method: "POST", raw: Buffer.from("not an image") })).status).toBe(400);

    const automatic = await call(route, { method: "DELETE" });
    expect(automatic.body.mode).toBe("auto");
    expect(meta(work).poster).toBeUndefined();
    expect(meta(work).posterTime).toBeUndefined();

    // The AI sets the cover frame with work_update.
    await call("/api/tools/work_update", { method: "POST", body: { work: work.id, posterTime: 2 } });
    expect(meta(work).posterTime).toBe(2);
  });

  it("keeps the last cover when making a new one fails, and refuses changes to published works", async () => {
    const work = await works.create({ title: "坏" });
    await listed(work.id);
    await covers.queue;
    const state = (await call(`/api/works/local/${work.id}/cover/state`)).body;
    expect(state).toMatchObject({ cover: "", updating: false });
    expect(state.error).toContain("作品无法加载");
    // The failed attempt is remembered: listing again does not retry until the work changes.
    const calls = rendered.length;
    await listed(work.id);
    await covers.queue;
    expect(rendered.length).toBe(calls);

    const published = await works.create({ title: "已发布" });
    await call(`/api/works/local/${published.id}/publish`, { method: "POST" });
    expect((await call(`/api/works/local/${published.id}/cover/frame`, { method: "POST", body: { time: 1 } })).status).toBe(423);
    expect((await call(`/api/works/local/${published.id}/cover`, { method: "DELETE" })).status).toBe(423);
    // Its automatic cover is still made (nothing in the work changes).
    await listed(published.id);
    await covers.queue;
    expect((await listed(published.id)).cover).toMatch(/^[0-9a-f]{16}$/);

    covers.forget("local", published.id);
    expect((await listed(published.id)).cover).toBe("");
  });

  it("reads cached covers only of real repositories and work ids", async () => {
    fs.writeFileSync(path.join(app.services.config.home, "secret.json"), JSON.stringify({ key: "k" }));
    fs.writeFileSync(path.join(app.services.config.home, "secret.webp"), "x");
    expect((await call(`/api/works/local/${encodeURIComponent("../../secret")}/cover`)).status).toBe(404);
    expect((await call(`/api/works/${encodeURIComponent("../..")}/secret/cover`)).status).toBe(404);
    expect(() => covers.file("local", "../x")).toThrow();
  });
});
