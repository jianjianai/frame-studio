import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { readJson, sendFile } from "../http.mjs";
import { writeStream, uniquePath } from "../files.mjs";
import { precacheManifest, sendBundle } from "../precache.mjs";
import { checkWork } from "../checks.mjs";
import { placeAudio, readVisual, editVisual, readAudio, editAudio } from "../documents.mjs";
import { probe } from "../media.mjs";
import { listAssets } from "../tools/work-tools.mjs";
import { importFromUrl } from "../tools/asset-tools.mjs";
import { describeIssues } from "../tools/registry.mjs";
import { problem, sha256 } from "../util.mjs";

/** Studio-facing routes for exports, assets, documents, checks, tasks and tokens. */
export function studioRoutes(services) {
  const { router, exports, tasks, events, settings, config } = services;
  const open = (params) => services.openWork(params.id, params.repo);

  // ---- checks -------------------------------------------------------------
  router.post("/api/works/:repo/:id/check", async ({ params, req }) => checkWork(services, await open(params), await readJson(req)));
  router.get("/api/works/:repo/:id/check", async ({ params }) => services.checks.get(`${params.repo}/${params.id}`) || null);

  // ---- assets -------------------------------------------------------------
  /** Everything playback may load: the browser keeps these and fetches only changed ones (public/frame-sw.js). */
  router.get("/api/works/:repo/:id/precache", async ({ params }) => precacheManifest(services, await open(params)));
  router.post("/api/works/:repo/:id/precache/bundle", async ({ params, req, res }) =>
    sendBundle(services, await open(params), (await readJson(req)).paths, res),
  );

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
    if (body.sound) {
      // A sound of a library sound module, by its resource id (<library>/<file>#<name>).
      const sound = await services.resources.sound(work, String(body.sound));
      return placed(work, () => placeAudio(work, { sound, start: body.start, duration: body.duration ?? sound.duration, trackName: body.track, name: body.name ?? sound.title }));
    }
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
