import fs from "node:fs";
import path from "node:path";
import { readJson } from "../http.mjs";
import { git } from "../git.mjs";
import { problem, conflict, diskUsage } from "../util.mjs";
import { LOCAL_REPO } from "../repos.mjs";

/** A branch the works of a repository share: a library (or one in the recycle bin) or the reviews, and the service that keeps it. */
function sharedBranch(branch) {
  for (const [prefix, service, noun] of [
    ["materials", "materials", "素材库"],
    ["experience", "experience", "经验库"],
  ]) {
    if (branch.startsWith(prefix + "/")) return { service, library: branch.slice(prefix.length + 1), title: `${noun}「${branch.slice(prefix.length + 1)}」` };
    if (branch.startsWith(prefix + "-trash/")) return { service, title: `${noun}回收站「${branch.slice(prefix.length + 7)}」` };
  }
  if (branch === "frame/reviews") return { service: "reviews", title: "复盘资料" };
  return branch === "frame/skills" ? { service: "skills", title: "技能" } : null;
}

export function repoRoutes(services) {
  const { router, repos, github, works } = services;
  router.get("/api/repos", () => repos.list());
  router.post("/api/repos", async ({ req }) => {
    const body = await readJson(req);
    if (body.create) return repos.createOnGitHub({ account: body.account, name: body.name, private: body.private !== false });
    if (!body.url) throw problem(400, "请填写仓库地址");
    return repos.clone({ url: body.url, account: body.account || "" });
  });
  router.post("/api/repos/:id/publish", async ({ req, params }) => {
    if (params.id !== "local") throw problem(400, "只有本地作品库需要发布");
    const body = await readJson(req);
    return repos.publishLocal({ account: body.account, name: body.name, private: body.private !== false });
  });
  router.post("/api/repos/:id/fetch", ({ params }) => repos.fetch(params.id));
  router.patch("/api/repos/:id", async ({ req, params }) => {
    const body = await readJson(req);
    if ("account" in body) await repos.setAccount(params.id, body.account);
    return repos.get(params.id);
  });
  router.get("/api/repos/:id/trash", ({ params }) => works.list({ repo: params.id, trash: true }));

  // ---- 取消链接: remove a repository from this machine; GitHub keeps what it has --------------

  /**
   * Before a repository is removed: what only this machine has (`pending`: unsaved changes,
   * versions GitHub lacks), what is in the way (`busy`) and what goes with it.
   */
  async function unlinkReport(id) {
    if (id === LOCAL_REPO) throw problem(400, "本地作品库只在这台电脑上，不能取消链接");
    const repo = repos.get(id);
    const local = await repos.localOnly(id);
    const ready = fs.existsSync(path.join(repo.dir, "HEAD"));
    const catalog = ready ? await works.catalog(id) : new Map();
    const pending = new Map();
    const item = (branch) => {
      if (!pending.has(branch)) {
        const [, prefix, work] = /^(works|trash)\/(.+)$/.exec(branch) ?? [];
        const library = sharedBranch(branch);
        pending.set(branch, {
          branch,
          kind: work ? (prefix === "works" ? "work" : "trash") : library ? "library" : "branch",
          ...(work ? { work } : {}),
          title: work ? (catalog.get(work)?.title ?? work) : (library?.title ?? branch),
          unsaved: 0,
          ahead: 0,
          behind: 0,
        });
      }
      return pending.get(branch);
    };
    for (const { branch, ahead, behind } of local.branches) Object.assign(item(branch), { ahead, behind });
    for (const { branch, files } of local.worktrees) item(branch).unsaved = files;
    const sessions = services.ai?.list({ repo: id }) ?? [];
    const busy = [
      ...sessions.filter((session) => session.status !== "idle").map((session) => `AI 正在「${catalog.get(session.work)?.title ?? session.work}」里工作`),
      ...(services.tasks?.list() ?? []).filter((task) => task.repo === id && task.status === "running").map((task) => `正在进行：${task.title}`),
    ];
    const { clone, works: checkouts, shared, exports } = repos.places(id);
    const videos = fs.existsSync(exports)
      ? fs
          .readdirSync(exports, { recursive: true })
          .map(String)
          .filter((name) => /\.(mp4|webm)$/i.test(name) && !name.includes(".partial."))
      : [];
    return {
      id,
      name: repo.name,
      remote: repo.remote,
      error: local.error,
      pending: [...pending.values()],
      busy,
      works: fs.existsSync(checkouts) ? fs.readdirSync(checkouts).length : 0,
      bytes: [clone, checkouts, ...shared].reduce((sum, dir) => sum + diskUsage(dir), 0),
      exports: { count: videos.length, bytes: diskUsage(exports) },
      sessions: sessions.length,
      backups: local.backups,
    };
  }

  router.get("/api/repos/:id/unlink", ({ params }) => unlinkReport(params.id));

  /** Save what is unsaved and push what GitHub lacks, so nothing is lost; then report again. */
  router.post("/api/repos/:id/unlink/sync", async ({ params }) => {
    const id = params.id;
    const report = await unlinkReport(id);
    if (report.busy.length) throw conflict(report.busy.join("；"));
    const repo = repos.get(id);
    const failed = [];
    for (const entry of report.pending.filter((item) => item.unsaved))
      try {
        const library = sharedBranch(entry.branch);
        const scope =
          entry.kind === "work"
            ? works.describe(id, entry.work)
            : library?.library
              ? await services[library.service].scope(id, library.library)
              : library?.service === "reviews" || library?.service === "skills"
                ? await services[library.service].scope(id)
                : null;
        if (!scope) continue;
        await works.commit(scope, "取消链接前自动保存");
        // Pushed at once, in turn with the push the saved version scheduled.
        const state = await services.remoteSync?.pushNow(scope);
        if (state?.state === "error") failed.push(`${entry.title}：${state.message}`);
      } catch (error) {
        failed.push(`${entry.title}：${error.message}`);
      }
    // Versions saved earlier that never reached GitHub. Branches GitHub moved on as well wait for the user's decision.
    for (const { branch } of (await repos.localOnly(id)).branches.filter((item) => !item.behind))
      try {
        await git(repo.dir, ["push", "--quiet", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { env: repos.env(repo) });
      } catch (error) {
        failed.push(
          `${branch}：${String(error.stderr || error.message)
            .trim()
            .split("\n")
            .pop()}`,
        );
      }
    services.events.emit({ type: "works", repo: id });
    return { ...(await unlinkReport(id)), failed };
  });

  /** `?discard=1`: the user chose to lose what only this machine has (or what could not be checked). */
  router.delete("/api/repos/:id", async ({ params, query }) => {
    const id = params.id;
    const report = await unlinkReport(id);
    if (report.busy.length) throw conflict(`${report.busy.join("；")}。先停止再取消链接。`);
    if ((report.pending.length || report.error) && query.discard !== "1")
      throw conflict(report.error ? `无法确认 GitHub 上的内容：${report.error}` : "还有内容只在这台电脑上，取消链接会丢失它们", { report });
    return repos.remove(id);
  });

  router.get("/api/github/accounts", () => github.accounts());
  router.post("/api/github/accounts", async ({ req }) => {
    const { token } = await readJson(req);
    if (!token) throw problem(400, "请填写 GitHub 令牌");
    return github.addAccount(token.trim());
  });
  router.delete("/api/github/accounts/:id", ({ params }) => github.removeAccount(params.id));
  router.get("/api/github/accounts/:id/repos", ({ params, query }) => github.repositories(params.id, { page: Number(query.page || 1), query: query.q || "" }));
}
