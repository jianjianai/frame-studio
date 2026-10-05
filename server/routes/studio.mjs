import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { readJson, sendFile } from "../http.mjs";
import { writeStream, uniquePath } from "../files.mjs";
import { checkWork } from "../checks.mjs";
import { placeAudio, readVisual, editVisual, readAudio, editAudio } from "../documents.mjs";
import { probe } from "../media.mjs";
import { listAssets } from "../tools/work-tools.mjs";
import { importFromUrl } from "../tools/asset-tools.mjs";
import { problem, sha256 } from "../util.mjs";

/** Studio-facing routes for exports, assets, documents, checks, tasks and tokens. */
export function studioRoutes(services) {
  const { router, exports, tasks, library, events, settings, config } = services;
  const open = (params) => services.openWork(params.id, params.repo);

  // ---- checks -------------------------------------------------------------
  router.post("/api/works/:repo/:id/check", async ({ params, req }) => checkWork(services, await open(params), await readJson(req)));
  router.get("/api/works/:repo/:id/check", async ({ params }) => services.checks.get(`${params.repo}/${params.id}`) || null);

  // ---- assets -------------------------------------------------------------
  router.get("/api/works/:repo/:id/assets", async ({ params }) => listAssets(await open(params)));
  router.post("/api/works/:repo/:id/assets/import", async ({ params, req }) => {
    const work = await open(params);
    const body = await readJson(req);
    let relative;
    if (body.url) relative = await importFromUrl(work, body.url, { name: body.name });
    else if (body.libraryId) relative = (await library.use(work, body.libraryId)).path;
    else throw problem(400, "需要 url 或 libraryId");
    events.emit({ type: "assets", work: work.id, repo: work.repo });
    return { path: relative, url: `films/${work.slug}/${relative.replace(/^public\//, "")}`, ...(await probe(path.join(work.dir, relative))) };
  });
  /** Microphone recordings: body is the recorded file; placed on the "录音" track at `start`. */
  router.post(
    "/api/works/:repo/:id/recordings",
    async ({ params, req, query }) => {
      const work = await open(params);
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
  router.post("/api/works/:repo/:id/layers", async ({ params, req }) => editVisual(await open(params), await readJson(req)));
  router.get("/api/works/:repo/:id/audio", async ({ params }) => readAudio(await open(params)));
  router.post("/api/works/:repo/:id/audio", async ({ params, req }) => editAudio(await open(params), await readJson(req)));
  router.post("/api/works/:repo/:id/audio/place", async ({ params, req }) => {
    const body = await readJson(req);
    return placeAudio(await open(params), { src: body.src, start: body.start, duration: body.duration, trackName: body.track, name: body.name });
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

  // ---- library --------------------------------------------------------------
  router.get("/api/repos/:repo/library", ({ params }) => library.list(params.repo));
  router.post(
    "/api/repos/:repo/library",
    async ({ params, req, query }) => {
      const temp = path.join(config.dirs.tmp, "upload-" + randomUUID());
      try {
        await writeStream(path.dirname(temp), path.basename(temp), req, { limit: 2 * 1024 * 1024 * 1024 });
        return await library.add(params.repo, temp, { name: query.name, license: query.license || "", tags: query.tags || "" });
      } finally {
        fs.rmSync(temp, { force: true });
      }
    },
    { raw: true },
  );
  router.post("/api/repos/:repo/library/from-work", async ({ params, req }) => {
    const body = await readJson(req);
    const work = await services.openWork(body.work, params.repo);
    const file = path.join(work.dir, body.path);
    return library.add(params.repo, file, { name: path.basename(body.path), license: body.license || "", tags: body.tags || "" });
  });
  router.get("/api/repos/:repo/library/:item", async ({ params, req, res }) => sendFile(req, res, (await library.file(params.repo, params.item)).file));
  router.delete("/api/repos/:repo/library/:item", ({ params }) => library.remove(params.repo, params.item));
  router.post("/api/repos/:repo/library/push", ({ params }) => library.push(params.repo));
  router.post("/api/repos/:repo/library/pull", ({ params }) => library.pull(params.repo));

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
