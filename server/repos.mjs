import fs from "node:fs";
import path from "node:path";
import { git, gitOk, authEnv, addOrphanWorktree, parseStatus } from "./git.mjs";
import { problem, notFound, Locks, diskUsage, writable } from "./util.mjs";

export const LOCAL_REPO = "local";
/** Branches of a repository besides its works: libraries (and their recycle bins) and the reviews. */
export const SHARED_BRANCHES = ["materials", "materials-trash", "experience", "experience-trash", "frame"];
const REPO_README = `# FRAME 作品库

本仓库由 FRAME Studio 管理。每个作品是一个独立分支 \`works/<作品 id>\`，作品文件位于 \`projects/<名称>/\`；
每个素材库是一个分支 \`materials/<id>\`，每个经验库是一个分支 \`experience/<id>\`（回收站里的在 \`materials-trash/\`、\`experience-trash/\`），作品发布后的复盘数据位于 \`frame/reviews\` 分支。请在 FRAME Studio 中打开与编辑。
`;

const repoIdFrom = (fullName) =>
  fullName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "repo";

/**
 * Each content repository is a bare clone under repos/<id>. Works and the materials
 * library are separate worktrees, so their histories and push/pull never interfere.
 */
export class Repos {
  /** Run before a repository's folders are removed from this machine, to stop and forget what other parts keep of it: (id) => void. */
  beforeRemove = [];

  constructor({ config, settings, github, events }) {
    this.config = config;
    this.settings = settings;
    this.github = github;
    this.events = events;
    this.locks = new Locks();
  }
  dir(id) {
    return path.join(this.config.dirs.repos, id);
  }
  list() {
    return this.settings.get("repos").map((repo) => ({ ...repo, ready: fs.existsSync(this.dir(repo.id)) }));
  }
  get(id) {
    const repo = this.settings.get("repos").find((item) => item.id === id);
    if (!repo) throw notFound(`作品库不存在：${id}`);
    return { ...repo, dir: this.dir(id) };
  }
  env(repo) {
    return authEnv(this.github.token(repo.account));
  }

  async ensureLocal() {
    const dir = this.dir(LOCAL_REPO);
    if (!fs.existsSync(path.join(dir, "HEAD"))) {
      fs.mkdirSync(dir, { recursive: true });
      await git(dir, ["init", "--bare", "--initial-branch=main"]);
      await this.seedMain(dir);
    }
    await this.prepare(dir);
    if (!this.settings.get("repos").some((repo) => repo.id === LOCAL_REPO))
      this.settings.update("repos", (repos) => [
        { id: LOCAL_REPO, name: "本地作品库", remote: "", account: "", createdAt: new Date().toISOString() },
        ...repos,
      ]);
  }

  /** Worktree checkouts link the shared engine; never let those links become content. */
  async prepare(dir) {
    const exclude = path.join(dir, "info", "exclude");
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const lines = ["/src", "/node_modules", "/docs", "/tsconfig.json", "/AGENTS.md", "/CLAUDE.md", "/.materials/", "exports/", ".cache/", "node_modules/"];
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    const missing = lines.filter((line) => !current.split("\n").includes(line));
    if (missing.length) fs.appendFileSync(exclude, (current.endsWith("\n") || !current ? "" : "\n") + missing.join("\n") + "\n");
  }

  async seedMain(dir) {
    const tree = (await git(dir, ["mktree"], { input: "" })).trim();
    const blob = (await git(dir, ["hash-object", "-w", "--stdin"], { input: REPO_README })).trim();
    const readmeTree = (await git(dir, ["mktree"], { input: `100644 blob ${blob}\tREADME.md\n` })).trim();
    const commit = (await git(dir, ["commit-tree", readmeTree || tree, "-m", "Initialize FRAME content repository"])).trim();
    await git(dir, ["update-ref", "refs/heads/main", commit]);
  }

