import fs from "node:fs";
import path from "node:path";
import { readJson, sendFile } from "../http.mjs";
import { tree, readText, writeText, removePath, movePath, writeStream, uniquePath } from "../files.mjs";
import { problem, confined, conflict } from "../util.mjs";

export function workRoutes(services) {
  const { router, works, settings, preview, events } = services;
  const open = (params) => services.openWork(params.id, params.repo);
  const editable = (params) => services.openEditable(params.id, params.repo);

  router.get("/api/works", ({ query }) => works.list({ repo: query.repo || undefined, trash: query.trash === "1" }));
  router.get("/api/recent", async () => {
    const all = await works.list();
    const byKey = new Map(all.map((work) => [`${work.repo}/${work.id}`, work]));
    return settings
      .get("recent")
      .map((item) => byKey.get(`${item.repo}/${item.id}`) && { ...byKey.get(`${item.repo}/${item.id}`), openedAt: item.openedAt })
      .filter(Boolean);
  });
  router.post("/api/works", async ({ req }) => {
    const body = await readJson(req);
    const work = await works.create({
      repo: body.repo || "local",
      title: body.title,
      width: body.width,
      height: body.height,
      duration: body.duration,
      fps: body.fps,
      description: body.description || "",
    });
    return describe(work);
  });

  /** Import a project folder from this computer (local mode only). */
  router.post("/api/works/import", async ({ req }) => {
    if (services.auth.required) throw problem(403, "服务器模式不能导入本机文件夹");
    const body = await readJson(req);
    return describe(await works.importFolder({ repo: body.repo || "local", source: body.source }));
  });

  async function describe(work) {
    const meta = works.meta(work);
    await services.experience?.prepare(work);
    return {
      id: work.id,
      repo: work.repo,
      branch: work.branch,
      slug: work.slug,
      root: work.root,
      dir: work.dir,
      meta: meta.ok ? meta.meta : null,
      loads: meta.ok ? meta.loads : null,
      metaError: meta.ok ? null : meta.error,
      // The linked experience libraries (renames followed) and names that lead nowhere.
      experiences: services.experience?.link(work) ?? { libraries: [], missing: [] },
      preview: {
        module: preview.moduleUrl(work.dir + "/project.ts"),
        assetBase: `/files/${work.repo}/${work.id}/`,
      },
    };
  }

  router.get("/api/works/:repo/:id", async ({ params, query }) => {
    const work = await open(params);
    if (query.touch === "1") works.touch(work.repo, work.id);
    return describe(work);
  });
  router.patch("/api/works/:repo/:id", async ({ req, params }) => {
    const work = await open(params);
    await works.update(work, await readJson(req));
    return describe(work);
  });
  // ---- recycle bin, local space ---------------------------------------------
  const idle = (params) => {
    if (services.ai?.list({ work: params.id, repo: params.repo }).some((session) => session.status !== "idle"))
      throw conflict("AI 正在这个作品里工作，先停止它");
  };
  router.delete("/api/works/:repo/:id", async ({ params }) => {
    idle(params);
    services.watcher.unwatch({ repo: params.repo, id: params.id });
    await works.trash(params.id, params.repo);
  });
  router.post("/api/works/:repo/:id/restore", ({ params }) => works.restore(params.id, params.repo));
  router.post("/api/works/:repo/:id/free", async ({ params }) => {
    idle(params);
    services.watcher.unwatch({ repo: params.repo, id: params.id });
    return works.freeLocal(params.id, params.repo);
  });
  /** What a deleted work leaves behind outside its branch: exported videos, AI conversations. */
  const forget = async (repo, id) => {
    fs.rmSync(path.join(services.config.dirs.exports, repo, id), { recursive: true, force: true });
    for (const session of services.ai?.list({ work: id, repo }) ?? []) await services.ai.remove(session.id);
  };
  router.delete("/api/trash/:repo/:id", async ({ params }) => {
    const result = await works.purge(params.id, params.repo);
    await forget(params.repo, params.id);
    return result;
  });
  router.delete("/api/trash/:repo", async ({ params }) => {
    const trashed = await works.list({ repo: params.repo, trash: true });
    const result = await works.purgeAll(params.repo);
    for (const work of trashed) await forget(params.repo, work.id);
    return result;
  });

  // ---- files ------------------------------------------------------------
  router.get("/api/works/:repo/:id/tree", async ({ params }) => tree((await open(params)).dir));
  router.get("/api/works/:repo/:id/file", async ({ params, query }) => readText((await open(params)).dir, query.path));
  router.put("/api/works/:repo/:id/file", async ({ req, params }) => {
    const body = await readJson(req);
    return writeText((await editable(params)).dir, body.path, body.content, { expectedHash: body.expectedHash });
  });
  router.post("/api/works/:repo/:id/move", async ({ req, params }) => {
    const body = await readJson(req);
    movePath((await editable(params)).dir, body.from, body.to);
  });
  router.delete("/api/works/:repo/:id/file", async ({ params, query }) => removePath((await editable(params)).dir, query.path));
  /** Raw upload: PUT body is the file. `?path=public/x.png&unique=1` picks a free name. */
  router.post(
    "/api/works/:repo/:id/upload",
    async ({ req, params, query }) => {
      const work = await editable(params);
      if (!query.path || !/^(public|production)\//.test(query.path)) throw problem(400, "上传文件只能放在 public/ 或 production/");
      const target = query.unique === "1" ? uniquePath(work.dir, query.path) : query.path;
      const saved = await writeStream(work.dir, target, req, { overwrite: query.overwrite === "1" });
      events.emit({ type: "assets", work: work.id, repo: work.repo });
      return { ...saved, url: `films/${work.slug}/${saved.path.replace(/^public\//, "")}` };
    },
    { raw: true },
  );

  // ---- versions ---------------------------------------------------------
  router.get("/api/works/:repo/:id/status", async ({ params }) => works.status(await open(params)));
  router.get("/api/works/:repo/:id/history", async ({ params, query }) =>
    works.history(await open(params), { limit: Number(query.limit || 50), skip: Number(query.skip || 0) }),
  );
  router.get("/api/works/:repo/:id/changes", async ({ params, query }) => works.changes(await open(params), query.commit));
  router.get("/api/works/:repo/:id/diff", async ({ params, query }) => ({
    diff: await works.diff(await open(params), { commit: query.commit, file: query.file }),
  }));
  router.get("/api/works/:repo/:id/file-at", async ({ params, query }) => ({ content: await works.fileAt(await open(params), query.commit, query.path) }));
  router.post("/api/works/:repo/:id/commit", async ({ req, params }) => ({ commit: await works.commit(await editable(params), (await readJson(req)).message) }));
  router.post("/api/works/:repo/:id/revert", async ({ req, params }) => ({ commit: await works.revert(await editable(params), (await readJson(req)).commit) }));
  router.post("/api/works/:repo/:id/discard", async ({ req, params }) => works.discard(await editable(params), (await readJson(req)).files || []));
  // Published works are view-only; the mark is saved as a version.
  router.post("/api/works/:repo/:id/publish", async ({ params }) => ({ commit: await works.setPublished(await open(params), true) }));
  router.post("/api/works/:repo/:id/unpublish", async ({ params }) => ({ commit: await works.setPublished(await open(params), false) }));
  router.post("/api/works/:repo/:id/duplicate", async ({ params, req }) => {
    const copy = await works.duplicate(await open(params), await readJson(req));
    return { id: copy.id, repo: copy.repo };
  });
  router.post("/api/works/:repo/:id/sync", async ({ params }) => works.sync(await open(params)));
  router.post("/api/works/:repo/:id/push", async ({ params }) => works.push(await open(params)));
  router.post("/api/works/:repo/:id/pull", async ({ params }) => works.pull(await open(params)));
  router.post("/api/works/:repo/:id/resolve", async ({ params, req }) => works.resolve(await open(params), (await readJson(req)).strategy));

  /** Raw bytes of a work file for media previews in the studio. */
  router.get("/api/works/:repo/:id/raw", async ({ req, res, params, query }) => {
    const work = await open(params);
    const file = confined(work.dir, query.path || "");
    if (!fs.existsSync(file)) throw problem(404, "文件不存在", "NOT_FOUND");
    sendFile(req, res, file);
  });
}
