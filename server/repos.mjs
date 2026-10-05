import fs from "node:fs";
import path from "node:path";
import { git, gitOk, authEnv, addOrphanWorktree } from "./git.mjs";
import { problem, notFound, Locks } from "./util.mjs";

export const LOCAL_REPO = "local";
export const MATERIALS_BRANCH = "frame/materials";
const REPO_README = `# FRAME 作品库

本仓库由 FRAME Studio 管理。每个作品是一个独立分支 \`works/<作品 id>\`，作品文件位于 \`projects/<名称>/\`；
共享素材库位于 \`${MATERIALS_BRANCH}\` 分支。请在 FRAME Studio 中打开与编辑。
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
    const lines = ["/src", "/node_modules", "/docs", "/tsconfig.json", "/AGENTS.md", "/CLAUDE.md", "exports/", ".cache/", "node_modules/"];
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
    await git(dir, ["push", "origin", "main", "refs/heads/works/*:refs/heads/works/*", "refs/heads/frame/*:refs/heads/frame/*"], {
      env: authEnv(this.github.token(account)),
    });
    const branches = (await git(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads/works", "refs/heads/frame"])).split("\n").filter(Boolean);
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

  async remove(id) {
    if (id === LOCAL_REPO) throw problem(400, "本地作品库不能移除");
    const repo = this.get(id);
    fs.rmSync(path.join(this.config.dirs.works, id), { recursive: true, force: true });
    fs.rmSync(path.join(this.config.dirs.libraries, id), { recursive: true, force: true });
    fs.rmSync(repo.dir, { recursive: true, force: true });
    this.settings.update("repos", (repos) => repos.filter((item) => item.id !== id));
    this.events.emit({ type: "repos" });
  }

  async setAccount(id, account) {
    this.get(id);
    this.settings.update("repos", (repos) => repos.map((item) => (item.id === id ? { ...item, account } : item)));
  }

  /** Worktree of the materials branch, created as an orphan branch on first use. */
  async library(id) {
    const repo = this.get(id);
    const dir = path.join(this.config.dirs.libraries, id);
    return this.locks.run("library:" + id, async () => {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      // Look for an existing remote library before starting a new one.
      if (repo.remote) await git(repo.dir, ["fetch", "--prune", "origin"], { env: this.env(repo) }).catch(() => {});
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await git(repo.dir, ["worktree", "prune"]);
      const local = await gitOk(repo.dir, ["show-ref", "--verify", "--quiet", "refs/heads/" + MATERIALS_BRANCH]);
      const remote = await gitOk(repo.dir, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/" + MATERIALS_BRANCH]);
      if (local) await git(repo.dir, ["worktree", "add", "--", dir, MATERIALS_BRANCH]);
      else if (remote) await git(repo.dir, ["worktree", "add", "--track", "-b", MATERIALS_BRANCH, "--", dir, "origin/" + MATERIALS_BRANCH]);
      else {
        await addOrphanWorktree(repo.dir, MATERIALS_BRANCH, dir);
        fs.mkdirSync(path.join(dir, "materials"), { recursive: true });
        fs.writeFileSync(path.join(dir, "materials", "index.json"), "[]\n");
        await git(dir, ["add", "--", "materials/index.json"]);
        await git(dir, ["commit", "-m", "Create materials library"]);
      }
      return dir;
    });
  }
}
