import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { readJson, sendFile } from "../http.mjs";
import { writeStream, uniquePath, contentVersion } from "../files.mjs";
import { checkWork } from "../checks.mjs";
import { placeAudio, readVisual, editVisual, readAudio, editAudio } from "../documents.mjs";
import { probe } from "../media.mjs";
import { listAssets } from "../tools/work-tools.mjs";
import { importFromUrl } from "../tools/asset-tools.mjs";
import { describeIssues } from "../tools/registry.mjs";
import { problem, sha256, confined, mimeType } from "../util.mjs";

/** Studio-facing routes for exports, assets, documents, checks, tasks and tokens. */
export function studioRoutes(services) {
  const { router, exports, tasks, events, settings, config } = services;
  const open = (params) => services.openWork(params.id, params.repo);

  // ---- checks -------------------------------------------------------------
  router.post("/api/works/:repo/:id/check", async ({ params, req }) => checkWork(services, await open(params), await readJson(req)));
  router.get("/api/works/:repo/:id/check", async ({ params }) => services.checks.get(`${params.repo}/${params.id}`) || null);

  // ---- assets -------------------------------------------------------------
  /** Everything playback may load: the browser precaches these and refreshes changed ones by ETag. */
  router.get("/api/works/:repo/:id/precache", async ({ params }) => {
    const work = await open(params);
    const root = path.join(work.dir, "public");
    const found = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) found.push(full);
      }
    };
    walk(root);
    const files = [];
    for (let index = 0; index < found.length; index += 4)
      files.push(
        ...(await Promise.all(
          found.slice(index, index + 4).map(async (full) => {
            const stat = fs.statSync(full);
            return { path: path.relative(root, full).split(path.sep).join("/"), size: stat.size, version: await contentVersion(full, stat) };
          }),
        )),
      );
    // Same base as the preview's asset URLs (Renderer.sourceOf / the stage query).
    return { base: `/files/${work.repo}/${work.id}/films/${work.slug}/`, files };
  });

  /**
   * Many small files in one response, so high-latency links pay one round trip
   * instead of one per file. Framing per file: u32 header length, JSON header
   * { path, size, version, type }, then exactly `size` bytes.
   */
  router.post("/api/works/:repo/:id/precache/bundle", async ({ params, req, res }) => {
    const work = await open(params);
    const { paths } = await readJson(req);
    if (!Array.isArray(paths) || !paths.length || paths.length > 1000) throw problem(400, "paths 必须是 1–1000 个文件");
    const root = path.join(work.dir, "public");
    const files = paths.map((relative) => {
      const file = confined(root, String(relative));
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      if (!stat?.isFile()) throw problem(404, "文件不存在：" + relative, "NOT_FOUND");
      return { relative: String(relative), file, stat };
    });
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
    const write = (chunk) => (res.write(chunk) ? undefined : new Promise((resolve) => res.once("drain", resolve)));
    for (const { relative, file, stat } of files) {
      const header = Buffer.from(JSON.stringify({ path: relative, size: stat.size, version: await contentVersion(file, stat), type: mimeType(file) }));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(header.length);
      await write(Buffer.concat([length, header]));
      let sent = 0;
      for await (const chunk of fs.createReadStream(file, { start: 0, end: Math.max(0, stat.size - 1) })) {
        if (!stat.size) break;
        // The header promised stat.size bytes; a file growing meanwhile must not break the framing.
        const part = chunk.subarray(0, stat.size - sent);
        sent += part.length;
        await write(part);
        if (sent >= stat.size) break;
      }
      if (sent < stat.size) await write(Buffer.alloc(stat.size - sent));
    }
    res.end();
  });

  router.get("/api/works/:repo/:id/assets", async ({ params }) => listAssets(await open(params)));
  router.post("/api/works/:repo/:id/assets/import", async ({ params, req }) => {
    const work = await services.openEditable(params.id, params.repo);
    const body = await readJson(req);
    if (!body.url) throw problem(400, "需要 url");
    const relative = await importFromUrl(work, body.url, { name: body.name });
    events.emit({ type: "assets", work: work.id, repo: work.repo });
    return { path: relative, url: `films/${work.slug}/${relative.replace(/^public\//, "")}`, ...(await probe(path.join(work.dir, relative))) };
  });
  /** Microphone recordings: body is the recorded file; placed on the "录音" track at `start`. */
  router.post(
    "/api/works/:repo/:id/recordings",
    async ({ params, req, query }) => {
      const work = await services.openEditable(params.id, params.repo);
      const ext =
        { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav", "audio/mpeg": "mp3" }[
          String(req.headers["content-type"]).split(";")[0]
        ] || "webm";
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
      const relative = uniquePath(work.dir, `public/recordings/recording-${stamp}.${ext}`);
      await writeStream(work.dir, relative, req, { limit: 512 * 1024 * 1024 });
      const info = await probe(path.join(work.dir, relative));
      const src = `films/${work.slug}/${relative.replace(/^public\//, "")}`;
      const start = Math.max(0, Number(query.start) || 0);
      const placed = placeAudio(work, { src, start, duration: info.duration, trackName: query.track || "录音", name: query.name || "录音" });
      events.emit({ type: "assets", work: work.id, repo: work.repo });
      return { path: relative, src, duration: info.duration, clip: placed.clip };
    },
    { raw: true },
  );

  // ---- documents ------------------------------------------------------------
  router.get("/api/works/:repo/:id/layers", async ({ params }) => readVisual(await open(params)));
  // Materials placed in a document are locked at their current version right away; an
  // invalid document is the caller's mistake (400 with the rules it broke).
  const placed = async (work, edit) => {
    let result;
    try {
      result = edit();
    } catch (error) {
      if (error.name === "ZodError") throw problem(400, "内容无效：" + describeIssues(error.issues), "INVALID_CONTENT");
      throw error;
    }
    await services.materials?.lockReferenced(work);
    return result;
  };
  router.post("/api/works/:repo/:id/layers", async ({ params, req }) => {
    const work = await services.openEditable(params.id, params.repo);
    const body = await readJson(req);
    return placed(work, () => editVisual(work, body));
  });
  router.get("/api/works/:repo/:id/audio", async ({ params }) => readAudio(await open(params)));
  router.post("/api/works/:repo/:id/audio", async ({ params, req }) => {
    const work = await services.openEditable(params.id, params.repo);
    const body = await readJson(req);
    return placed(work, () => editAudio(work, body));
  });
  router.post("/api/works/:repo/:id/audio/place", async ({ params, req }) => {
    const body = await readJson(req);
    const work = await services.openEditable(params.id, params.repo);
    let duration = body.duration;
    if (!duration) {
      // Dropped without a known length (a material library file): measure it.
      const material = /^materials\/(.+)$/.exec(String(body.src || ""));
      const file = material
        ? await services.materials.file(work.repo, services.materials.readLocks(work.dir), material[1])
        : path.join(work.dir, "public", String(body.src || "").replace(/^films\/[^/]+\//, ""));
      duration = (await probe(file).catch(() => ({}))).duration;
    }
    return placed(work, () => placeAudio(work, { src: body.src, start: body.start, duration, trackName: body.track, name: body.name }));
  });

  // ---- exports --------------------------------------------------------------
  router.get("/api/works/:repo/:id/exports", async ({ params }) => exports.list(await open(params)));
  router.post("/api/works/:repo/:id/exports", async ({ params, req }) => exports.start(await open(params), await readJson(req)));
  router.get("/api/works/:repo/:id/exports/:name", async ({ params, req, res, query }) => {
    const file = exports.file(await open(params), params.name);
    if (query.download === "1") res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(params.name)}`);
    sendFile(req, res, file);
  });
  router.delete("/api/works/:repo/:id/exports/:name", async ({ params }) => exports.remove(await open(params), params.name));

  // ---- tasks ----------------------------------------------------------------
  router.get("/api/tasks", ({ query }) => tasks.list({ work: query.work }));
  router.post("/api/tasks/:id/cancel", ({ params }) => tasks.cancel(params.id));

  // ---- MCP tokens (for external AI clients) ---------------------------------
  router.get("/api/mcp/tokens", () => settings.get("mcp").tokens.map(({ hash, ...token }) => token));
  router.post("/api/mcp/tokens", async ({ req }) => {
    const body = await readJson(req);
    const token = "fs_" + randomBytes(24).toString("base64url");
    const entry = {
      id: randomUUID(),
      name: String(body.name || "MCP").slice(0, 60),
      readOnly: Boolean(body.readOnly),
      createdAt: new Date().toISOString(),
      hash: sha256(token),
    };
    settings.update("mcp", (mcp) => ({ ...mcp, tokens: [...mcp.tokens, entry] }));
    return { ...entry, hash: undefined, token };
  });
  router.delete("/api/mcp/tokens/:id", ({ params }) =>
    settings.update("mcp", (mcp) => ({ ...mcp, tokens: mcp.tokens.filter((token) => token.id !== params.id) })),
  );
}
