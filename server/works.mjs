import fs from "node:fs";
import path from "node:path";
import { git, gitOk, parseStatus, addOrphanWorktree } from "./git.mjs";
import { readProjectSource, readProjectDir, setProjectFields, validSlug } from "./project-meta.mjs";
import { appRoot } from "./config.mjs";
import { problem, notFound, conflict, Locks, shortId, writeFileAtomic } from "./util.mjs";
import { createWorkFiles, platformInstructions, workTsconfig, GIT_ATTRIBUTES } from "./templates.mjs";
import { clip, quote, LIMITS } from "./ai/context.mjs";
import { LOCAL_REPO } from "./repos.mjs";

const WORK_PREFIX = "works/";
const TRASH_PREFIX = "trash/";
const validWorkId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);

/**
 * A work is one branch `works/<id>` in a content repository with its files in
 * `projects/<slug>/`. Opening a work checks the branch out to works/<repo>/<id>,
 * the single place where the editor, preview, AI agents, CLI and MCP all read and write.
 */
export class Works {
  /** Sections added to every work's session brief, e.g. the linked experience library: (work) => { text, state } | null. */
  briefProviders = [];

  constructor({ config, settings, repos, events }) {
    this.config = config;
    this.settings = settings;
    this.repos = repos;
    this.events = events;
    this.locks = new Locks();
    this.metaCache = new Map();
  }

  root(repo, id) {
    return path.join(this.config.dirs.works, repo, id);
  }

  async refs(repo) {
    const out = await git(this.repos.get(repo).dir, [
      "for-each-ref",
      "--format=%(refname)%09%(objectname)%09%(committerdate:iso-strict)",
      "refs/heads/works",
      "refs/remotes/origin/works",
      "refs/heads/trash",
    ]);
    const works = new Map();
    for (const line of out.split("\n").filter(Boolean)) {
      const [ref, oid, date] = line.split("\t");
      const [scope, id] = ref.startsWith("refs/heads/works/")
        ? ["local", ref.slice("refs/heads/works/".length)]
        : ref.startsWith("refs/heads/trash/")
          ? ["trash", ref.slice("refs/heads/trash/".length)]
          : ["remote", ref.slice("refs/remotes/origin/works/".length)];
      if (!validWorkId(id)) continue;
      const entry = works.get(id) || { id, repo };
      entry[scope] = { ref, oid, date };
      works.set(id, entry);
    }
    return [...works.values()];
  }

  async metaAt(repo, ref, oid) {
    const key = repo + ":" + oid;
    if (this.metaCache.has(key)) return this.metaCache.get(key);
    const dir = this.repos.get(repo).dir;
    let summary;
    try {
      const names = (await git(dir, ["ls-tree", "--name-only", ref, "projects/"])).split("\n").filter(Boolean);
      const slug = names.map((name) => name.slice(9)).find((name) => validSlug(name));
      if (!slug) throw new Error("no projects/<slug>/");
      const { meta } = readProjectSource(await git(dir, ["show", `${ref}:projects/${slug}/project.ts`]));
      summary = metaSummary(slug, meta);
    } catch (error) {
      summary = { slug: "", title: "(无法读取的作品)", error: error.message };
    }
    this.metaCache.set(key, summary);
    if (this.metaCache.size > 2000) this.metaCache.delete(this.metaCache.keys().next().value);
    return summary;
  }