  /** Clone an existing GitHub (or any git) repository. */
  async clone({ url, account = "", name = "" }) {
    const fileRemote = process.env.FRAME_ALLOW_FILE_REMOTES === "1" && url.startsWith("file://"); // tests only
    if (!/^(https:\/\/|git@|ssh:\/\/)/.test(url) && !fileRemote) throw problem(400, "只支持 https 或 ssh 仓库地址");
    const fullName =
      name ||
      url
        .replace(/\.git$/, "")
        .split(/[/:]/)
        .slice(-2)
        .join("/");
    let id = repoIdFrom(fullName);
    const existing = this.settings.get("repos");
    if (existing.some((repo) => repo.remote === url)) throw problem(409, "这个仓库已经添加");
    while (existing.some((repo) => repo.id === id) || id === LOCAL_REPO) id += "-2";
    const dir = this.dir(id);
    const env = authEnv(this.github.token(account));
    try {
      await git(this.config.dirs.repos, ["clone", "--bare", "--", url, dir], { env });
      await git(dir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
      await git(dir, ["fetch", "--prune", "origin"], { env });
      await this.prepare(dir);
      const empty =
        !(await gitOk(dir, ["rev-parse", "--verify", "refs/remotes/origin/HEAD"])) && !(await git(dir, ["for-each-ref", "refs/remotes/origin"])).trim();
      if (empty) {
        await this.seedMain(dir);
        await git(dir, ["push", "origin", "main"], { env });
      }
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    const repo = { id, name: fullName, remote: url, account, createdAt: new Date().toISOString(), fetchedAt: new Date().toISOString() };
    this.settings.update("repos", (repos) => [...repos, repo]);
    this.events.emit({ type: "repos" });
    return repo;
  }

  /** Create a new GitHub repository for the account, then clone it. */
  async createOnGitHub({ account, name, private: isPrivate = true }) {
    const created = await this.github.createRepository(account, { name, private: isPrivate });
    return this.clone({ url: created.url, account, name: created.fullName });
  }

  /** Give the local repository a GitHub remote so its works can be pushed. */
  async publishLocal({ account, name, private: isPrivate = true }) {
    const created = await this.github.createRepository(account, { name, private: isPrivate });
    const dir = this.dir(LOCAL_REPO);
    await git(dir, ["remote", "add", "origin", created.url]);
    await git(dir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    await git(dir, ["push", "origin", "main", ...["works", ...SHARED_BRANCHES].map((kind) => `refs/heads/${kind}/*:refs/heads/${kind}/*`)], {
      env: authEnv(this.github.token(account)),
    });
    const branches = (await git(dir, ["for-each-ref", "--format=%(refname:short)", ...["works", ...SHARED_BRANCHES].map((kind) => `refs/heads/${kind}/`)])).split("\n").filter(Boolean);
    for (const branch of branches) {
      await git(dir, ["config", `branch.${branch}.remote`, "origin"]);
      await git(dir, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
    }
    await git(dir, ["fetch", "origin"], { env: authEnv(this.github.token(account)) });
    this.settings.update("repos", (repos) =>
      repos.map((repo) => (repo.id === LOCAL_REPO ? { ...repo, name: created.fullName, remote: created.url, account } : repo)),
    );
    this.events.emit({ type: "repos" });
    return this.get(LOCAL_REPO);
  }

  async fetch(id) {
    const repo = this.get(id);
    if (!repo.remote) return { fetched: false };
    await this.locks.run("fetch:" + id, () => git(repo.dir, ["fetch", "--prune", "origin"], { env: this.env(repo) }));
    this.settings.update("repos", (repos) => repos.map((item) => (item.id === id ? { ...item, fetchedAt: new Date().toISOString() } : item)));
    this.events.emit({ type: "repos" });
    return { fetched: true };
  }

  /**
   * What only this machine has of a repository: branches with versions GitHub does not have
   * (`behind` too when GitHub moved on as well) and checkouts with unsaved changes. Asks GitHub
   * first; `error` says why that failed.
   */
  async localOnly(id) {
    const repo = this.get(id);
    if (!fs.existsSync(path.join(repo.dir, "HEAD"))) return { error: "", branches: [], worktrees: [], backups: 0 };
    let error = "";
    if (repo.remote)
      await this.fetch(id).catch(
        (failure) =>
          (error = String(failure.stderr || failure.message)
            .trim()
            .split("\n")
            .pop()),
      );
    const branches = [];
    for (const branch of (await git(repo.dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).split("\n").filter(Boolean)) {
      const remote = `refs/remotes/origin/${branch}`;
      if (repo.remote && (await gitOk(repo.dir, ["show-ref", "--verify", "--quiet", remote]))) {
        const [ahead, behind] = (await git(repo.dir, ["rev-list", "--left-right", "--count", `refs/heads/${branch}...${remote}`]))
          .trim()
          .split(/\s+/)
          .map(Number);
        if (ahead) branches.push({ branch, ahead, behind });
      } else {
        // Never pushed: the versions no branch on GitHub has.
        const ahead = Number((await git(repo.dir, ["rev-list", "--count", `refs/heads/${branch}`, "--not", "--remotes=origin"])).trim());
        if (ahead) branches.push({ branch, ahead, behind: 0 });
      }
    }
    const worktrees = [];
    for (const { dir, branch } of await this.worktrees(id)) {
      const { files } = parseStatus(await git(dir, ["status", "--porcelain=v2", "--untracked-files=all"]));
      if (files.length) worktrees.push({ branch, dir, files: files.length });
    }
    const backups = (await git(repo.dir, ["for-each-ref", "--format=%(refname)", "refs/frame-backup/"])).split("\n").filter(Boolean).length;
    return { error, branches, worktrees, backups };
  }

  /** Checkouts of the repository's branches (works, libraries, reviews). */
  async worktrees(id) {
    const out = await git(this.dir(id), ["worktree", "list", "--porcelain"]);
    const result = [];
    for (const block of out.split("\n\n")) {
      const dir = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
      if (dir && branch && fs.existsSync(dir)) result.push({ dir, branch });
    }
    return result;
  }

  /** Where this machine keeps a repository: its clone, the works checked out, the shared branches' checkouts, exported videos. */
  places(id) {
    const { works, libraries, experience, reviews, exports } = this.config.dirs;
    return {
      clone: this.dir(id),
      works: path.join(works, id),
      shared: [libraries, experience, reviews].map((base) => path.join(base, id)),
      exports: path.join(exports, id),
    };
  }

  /**
   * Remove a repository from this machine (取消链接): everything kept of it here goes, GitHub
   * is not touched. Returns the space freed.
   */
  async remove(id) {
    if (id === LOCAL_REPO) throw problem(400, "本地作品库不能移除");
    this.get(id);
    for (const hook of this.beforeRemove)
      try {
        await hook(id);
      } catch (error) {
        console.warn(`cleanup before removing ${id} failed:`, error.message);
      }
    const { clone, works, shared, exports } = this.places(id);
    let freed = 0;
    for (const dir of [clone, works, ...shared, exports]) {
      freed += diskUsage(dir);
      writable(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    this.settings.update("repos", (repos) => repos.filter((item) => item.id !== id));
    for (const key of ["recent", "deleteRequests"]) this.settings.update(key, (list) => list.filter((item) => item.repo !== id));
    this.events.emit({ type: "repos" });
    return { freed };
  }

  async setAccount(id, account) {
    this.get(id);
    this.settings.update("repos", (repos) => repos.map((item) => (item.id === id ? { ...item, account } : item)));
  }

  /**
   * The checkout of a branch the works of a repository share (the reviews) at `dir`: on first use from the local branch, else from GitHub's, else a new
   * branch with no history that starts with `files`.
   */
  async branchWorktree(id, { branch, dir, files, message }) {
    const repo = this.get(id);
    return this.locks.run(`worktree:${id}:${branch}`, async () => {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      // Look for the branch on GitHub before starting a new one.
      if (repo.remote) await git(repo.dir, ["fetch", "--prune", "origin"], { env: this.env(repo) }).catch(() => {});
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await git(repo.dir, ["worktree", "prune"]);
      if (await this.hasBranch(id, branch, "local")) await git(repo.dir, ["worktree", "add", "--", dir, branch]);
      else if (await this.hasBranch(id, branch, "remote")) await git(repo.dir, ["worktree", "add", "--track", "-b", branch, "--", dir, "origin/" + branch]);
      else {
        await addOrphanWorktree(repo.dir, branch, dir);
        for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
        await git(dir, ["add", "--", ...Object.keys(files)]);
        await git(dir, ["commit", "-q", "-m", message]);
      }
      return dir;
    });
  }

  /** Whether the repository has a branch here (`local`), from GitHub (`remote`) or either. */
  async hasBranch(id, branch, where = "any") {
    const { dir } = this.get(id);
    const refs = { local: [`refs/heads/${branch}`], remote: [`refs/remotes/origin/${branch}`], any: [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`] }[
      where
    ];
    for (const ref of refs) if (await gitOk(dir, ["show-ref", "--verify", "--quiet", ref])) return true;
    return false;
  }
}
