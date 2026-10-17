import fs from "node:fs";
import path from "node:path";
import { git, gitOk, addOrphanWorktree } from "./git.mjs";
import { GIT_ATTRIBUTES } from "./templates.mjs";
import { readJson } from "./http.mjs";
import { problem, notFound, conflict, Locks, writeFileAtomic } from "./util.mjs";
import { TRASH, NOTE, trashed, trashNote } from "./libraries.mjs";

/**
 * Material and experience libraries, each on a branch of its own (`materials/<id>`,
 * `experience/<id>`), checked out side by side at <home>/libraries|experience/<repo>/<id>/.
 * Every library has its own versions, unsaved changes and GitHub sync, like a work.
 *
 * The id is the branch name's last part and never changes: works reference libraries by it
 * (project.ts, materials/<id>/… addresses, lock files, @materials imports). The name people
 * see is the title, the README's first "# " line; renaming changes only that.
 *
 * A deleted library waits in the recycle bin as the branch `<prefix>-trash/<key>`, checked
 * out at .trash/<key>/ with a .trashed.json note (its id, title and when). Moving it there
 * and back renames the branch here and on GitHub, in one atomic push like a work's.
 */

const ID_CHARS = /[\\/:*?"<>|#%~^[@\s\x00-\x1f\x7f]/;
/** A library id: a part of a branch name (git check-ref-format) and a folder name on every system. */
export const validId = (id) =>
  typeof id === "string" &&
  id.length > 0 &&
  id.length <= 60 &&
  !new RegExp(ID_CHARS.source).test(id) &&
  !id.startsWith(".") &&
  !id.startsWith("-") &&
  !id.includes("..") &&
  !id.endsWith(".") &&
  !id.endsWith(".lock");
/** The id of a library created with this name: what a branch name allows of it. */
export const idFrom = (name) =>
  String(name || "")
    .trim()
    .replace(new RegExp(ID_CHARS.source + "+", "g"), "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\.lock$/i, "-lock")
    .slice(0, 60)
    .replace(/^[.-]+|[.-]+$/g, "");
const validKey = (key) => validId(key);

export class LibraryBranches {
  /** `prefix`: of the branches (materials, experience); `base`: the data folder (config.dirs key); `noun`: 素材库 / 经验库. */
  constructor(services, { prefix, base, noun }) {
    this.services = services;
    this.prefix = prefix;
    this.base = base;
    this.noun = noun;
    this.locks = new Locks();
    this.ready = new Map(); // repo → Promise of the checked-out root
  }

  branch(id) {
    return `${this.prefix}/${id}`;
  }
  trashBranch(key) {
    return `${this.prefix}-trash/${key}`;
  }
  root(repo) {
    return path.join(this.services.config.dirs[this.base], repo);
  }
  /** The folder holding every library's checkout (and the recycle bin's): made once, and again after GitHub was asked. */
  dir(repo) {
    if (!this.ready.has(repo)) {
      const pending = this.checkout(repo);
      pending.catch(() => this.ready.delete(repo));
      this.ready.set(repo, pending);
    }
    return this.ready.get(repo);
  }
  /** GitHub may have libraries this machine has not checked out yet (another device made them). */
  refresh(repo) {
    if (repo) this.ready.delete(repo);
    else this.ready.clear();
  }
  forget(repo) {
    this.ready.delete(repo);
  }

  /** Where a branch of this kind is checked out, or null when it is not one. */
  dirOf(root, branch) {
    if (branch.startsWith(this.prefix + "/")) {
      const id = branch.slice(this.prefix.length + 1);
      return validId(id) ? path.join(root, id) : null;
    }
    if (branch.startsWith(this.prefix + "-trash/")) {
      const key = branch.slice(this.prefix.length + 7);
      return validKey(key) ? path.join(root, TRASH, key) : null;
    }
    return null;
  }

  /**
   * Check out every library branch of the repository: local ones, and GitHub's this machine
   * does not have yet. A local branch GitHub no longer has (deleted or binned on another device)
   * goes, when nothing of it is only here.
   */
  async checkout(repo) {
    const { repos } = this.services;
    const info = repos.get(repo);
    const root = this.root(repo);
    return this.locks.run(repo, async () => {
      fs.mkdirSync(root, { recursive: true });
      if (!fs.existsSync(path.join(info.dir, "HEAD"))) return root;
      await git(info.dir, ["worktree", "prune"]);
      const kinds = [`${this.prefix}/`, `${this.prefix}-trash/`];
      const out = await git(info.dir, [
        "for-each-ref",
        "--format=%(refname)%09%(upstream:track)",
        ...kinds.flatMap((kind) => [`refs/heads/${kind}`, `refs/remotes/origin/${kind}`]),
      ]);
      const local = new Map();
      const remote = new Set();
      for (const line of out.split("\n").filter(Boolean)) {
        const [ref, track] = line.split("\t");
        if (ref.startsWith("refs/heads/")) local.set(ref.slice(11), track === "[gone]");
        else remote.add(ref.slice(20));
      }
      const checkedOut = new Map((await repos.worktrees(repo)).map((item) => [item.branch, item.dir]));
      for (const [branch, gone] of local) {
        if (!gone) continue;
        const at = checkedOut.get(branch);
        const onlyHere = Number((await git(info.dir, ["rev-list", "--count", `refs/heads/${branch}`, "--not", "--remotes=origin"])).trim());
        const unsaved = at ? (await git(at, ["status", "--porcelain"])).trim() : "";
        if (onlyHere || unsaved) continue;
        if (at) await git(info.dir, ["worktree", "remove", "--force", "--", at]);
        await git(info.dir, ["branch", "-D", branch]);
        local.delete(branch);
        checkedOut.delete(branch);
      }
      for (const branch of new Set([...local.keys(), ...remote])) {
        const dir = this.dirOf(root, branch);
        if (!dir) continue;
        const at = checkedOut.get(branch);
        if (at === dir) continue;
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        if (at) await git(info.dir, ["worktree", "move", "--", at, dir]);
        else if (fs.existsSync(dir)) console.warn(`${dir} is in the way of ${branch}; not checked out`);
        else if (local.has(branch)) await git(info.dir, ["worktree", "add", "--", dir, branch], { env: repos.env(info) });
        else await git(info.dir, ["worktree", "add", "--track", "-b", branch, "--", dir, "origin/" + branch], { env: repos.env(info) });
      }
      return root;
    });
  }

  /** The library ids checked out here. */
  async ids(repo) {
    const root = await this.dir(repo);
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && fs.existsSync(path.join(root, entry.name, ".git")))
      .map((entry) => entry.name);
  }
  /** Whether a library folder exists (synchronously, for the readers that need it). */
  exists(root, id) {
    return validId(id) && fs.existsSync(path.join(root, id, ".git"));
  }
  title(root, id) {
    try {
      return /^#\s+(.+)$/m.exec(fs.readFileSync(path.join(root, id, "README.md"), "utf8"))?.[1].trim() || id;
    } catch {
      return id;
    }
  }

  /** A work-like handle of one library, so the works' version functions (status, history, push…) apply. */
  async scope(repo, id) {
    const root = await this.dir(repo);
    if (!this.exists(root, id)) throw notFound(`${this.noun}「${id}」不存在`);
    const dir = path.join(root, id);
    return { id: this.branch(id), repo, root: dir, dir, branch: this.branch(id), library: id };
  }

  /** The id is a library's, a binned library's or GitHub's (a branch here or there). */
  async taken(repo, id) {
    const { dir } = this.services.repos.get(repo);
    for (const branch of [this.branch(id)])
      for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) if (await gitOk(dir, ["show-ref", "--verify", "--quiet", ref])) return true;
    return fs.existsSync(path.join(this.root(repo), id));
  }

  /** A key the recycle bin has (here or on GitHub). */
  async binned(repo, key) {
    const { dir } = this.services.repos.get(repo);
    const branch = this.trashBranch(key);
    for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) if (await gitOk(dir, ["show-ref", "--verify", "--quiet", ref])) return true;
    return fs.existsSync(path.join(this.root(repo), TRASH, key));
  }

  /**
   * A new library: a branch with no history, its first version holding `files` ({ name: text })
   * and, with `from`, a copy of another library's folder (moving a work to this repository).
   */
  async create(repo, id, { files = {}, from = null, message }) {
    if (!validId(id)) throw problem(400, `「${id}」不能用作${this.noun}的 id：不能有空格和 \\ / : * ? " < > | # % ~ ^ [ @，不能以 . 或 - 开头`);
    const info = this.services.repos.get(repo);
    const root = await this.dir(repo);
    const scope = await this.locks.run(repo, async () => {
      if (await this.taken(repo, id)) throw conflict(`已经有 id 为「${id}」的${this.noun}（也可能在回收站里）`);
      const dir = path.join(root, id);
      await addOrphanWorktree(info.dir, this.branch(id), dir);
      if (from) fs.cpSync(from, dir, { recursive: true, filter: (source) => !/^\.git$|^\.trashed\.json$/.test(path.basename(source)) || source === from });
      for (const [name, content] of Object.entries({ ".gitattributes": GIT_ATTRIBUTES, ...files })) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        writeFileAtomic(path.join(dir, name), content);
      }
      await git(dir, ["add", "-A"], { env: this.services.repos.env(info) });
      await git(dir, ["commit", "-q", "-m", message]);
      return { id: this.branch(id), repo, root: dir, dir, branch: this.branch(id), library: id };
    });
    this.services.works.saved(scope);
    return scope;
  }

  /**
   * Rename: the title only (the README's first "# " line), saved as a version at once. Other
   * unsaved edits of the library, the README's own included, stay unsaved.
   */
  async retitle(repo, id, title) {
    const name = String(title || "").trim();
    if (!name) throw problem(400, `请填写${this.noun}的名称`);
    if (name.length > 80 || /[\r\n]/.test(name)) throw problem(400, "名称最多 80 个字，不能换行");
    const scope = await this.scope(repo, id);
    const { works } = this.services;
    const changed = await works.locks.run(`${repo}/${scope.id}`, async () => {
      const titled = (text) => (/^#\s+.*$/m.test(text) ? text.replace(/^#\s+.*$/m, `# ${name}`) : `# ${name}\n\n${text}`);
      const file = path.join(scope.root, "README.md");
      const saved = await git(scope.root, ["show", "HEAD:README.md"]).catch(() => "");
      const next = titled(saved);
      if (next !== saved) {
        const blob = (await git(scope.root, ["hash-object", "-w", "--stdin"], { input: next })).trim();
        await git(scope.root, ["update-index", "--add", "--cacheinfo", `100644,${blob},README.md`]);
        await git(scope.root, ["commit", "-q", "-m", `${this.noun}改名为「${name}」`]);
      }
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : saved;
      if (titled(current) !== current) writeFileAtomic(file, titled(current));
      return next !== saved;
    });
    if (changed) works.saved(scope);
    return { id, title: name };
  }

  /** Move a branch to another name: on GitHub (one atomic push, refused if it moved since we looked), then here with its checkout. */
  async move(repo, from, to, sha, { dir, target }) {
    const { repos, works } = this.services;
    const info = repos.get(repo);
    if (info.remote) {
      const remote = await works.tip(info.dir, `refs/remotes/origin/${from}`);
      const lease = remote ? [`--force-with-lease=refs/heads/${from}:${remote}`] : [];
      await git(info.dir, ["push", "--atomic", ...lease, "origin", `${sha}:refs/heads/${to}`, ...(remote ? [`:refs/heads/${from}`] : [])], { env: repos.env(info) });
      await git(info.dir, ["update-ref", `refs/remotes/origin/${to}`, sha]);
      if (remote) await git(info.dir, ["update-ref", "-d", `refs/remotes/origin/${from}`]);
    }
    await git(dir, ["branch", "-m", to]);
    if (info.remote) await git(dir, ["branch", `--set-upstream-to=origin/${to}`]).catch(() => {});
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await git(info.dir, ["worktree", "move", "--", dir, target]);
  }

  /** Into the recycle bin: the library (with what was unsaved) is saved with a note, and its branch becomes `<prefix>-trash/<key>`. */
  async trash(repo, id) {
    const { repos, works } = this.services;
    const info = repos.get(repo);
    if (info.remote) await repos.fetch(repo).catch(() => {});
    const scope = await this.scope(repo, id);
    const root = await this.dir(repo);
    const title = this.title(root, id);
    const key = await this.locks.run(repo, () =>
      works.locks.run(`${repo}/${scope.id}`, async () => {
        let key = id;
        for (let n = 2; await this.binned(repo, key); n++) key = `${id}-${n}`;
        const note = path.join(scope.root, NOTE);
        writeFileAtomic(note, JSON.stringify({ id, title, deletedAt: new Date().toISOString() }, null, 2) + "\n");
        await git(scope.root, ["add", "-A"], { env: repos.env(info) });
        await git(scope.root, ["commit", "-q", "-m", `删除${this.noun}：${title}（移到回收站）`]);
        const sha = (await git(scope.root, ["rev-parse", "HEAD"])).trim();
        try {
          await this.move(repo, scope.branch, this.trashBranch(key), sha, { dir: scope.root, target: path.join(root, TRASH, key) });
        } catch (error) {
          // Nothing changed on GitHub: back as it was, unsaved edits unsaved.
          await git(scope.root, ["reset", "-q", "--mixed", "HEAD~1"]).catch(() => {});
          fs.rmSync(note, { force: true });
          throw error;
        }
        return key;
      }),
    );
    return { key, id, title };
  }

  /** A library back from the bin: under its id, or a free one when that was taken meanwhile. */
  async restore(repo, key) {
    const { repos } = this.services;
    const info = repos.get(repo);
    if (info.remote) await repos.fetch(repo).catch(() => {});
    const root = await this.dir(repo);
    const note = trashNote(root, key);
    return this.locks.run(repo, async () => {
      let id = note.id;
      for (let n = 2; await this.taken(repo, id); n++) id = `${note.id}-${n}`;
      const dir = path.join(root, TRASH, key);
      const text = fs.readFileSync(path.join(dir, NOTE), "utf8");
      fs.rmSync(path.join(dir, NOTE));
      await git(dir, ["add", "-A"], { env: repos.env(info) });
      await git(dir, ["commit", "-q", "-m", `恢复${this.noun}：${note.title}${id !== note.id ? `（id 改为「${id}」）` : ""}`]);
      const sha = (await git(dir, ["rev-parse", "HEAD"])).trim();
      try {
        await this.move(repo, this.trashBranch(key), this.branch(id), sha, { dir, target: path.join(root, id) });
      } catch (error) {
        await git(dir, ["reset", "-q", "--hard", "HEAD~1"]).catch(() => writeFileAtomic(path.join(dir, NOTE), text));
        throw error;
      }
      this.services.works.saved({ id: this.branch(id), repo, root: path.join(root, id), dir: path.join(root, id), branch: this.branch(id), library: id });
      return { id, title: note.title, renamed: id !== note.id };
    });
  }

  /** Delete binned libraries for good (`key` null: all of them): their branches here and on GitHub. */
  async purge(repo, key = null) {
    const { repos, works } = this.services;
    const info = repos.get(repo);
    if (info.remote) await repos.fetch(repo).catch(() => {});
    const root = await this.dir(repo);
    const notes = key === null ? trashed(root) : [trashNote(root, key)];
    await this.locks.run(repo, async () => {
      for (const note of notes) {
        const branch = this.trashBranch(note.key);
        const remote = info.remote ? await works.tip(info.dir, `refs/remotes/origin/${branch}`) : "";
        if (remote) {
          await git(info.dir, ["push", `--force-with-lease=refs/heads/${branch}:${remote}`, "origin", `:refs/heads/${branch}`], { env: repos.env(info) });
          await git(info.dir, ["update-ref", "-d", `refs/remotes/origin/${branch}`]);
        }
        const dir = path.join(root, TRASH, note.key);
        if (fs.existsSync(dir)) await git(info.dir, ["worktree", "remove", "--force", "--", dir]);
        if (await works.tip(info.dir, `refs/heads/${branch}`)) await git(info.dir, ["branch", "-D", branch]);
      }
      try {
        if (!fs.readdirSync(path.join(root, TRASH)).length) fs.rmdirSync(path.join(root, TRASH));
      } catch {}
    });
    return { purged: notes.map((note) => note.key), notes };
  }

  /** Save the unsaved changes of each library (`ids`, or all) as a version of its own, never one version of several. */
  async commitEach(repo, message, ids = null) {
    const { works } = this.services;
    const saved = [];
    for (const id of ids ?? (await this.ids(repo))) {
      const scope = await this.scope(repo, id);
      const commit = await works.commit(scope, message);
      if (commit) saved.push({ library: id, commit });
    }
    return saved;
  }
}