  /** List works of one or all repositories. Checked-out works report live metadata. */
  async list({ repo, trash = false } = {}) {
    const repos = repo ? [this.repos.get(repo)] : this.repos.list().filter((item) => item.ready);
    const result = [];
    for (const { id: repoId } of repos) {
      for (const entry of await this.refs(repoId)) {
        if (trash ? !entry.trash : !entry.local && !entry.remote) continue;
        const head = trash ? entry.trash : entry.local || entry.remote;
        const root = this.root(repoId, entry.id);
        const checkedOut = !trash && fs.existsSync(path.join(root, ".git"));
        let summary = await this.metaAt(repoId, head.ref, head.oid);
        if (checkedOut && summary.slug) {
          try {
            summary = metaSummary(summary.slug, readProjectDir(path.join(root, "projects", summary.slug)).meta);
          } catch {}
        }
        result.push({
          id: entry.id,
          repo: repoId,
          ...summary,
          updatedAt: head.date,
          location: trash ? "trash" : entry.local && entry.remote ? "both" : entry.local ? "local" : "remote",
          checkedOut,
        });
      }
    }
    return result.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /** Find which repository holds a work id. */
  async locate(id, repo) {
    if (!validWorkId(id)) throw problem(400, `无效的作品 id：${id}`);
    const candidates = repo
      ? [repo]
      : this.repos
          .list()
          .filter((item) => item.ready)
          .map((item) => item.id);
    const found = [];
    for (const repoId of candidates) {
      if (fs.existsSync(path.join(this.root(repoId, id), ".git"))) {
        found.push(repoId);
        continue;
      }
      const dir = this.repos.get(repoId).dir;
      if (
        (await gitOk(dir, ["show-ref", "--verify", "--quiet", "refs/heads/works/" + id])) ||
        (await gitOk(dir, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/works/" + id]))
      )
        found.push(repoId);
    }
    if (!found.length) throw notFound(`作品不存在：${id}`);
    if (found.length > 1) throw conflict(`作品 id ${id} 同时存在于 ${found.join("、")}，请指定作品库`);
    return found[0];
  }

  /** Check out (if needed) and describe a work. Cheap when already open. */
  async open(id, repo) {
    repo = await this.locate(id, repo);
    const root = this.root(repo, id);
    await this.locks.run(`${repo}/${id}`, async () => {
      if (!fs.existsSync(path.join(root, ".git"))) {
        const dir = this.repos.get(repo).dir;
        await git(dir, ["worktree", "prune"]);
        fs.mkdirSync(path.dirname(root), { recursive: true });
        const branch = WORK_PREFIX + id;
        if (await gitOk(dir, ["show-ref", "--verify", "--quiet", "refs/heads/" + branch])) await git(dir, ["worktree", "add", "--", root, branch]);
        else await git(dir, ["worktree", "add", "--track", "-b", branch, "--", root, "origin/" + branch]);
      }
      this.linkRuntime(root);
    });
    const work = this.describe(repo, id);
    this.writeBrief(work);
    return work;
  }

  describe(repo, id) {
    const root = this.root(repo, id);
    const projects = path.join(root, "projects");
    const slugs = fs.existsSync(projects)
      ? fs.readdirSync(projects).filter((name) => validSlug(name) && fs.existsSync(path.join(projects, name, "project.ts")))
      : [];
    if (slugs.length !== 1) throw conflict(`作品分支应当只有一个 projects/<名称>/project.ts，实际找到 ${slugs.length} 个`);
    const slug = slugs[0];
    return { id, repo, branch: WORK_PREFIX + id, root, slug, dir: path.join(projects, slug) };
  }

  /** Read a work's metadata; invalid project.ts is reported, not thrown. */
  meta(work) {
    try {
      return { ok: true, ...readProjectDir(work.dir) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /** The shared engine and dependencies are linked, never copied or committed. */
  linkRuntime(root) {
    const link = (name, target) => {
      const file = path.join(root, name);
      try {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() && fs.readlinkSync(file) === target) return;
        if (!stat.isSymbolicLink()) return; // a real directory belongs to the work; leave it alone
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      fs.symlinkSync(target, file, process.platform === "win32" ? "junction" : "dir");
    };
    link("src", path.join(appRoot, "src"));
    link("node_modules", path.join(appRoot, "node_modules"));
    link("docs", path.join(appRoot, "docs"));
    writeIfChanged(path.join(root, "tsconfig.json"), workTsconfig());
  }

  /**
   * The session brief at the work root: AGENTS.md (read by Codex; Claude Code imports it
   * through CLAUDE.md). Platform rules, the work's own notes, and sections from
   * `briefProviders` (the linked experience library). Agents load it when a session starts
   * or resumes and keep it through context compaction. Returns what the brief told the AI
   * (`{ experience: seen }`), the baseline for later per-message changes.
   */
  writeBrief(work) {
    const parts = [platformInstructions()];
    let notes = "";
    try {
      notes = fs.readFileSync(path.join(work.dir, "AGENTS.md"), "utf8").trim();
    } catch {}
    const { text, cut } = clip(notes, LIMITS.notes);
    parts.push(
      `## 本作品的需求与约定（projects/${work.slug}/AGENTS.md${cut ? "，以下是开头部分" : ""}）\n\n${notes ? quote(text) : "（还没有记录）"}\n\n用户确认的新需求和这个作品专属的约定，写回这个文件。`,
    );
    const state = {};
    for (const provider of this.briefProviders) {
      const section = provider(work);
      if (!section) continue;
      if (section.text) parts.push(section.text);
      Object.assign(state, section.state);
    }
    writeIfChanged(path.join(work.root, "AGENTS.md"), parts.join("\n\n") + "\n");
    writeIfChanged(path.join(work.root, "CLAUDE.md"), "@AGENTS.md\n");
    return state;
  }

  async create({ repo = LOCAL_REPO, title, width = 1920, height = 1080, duration = 10, fps = 30, description = "" }) {
    if (typeof title !== "string" || !title.trim()) throw problem(400, "作品名称不能为空");
    const dir = this.repos.get(repo).dir;
    const id = shortId();
    const slug = "work-" + id;
    const root = this.root(repo, id);
    await this.locks.run(`${repo}/${id}`, async () => {
      fs.mkdirSync(path.dirname(root), { recursive: true });
      await git(dir, ["worktree", "prune"]);
      await addOrphanWorktree(dir, WORK_PREFIX + id, root);
      try {
        for (const [file, content] of Object.entries(createWorkFiles({ slug, title: title.trim(), width, height, duration, fps, description })))
          writeFileAtomic(path.join(root, file), content);
        this.linkRuntime(root);
        await git(root, ["add", "-A", "--", "."]);
        await git(root, ["commit", "-m", `创建作品：${title.trim()}`]);
      } catch (error) {
        await git(dir, ["worktree", "remove", "--force", "--", root]).catch(() => {});
        await git(dir, ["branch", "-D", WORK_PREFIX + id]).catch(() => {});
        throw error;
      }
    });
    this.touch(repo, id);
    this.events.emit({ type: "works", repo });
    return this.describe(repo, id);
  }

  /** Create a work from an existing project folder (one containing project.ts). */
  async importFolder({ repo = LOCAL_REPO, source }) {
    if (!fs.existsSync(path.join(source, "project.ts"))) throw problem(400, "文件夹中没有 project.ts");
    const slug = validSlug(path.basename(source)) ? path.basename(source) : "work-" + shortId();
    const { meta } = readProjectSource(fs.readFileSync(path.join(source, "project.ts"), "utf8"));
    const dir = this.repos.get(repo).dir;
    const id = shortId();
    const root = this.root(repo, id);
    await this.locks.run(`${repo}/${id}`, async () => {
      fs.mkdirSync(path.dirname(root), { recursive: true });
      await addOrphanWorktree(dir, WORK_PREFIX + id, root);
      try {
        fs.cpSync(source, path.join(root, "projects", slug), {
          recursive: true,
          filter: (file) => !/[\\/](exports|\.cache|node_modules|\.git|test-results|playwright-report)([\\/]|$)/.test(path.relative(source, file)),
        });
        writeFileAtomic(path.join(root, "README.md"), `# ${meta.title || slug}\n\nFRAME 作品。使用 FRAME Studio 打开、预览和导出。\n`);
        writeFileAtomic(path.join(root, ".gitignore"), "exports/\n.cache/\nnode_modules/\n");
        // Before the copied media are added, so they are stored in LFS.
        writeFileAtomic(path.join(root, ".gitattributes"), GIT_ATTRIBUTES);
        this.linkRuntime(root);
        await git(root, ["add", "-A", "--", "."]);
        await git(root, ["commit", "-q", "-m", `导入作品：${meta.title || slug}`]);
      } catch (error) {
        await git(dir, ["worktree", "remove", "--force", "--", root]).catch(() => {});
        await git(dir, ["branch", "-D", WORK_PREFIX + id]).catch(() => {});
        throw error;
      }
    });
    this.events.emit({ type: "works", repo });
    return this.describe(repo, id);
  }

  async update(work, changes) {
    const file = path.join(work.dir, "project.ts");
    const allowed = ["title", "subtitle", "description", "duration", "fps", "accent", "tags", "status", "subtitles", "beats", "experience"];
    if ("experience" in changes && typeof changes.experience !== "string") throw problem(400, "experience 必须是经验库名称（空字符串表示不关联）");
    const picked = Object.fromEntries(Object.entries(changes).filter(([key]) => allowed.includes(key)));
    writeFileAtomic(file, setProjectFields(fs.readFileSync(file, "utf8"), picked));
    this.events.emit({ type: "works", repo: work.repo });
  }

  async trash(id, repo) {
    repo = await this.locate(id, repo);
    const dir = this.repos.get(repo).dir;
    const root = this.root(repo, id);
    await this.locks.run(`${repo}/${id}`, async () => {
      if (fs.existsSync(root)) {
        const status = parseStatus(await git(root, ["status", "--porcelain=v2", "--branch"]));
        if (status.files.length) await this.commitAll(root, "删除前自动保存");
        await git(dir, ["worktree", "remove", "--force", "--", root]);
      }
      if (await gitOk(dir, ["show-ref", "--verify", "--quiet", "refs/heads/works/" + id]))
        await git(dir, ["branch", "-M", WORK_PREFIX + id, TRASH_PREFIX + id]);
      else await git(dir, ["branch", TRASH_PREFIX + id, "origin/" + WORK_PREFIX + id]);
    });
    this.settings.update("recent", (recent) => recent.filter((item) => !(item.id === id && item.repo === repo)));
    this.events.emit({ type: "works", repo });
  }

  async restore(id, repo) {
    const dir = this.repos.get(repo).dir;
    if (await gitOk(dir, ["show-ref", "--verify", "--quiet", "refs/heads/works/" + id])) throw conflict("同名作品已存在");
    await git(dir, ["branch", "-M", TRASH_PREFIX + id, WORK_PREFIX + id]);
    this.events.emit({ type: "works", repo });
  }

  /** Permanently delete a trashed work locally; optionally also delete the remote branch. */
  async purge(id, repo, { remote = false } = {}) {
    const info = this.repos.get(repo);
    await git(info.dir, ["branch", "-D", TRASH_PREFIX + id]);
    if (remote && info.remote) await git(info.dir, ["push", "origin", "--delete", WORK_PREFIX + id], { env: this.repos.env(info) });
    this.events.emit({ type: "works", repo });
  }

  touch(repo, id) {
    this.settings.update("recent", (recent) =>
      [{ repo, id, openedAt: new Date().toISOString() }, ...recent.filter((item) => !(item.id === id && item.repo === repo))].slice(0, 30),
    );
  }

  // ---- versions -------------------------------------------------------

  async status(work) {
    const status = parseStatus(await git(work.root, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]));
    const head = (await git(work.root, ["log", "-1", "--format=%H%x09%s%x09%cI"]).catch(() => "")).trim().split("\t");
    return { ...status, head: head[0] ? { commit: head[0], message: head[1], date: head[2] } : null, remote: Boolean(this.repos.get(work.repo).remote) };
  }

  async commitAll(root, message) {
    await git(root, ["add", "-A", "--", "."]);
    if (await gitOk(root, ["diff", "--cached", "--quiet"])) return null;
    await git(root, ["commit", "-q", "-m", message]);
    return (await git(root, ["rev-parse", "HEAD"])).trim();
  }

  /** Save a version of everything changed in the work. Returns null when nothing changed. */
  async commit(work, message) {
    const commit = await this.locks.run(`${work.repo}/${work.id}`, () => this.commitAll(work.root, message || "保存版本"));
    if (commit) this.events.emit({ type: "work-versions", work: work.id });
    return commit;
  }

  async history(work, { limit = 50, skip = 0 } = {}) {
    const out = await git(work.root, ["log", `--max-count=${limit}`, `--skip=${skip}`, "--format=%H%x09%h%x09%s%x09%cI%x09%an", "--shortstat"]);
    const versions = [];
    for (const line of out.split("\n")) {
      if (line.includes("\t")) {
        const [commit, short, message, date, author] = line.split("\t");
        versions.push({ commit, short, message, date, author });
      } else if (line.trim() && versions.length) versions.at(-1).stat = line.trim();
    }
    return versions;
  }

  async changes(work, commit) {
    const args = commit ? ["show", "--format=", "--name-status", commit] : ["diff", "HEAD", "--name-status"];
    const out = await git(work.root, args);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split("\t");
        return { status: status[0], path: rest.at(-1) };
      });
  }

  async diff(work, { commit, file } = {}) {
    const args = commit ? ["show", "--format=", commit] : ["diff", "HEAD"];
    const tracked = await git(work.root, [...args, "--", ...(file ? [file] : [])], { maxBytes: 4 * 1024 * 1024 });
    if (commit) return tracked;
    // New files are not in `git diff HEAD`; show them as added in full.
    const untracked = (await git(work.root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...(file ? [file] : [])])).split("\0").filter(Boolean);
    const added = [];
    for (const path of untracked.slice(0, 50))
      added.push(await git(work.root, ["diff", "--no-index", "--", "/dev/null", path], { allowCodes: [0, 1], maxBytes: 1024 * 1024 }));
    return tracked + added.join("");
  }

  async fileAt(work, commit, file) {
    return git(work.root, ["show", `${commit}:${file}`], { maxBytes: 16 * 1024 * 1024 });
  }

  /** Make the work's files equal to an earlier version, as a new version (history is kept). */
  async revert(work, commit) {
    return this.locks.run(`${work.repo}/${work.id}`, async () => {
      await this.commitAll(work.root, "恢复前自动保存");
      await git(work.root, ["rev-parse", "--verify", commit + "^{commit}"]);
      await git(work.root, ["read-tree", "-u", "--reset", commit]);
      const short = commit.slice(0, 7);
      const result = await this.commitAll(work.root, `恢复到版本 ${short}`);
      this.events.emit({ type: "work-versions", work: work.id });
      return result;
    });
  }

  /** Discard uncommitted changes (back to the last saved version). */
  async discard(work, files = []) {
    return this.locks.run(`${work.repo}/${work.id}`, async () => {
      const paths = files.length ? files : ["."];
      await git(work.root, ["checkout", "HEAD", "--", ...paths]).catch(() => {});
      await git(work.root, ["clean", "-fd", "--", ...paths]);
    });
  }

  async sync(work) {
    const repo = this.repos.get(work.repo);
    if (!repo.remote) return { remote: false };
    await this.repos.fetch(work.repo);
    const status = await this.status(work);
    const hasRemote = await gitOk(repo.dir, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/" + work.branch]);
    return { remote: true, hasRemote, ...status };
  }

  async push(work) {
    const repo = this.repos.get(work.repo);
    if (!repo.remote) throw problem(400, "这个作品库没有连接 GitHub，先在作品库设置中发布到 GitHub");
    return this.locks.run(`${work.repo}/${work.id}`, async () => {
      await this.commitAll(work.root, "同步前自动保存");
      await git(work.root, ["push", "-u", "origin", work.branch], { env: this.repos.env(repo) });
      this.events.emit({ type: "work-versions", work: work.id });
      return this.status(work);
    });
  }

  /** Resolve a diverged work: merge both sides (fails on conflicts) or adopt the remote, keeping a backup ref. */
  async resolve(work, strategy) {
    return this.locks.run(`${work.repo}/${work.id}`, async () => {
      await this.commitAll(work.root, "合并前自动保存");
      if (strategy === "merge") {
        try {
          await git(work.root, ["merge", "--no-edit", "-m", "合并 GitHub 上的修改", "origin/" + work.branch]);
        } catch (error) {
          await git(work.root, ["merge", "--abort"]).catch(() => {});
          throw conflict("双方修改了同一处内容，无法自动合并。可以采用 GitHub 的版本（本地版本保留为备份），或手动修改后再推送。", { git: error.message });
        }
      } else if (strategy === "remote") {
        const backup = `refs/frame-backup/${work.id}/${new Date().toISOString().replace(/[:.]/g, "-")}`;
        await git(work.root, ["update-ref", backup, "HEAD"]);
        await git(work.root, ["reset", "--hard", "origin/" + work.branch]);
      } else throw problem(400, "未知的处理方式");
      this.events.emit({ type: "work-versions", work: work.id });
      return this.status(work);
    });
  }

  async pull(work) {
    const repo = this.repos.get(work.repo);
    if (!repo.remote) throw problem(400, "这个作品库没有连接 GitHub");
    return this.locks.run(`${work.repo}/${work.id}`, async () => {
      await git(repo.dir, ["fetch", "--prune", "origin"], { env: this.repos.env(repo) });
      const status = parseStatus(await git(work.root, ["status", "--porcelain=v2", "--branch"]));
      if (status.files.length) throw conflict("作品有未保存的修改，请先保存版本再拉取");
      try {
        await git(work.root, ["merge", "--ff-only", "origin/" + work.branch]);
      } catch (error) {
        throw conflict("本地和 GitHub 上都有新的修改。可以选择合并双方，或采用 GitHub 的版本（本地版本会保留为备份）。", {
          diverged: true,
          git: error.message,
        });
      }
      this.events.emit({ type: "work-versions", work: work.id });
      return this.status(work);
    });
  }
}

function metaSummary(slug, meta) {
  const composition = meta.composition || { width: 1920, height: 1080 };
  return {
    slug,
    title: String(meta.title || slug),
    subtitle: String(meta.subtitle || ""),
    description: String(meta.description || ""),
    duration: Number(meta.duration) || 0,
    fps: Number(meta.fps) || 30,
    width: composition.width,
    height: composition.height,
    accent: meta.accent || "",
    status: meta.status || "draft",
    poster: meta.poster || "",
  };
}

function writeIfChanged(file, content) {
  try {
    if (fs.readFileSync(file, "utf8") === content) return;
  } catch {}
  fs.writeFileSync(file, content);
}
