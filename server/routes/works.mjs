import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, sendFile } from "../http.mjs";
import { tree, readText, writeText, removePath, movePath, writeStream, uniquePath, downloadPlan, assertZippable, sendZip } from "../files.mjs";
import { problem, confined, conflict, diskUsage } from "../util.mjs";
import { snapshotFiles } from "../ai/context.mjs";

export function workRoutes(services) {
  const { router, works, repos, settings, preview, events } = services;
  const open = (params) => services.openWork(params.id, params.repo);
  const editable = (params) => services.openEditable(params.id, params.repo);

  // Covers come from the covers plugin; stale ones are redone in the background.
  const covered = (list) => services.covers?.annotate(list) ?? list;
  router.get("/api/works", async ({ query }) => {
    const list = covered(await works.list({ repo: query.repo || undefined, trash: query.trash === "1" }));
    // When each work was last opened on this machine (the home page's 最近打开).
    const opened = new Map(settings.get("recent").map((item) => [`${item.repo}/${item.id}`, item.openedAt]));
    return list.map((work) => (opened.has(`${work.repo}/${work.id}`) ? { ...work, openedAt: opened.get(`${work.repo}/${work.id}`) } : work));
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
        // Resource previews run the libraries as they are now, outside the work.
        library: services.materials?.libraryBases(work.repo) ?? null,
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
  /** Keep a work an AI asked to delete (confirming is moving it to the recycle bin, above). */
  router.delete("/api/works/:repo/:id/delete-request", ({ params }) => ({ cleared: works.clearDeleteRequest(params.repo, params.id) }));
  router.post("/api/works/:repo/:id/free", async ({ params }) => {
    idle(params);
    services.watcher.unwatch({ repo: params.repo, id: params.id });
    return works.freeLocal(params.id, params.repo);
  });
  /** What a deleted work leaves behind outside its branch: exported videos, its cover, its review, AI conversations. */
  const forget = async (repo, id) => {
    fs.rmSync(path.join(services.config.dirs.exports, repo, id), { recursive: true, force: true });
    services.covers?.forget(repo, id);
    await services.reviews?.forget(repo, id);
    for (const session of services.ai?.list({ work: id, repo }) ?? []) await services.ai.remove(session.id);
  };

  // ---- moving a work of the local repository to another one -------------------------------

  /**
   * Before a work moves: what goes along (libraries the other repository lacks, its review,
   * exported videos, AI conversations), what changes (material files the other repository has
   * in another version or not at all) and what is in the way (`blocked`). `error`: GitHub could
   * not be asked which works it has.
   */
  async function moveReport(from, id, to) {
    const source = repos.get(from);
    if (source.remote) throw problem(400, "只能迁移本地作品库里的作品");
    if (!to) throw problem(400, "请选择要迁移到的作品库");
    if (to === from) throw problem(400, "作品已经在这个作品库里");
    const target = repos.get(to);
    if (!fs.existsSync(path.join(target.dir, "HEAD"))) throw problem(400, `作品库「${target.name}」还没有准备好`);
    const work = await works.open(id, from);
    let error = "";
    // Which ids GitHub has; asked once for several works moving in a row.
    if (target.remote && !(Date.now() - Date.parse(target.fetchedAt || "") < 15000))
      await repos.fetch(to).catch(
        (failure) =>
          (error = String(failure.stderr || failure.message)
            .trim()
            .split("\n")
            .pop()),
      );
    const blocked = [];
    const taken = await works.taken(to, id);
    if (taken) blocked.push(`「${target.name}」里已经有 id 为 ${id} 的${taken}`);
    if (services.ai?.list({ work: id, repo: from }).some((session) => session.status !== "idle")) blocked.push("AI 正在这个作品里工作，先停止它");
    for (const task of services.tasks?.list() ?? []) if (task.work === id && task.repo === from && task.status === "running") blocked.push(`正在进行：${task.title}`);
    if (await services.reviews?.has(to, id)) blocked.push(`「${target.name}」里已经有这个作品的复盘`);
    const exports = path.join(services.config.dirs.exports, from, id);
    const videos = fs.existsSync(exports)
      ? fs
          .readdirSync(exports, { recursive: true })
          .map(String)
          .filter((name) => /\.(mp4|webm)$/i.test(name) && !name.includes(".partial."))
      : [];
    const meta = works.meta(work);
    return {
      id,
      title: meta.ok ? String(meta.meta.title || work.slug) : work.slug,
      from: { id: from, name: source.name },
      to: { id: to, name: target.name, remote: target.remote },
      published: Boolean(works.published(work)),
      unsaved: (await works.status(work)).files.length,
      blocked,
      error,
      materials: (await services.materials?.movePlan(work, to)) ?? { copy: [], shared: [], changed: [], missing: [] },
      experiences: (await services.experience?.movePlan(work, to)) ?? { copy: [], shared: [], aliases: {} },
      review: Boolean(await services.reviews?.has(from, id)),
      exports: { count: videos.length, bytes: diskUsage(exports) },
      sessions: services.ai?.list({ work: id, repo: from }).length ?? 0,
    };
  }
  router.get("/api/works/:repo/:id/move", ({ params, query }) => moveReport(params.repo, params.id, String(query.to || "")));
  router.post("/api/works/:repo/:id/move", async ({ params, req }) => {
    const { repo: from, id } = params;
    const to = String((await readJson(req)).to || "");
    const report = await moveReport(from, id, to);
    if (report.blocked.length) throw conflict(report.blocked.join("；"), { report });
    const names = { from: report.from.name, to: report.to.name };
    services.watcher.unwatch({ repo: from, id });
    const work = await works.open(id, from);
    if (!report.published) await works.commit(work, "迁移前自动保存");
    // The libraries the work uses go first, so it finds them there at once.
    await services.materials?.carry(work, to, names.from);
    await services.experience?.carry(work, to, names.from);
    const before = snapshotFiles(work.dir);
    const moved = await works.move(work, to);
    const after = snapshotFiles(moved.dir);
    // The work has moved: whatever follows it is tried one by one, and what failed is reported.
    const problems = [];
    const step = async (what, action) => {
      try {
        return await action();
      } catch (error) {
        console.warn(`moving ${from}/${id} to ${to}: ${what}:`, error.message);
        problems.push(`${what}：${error.message}`);
      }
    };
    const relocked = (await step("素材改用这个作品库的版本", () => services.materials?.relock(moved))) ?? [];
    works.saved(moved);
    services.watcher.watch(moved);
    // What is kept of the work outside its branch.
    await step("复盘资料", () => services.reviews?.move(from, to, id, names));
    await step("封面", () => services.covers?.move(from, to, id));
    await step("导出的视频", () => {
      const exports = path.join(services.config.dirs.exports, from, id);
      const exported = path.join(services.config.dirs.exports, to, id);
      if (!fs.existsSync(exports)) return;
      fs.mkdirSync(path.dirname(exported), { recursive: true });
      if (fs.existsSync(exported)) fs.cpSync(exports, exported, { recursive: true });
      else fs.renameSync(exports, exported);
      fs.rmSync(exports, { recursive: true, force: true });
    });
    await step("AI 对话", () => services.ai?.moveWork({ id, from, to, roots: { from: work.root, to: moved.root }, stamps: { before, after } }));
    services.checks?.delete(`${from}/${id}`);
    events.emit({ type: "work-moved", work: id, from, to, name: names.to });
    await works.reclaim(from).catch((error) => console.warn("reclaim after moving a work:", error.message));
    return { id, repo: to, relocked, problems };
  });

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

  /**
   * Download picked files and folders (the explorer's 导出): the POST checks the picks and hands
   * out a link the browser downloads from, so long picks fit and problems show before it starts.
   * One file comes as it is, more or a folder as a zip.
   */
  const downloads = new Map(); // token -> { work, paths, expires }
  router.post("/api/works/:repo/:id/download", async ({ req, params }) => {
    const work = await open(params);
    const { paths } = await readJson(req);
    const plan = downloadPlan(work.dir, paths, work.slug);
    if (plan.entries) assertZippable(plan.entries);
    const now = Date.now();
    for (const [key, item] of downloads) if (item.expires < now) downloads.delete(key);
    const token = randomUUID();
    downloads.set(token, { work: `${work.repo}/${work.id}`, paths, expires: now + 10 * 60_000 });
    const url = `/api/works/${encodeURIComponent(work.repo)}/${encodeURIComponent(work.id)}/download/${token}`;
    return { url, name: plan.name, size: plan.size, count: plan.count };
  });
  router.get("/api/works/:repo/:id/download/:token", async ({ req, res, params }) => {
    const work = await open(params);
    const item = downloads.get(params.token);
    if (!item || item.expires < Date.now() || item.work !== `${work.repo}/${work.id}`) throw problem(404, "下载链接已过期，请重新导出", "NOT_FOUND");
    const plan = downloadPlan(work.dir, item.paths, work.slug);
    if (!plan.file) return sendZip(req, res, plan.entries, plan.name);
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(plan.name)}`);
    sendFile(req, res, plan.file);
  });

  /** Raw bytes of a work file for media previews in the studio. */
  router.get("/api/works/:repo/:id/raw", async ({ req, res, params, query }) => {
    const work = await open(params);
    const file = confined(work.dir, query.path || "");
    if (!fs.existsSync(file)) throw problem(404, "文件不存在", "NOT_FOUND");
    sendFile(req, res, file);
  });
}