/**
 * The versions API of each library, as a work's (routes/works.mjs): `<base>/libraries/:lib/…`.
 * `versions` lists every library with its unsaved changes and last version for the 版本与同步
 * view. `changed(repo, id)` runs after the library's files moved (revert, discard, pull, merge).
 */
export function libraryVersionRoutes(services, { base, branches, changed }) {
  const { router, works } = services;
  const scope = (params) => branches.scope(params.repo, params.lib);
  const lib = `${base}/libraries/:lib`;
  const after = async (params, result) => {
    await changed(params.repo, params.lib);
    return result;
  };
  router.get(`${base}/versions`, async ({ params }) => {
    const root = await branches.dir(params.repo);
    const out = [];
    for (const id of await branches.ids(params.repo)) {
      const status = await works.status(await branches.scope(params.repo, id));
      out.push({ id, title: branches.title(root, id), files: status.files.length, head: status.head, ahead: status.ahead, behind: status.behind, remote: status.remote });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title, "zh"));
  });
  router.get(`${lib}/status`, async ({ params }) => works.status(await scope(params)));
  router.get(`${lib}/history`, async ({ params, query }) => works.history(await scope(params), { limit: Number(query.limit || 50), skip: Number(query.skip || 0) }));
  router.get(`${lib}/changes`, async ({ params, query }) => works.changes(await scope(params), query.commit));
  router.get(`${lib}/diff`, async ({ params, query }) => ({ diff: await works.diff(await scope(params), { commit: query.commit, file: query.file }) }));
  router.post(`${lib}/commit`, async ({ params, req }) => ({ commit: await works.commit(await scope(params), (await readJson(req)).message) }));
  router.post(`${lib}/revert`, async ({ params, req }) => after(params, { commit: await works.revert(await scope(params), (await readJson(req)).commit) }));
  router.post(`${lib}/discard`, async ({ params, req }) => after(params, await works.discard(await scope(params), (await readJson(req)).files || [])));
  router.post(`${lib}/sync`, async ({ params }) => works.sync(await scope(params)));
  router.post(`${lib}/push`, async ({ params }) => works.push(await scope(params)));
  router.post(`${lib}/pull`, async ({ params }) => after(params, await works.pull(await scope(params))));
  router.post(`${lib}/resolve`, async ({ params, req }) => after(params, await works.resolve(await scope(params), (await readJson(req)).strategy)));
}
