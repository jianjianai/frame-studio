import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { git, gitOk, addOrphanWorktree } from "./git.mjs";
import { tree, readText, writeText, removePath, movePath } from "./files.mjs";
import { readJson } from "./http.mjs";
import { problem, notFound, conflict, confined, Locks } from "./util.mjs";
import { GIT_ATTRIBUTES } from "./templates.mjs";
import { workArg, asJson } from "./tools/registry.mjs";
import { readLibrary, libraryBrief, experienceBrief, briefText } from "./ai/context.mjs";
import { editList, runFileOperations, describeFileOperations } from "./tools/file-ops.mjs";

/**
 * Experience libraries: Markdown documents of production know-how, shared by the works
 * of a content repository. They live on the repository's `frame/experience` branch
 * (checked out at <home>/experience/<repo>/); each top-level folder is one library.
 * A work links libraries (`experiences` in project.ts) by folder name. The AI reads them
 * before working, keeps them organized, links them and saves their versions on request;
 * people edit them in the studio. Versions work like a
 * work's. Renaming a library leaves an alias (old name → new name in .aliases.json, on the
 * same branch), so links in works that cannot be rewritten (published, only on GitHub) still
 * find it.
 */
export const EXPERIENCE_BRANCH = "frame/experience";
const ROOT_README = `# FRAME 经验库

每个文件夹是一个经验库（例如“知识类视频”“音乐视频”），里面是 Markdown 写的制作经验。
作品在 FRAME Studio 中关联一个经验库后，AI 开始制作前会先阅读它，也会把新的经验整理进来。
`;
const libraryReadme = (title) => `# ${title}

「${title}」类作品的制作经验。关联了这个经验库的作品，AI 开始制作时会先看这里。

## 用户偏好

- （用户明确提出过的喜好和要求）

## 通用做法

- （这类作品都适用的结构、节奏、风格。按主题展开的经验另建文档，例如“开场.md”“配色与字体.md”）
`;

const ALIASES = ".aliases.json";
/** A library folder name from what the user typed. */
const folderOf = (name) =>
  String(name || "")
    .trim()
    .replace(/[\\/:*?"<>|#%\x00-\x1f]+/g, "-")
    .replace(/^[.\s-]+/, "")
    .slice(0, 60);

const validId = (id) => typeof id === "string" && /^[^\\/:*?"<>|#%\x00-\x1f.][^\\/:*?"<>|#%\x00-\x1f]{0,59}$/.test(id);

export class Experience {
  constructor(services) {
    this.services = services;
    this.locks = new Locks();
  }

  /** The experience worktree of a repository, created (or checked out from GitHub) on first use. */
  async dir(repoId) {
    const { repos, config } = this.services;
    const repo = repos.get(repoId);
    const dir = path.join(config.dirs.experience, repoId);
    return this.locks.run(repoId, async () => {
      if (fs.existsSync(path.join(dir, ".git"))) return dir;
      if (repo.remote) await git(repo.dir, ["fetch", "--prune", "origin"], { env: repos.env(repo) }).catch(() => {});
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await git(repo.dir, ["worktree", "prune"]);
      const local = await gitOk(repo.dir, ["show-ref", "--verify", "--quiet", "refs/heads/" + EXPERIENCE_BRANCH]);
      const remote = await gitOk(repo.dir, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/" + EXPERIENCE_BRANCH]);
      if (local) await git(repo.dir, ["worktree", "add", "--", dir, EXPERIENCE_BRANCH]);
      else if (remote) await git(repo.dir, ["worktree", "add", "--track", "-b", EXPERIENCE_BRANCH, "--", dir, "origin/" + EXPERIENCE_BRANCH]);
      else {
        await addOrphanWorktree(repo.dir, EXPERIENCE_BRANCH, dir);
        fs.writeFileSync(path.join(dir, "README.md"), ROOT_README);
        fs.writeFileSync(path.join(dir, ".gitattributes"), GIT_ATTRIBUTES);
        await git(dir, ["add", "--", "README.md", ".gitattributes"]);
        await git(dir, ["commit", "-q", "-m", "创建经验库"]);
      }
      return dir;
    });
  }

  /** A work-like handle so the works' version functions (status, history, diff, push…) apply. */
  async scope(repoId) {
    const root = await this.dir(repoId);
    return { id: `experience-${repoId}`, repo: repoId, root, dir: root, branch: EXPERIENCE_BRANCH };
  }

  async libraries(repoId) {
    const dir = await this.dir(repoId);
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => {
        const files = tree(path.join(dir, entry.name)).filter((item) => item.type === "file");
        // Earlier names, which works may still link.
        const aliases = Object.keys(this.aliases(dir)).filter((name) => this.resolve(dir, name) === entry.name);
        return { id: entry.name, title: this.title(dir, entry.name), files: files.length, aliases };
      })
      .sort((a, b) => a.title.localeCompare(b.title, "zh"));
  }

  title(dir, id) {
    try {
      return /^#\s+(.+)$/m.exec(fs.readFileSync(path.join(dir, id, "README.md"), "utf8"))?.[1].trim() || id;
    } catch {
      return id;
    }
  }

  async create(repoId, name) {
    const title = String(name || "").trim();
    const id = folderOf(title);
    if (!validId(id)) throw problem(400, "请填写经验库名称");
    const dir = await this.dir(repoId);
    this.assertFree(dir, id);
    writeText(dir, `${id}/README.md`, libraryReadme(title));
    this.changed(repoId, [`${id}/README.md`]);
    return { id, title };
  }

  /** A new folder name may be neither a library nor an earlier name works still link. */
  assertFree(dir, id) {
    if (fs.existsSync(path.join(dir, id))) throw conflict(`已经有名为「${id}」的经验库`);
    const target = this.resolve(dir, id);
    if (target) throw conflict(`「${id}」是经验库「${this.title(dir, target)}」以前的名称，有作品还在用它，请换一个名称`);
  }

  /**
   * Rename a library: its folder (with an alias from the old name) and its README title.
   * Like other edits of the libraries it is unsaved until the user saves a version.
   */
  async rename(repoId, id, name) {
    const title = String(name || "").trim();
    const next = folderOf(title);
    if (!validId(next)) throw problem(400, "请填写经验库名称");
    const dir = await this.dir(repoId);
    if (!validId(id) || !fs.existsSync(path.join(dir, id))) throw notFound("经验库不存在");
    if (next !== id) {
      // Going back to one of its own earlier names is fine.
      if (this.resolve(dir, next) !== id) this.assertFree(dir, next);
      movePath(dir, id, next);
      const aliases = this.aliases(dir);
      // Keep every earlier name one step from the library.
      for (const [from, to] of Object.entries(aliases)) if (to === id) aliases[from] = next;
      delete aliases[next];
      aliases[id] = next;
      writeText(dir, ALIASES, JSON.stringify(aliases, null, 2) + "\n");
    }
    const readme = path.join(dir, next, "README.md");
    const content = fs.existsSync(readme) ? fs.readFileSync(readme, "utf8") : "";
    writeText(dir, `${next}/README.md`, /^#\s+.*$/m.test(content) ? content.replace(/^#\s+.*$/m, `# ${title}`) : `# ${title}\n\n${content}`);
    this.changed(repoId, [id, next, ALIASES], next !== id ? { from: id, to: next } : undefined);
    return { id: next, title };
  }

  async remove(repoId, id) {
    if (!validId(id)) throw notFound("经验库不存在");
    const dir = await this.dir(repoId);
    if (!fs.existsSync(path.join(dir, id))) throw notFound("经验库不存在");
    removePath(dir, id);
    // Earlier names led here; links through them now point at nothing, like the library's own.
    const aliases = this.aliases(dir);
    const left = Object.fromEntries(Object.entries(aliases).filter(([, to]) => to !== id));
    if (Object.keys(left).length !== Object.keys(aliases).length)
      Object.keys(left).length ? writeText(dir, ALIASES, JSON.stringify(left, null, 2) + "\n") : removePath(dir, ALIASES);
    this.changed(repoId, [id, ALIASES]);
  }

  /** Earlier library names: { old folder name: newer folder name }. */
  aliases(dir) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, ALIASES), "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }
  /** The library folder a (possibly earlier) name stands for, or null. */
  resolve(dir, id) {
    const aliases = this.aliases(dir);
    for (let hops = 0; validId(id) && hops < 20; hops++) {
      if (fs.existsSync(path.join(dir, id))) return id;
      id = aliases[id];
    }
    return null;
  }

  /** `moved` ({from, to}) lets open editor tabs follow a renamed folder or document. */
  changed(repo, files, moved) {
    this.services.events.emit({ type: "experience-files", repo, files, ...(moved ? { moved } : {}) });
  }

  /** The library names a work links (project.ts `experiences`), in its order. */
  names(work) {
    const value = this.services.works.meta(work).meta?.experiences;
    return Array.isArray(value) ? [...new Set(value.filter(validId))] : [];
  }

  /**
   * The work's libraries as they are now (renames followed), read synchronously, and the
   * names that lead nowhere (deleted libraries). Needs the libraries checked out (prepare).
   */
  linkedSync(work) {
    const dir = path.join(this.services.config.dirs.experience, work.repo);
    const libraries = [];
    const missing = [];
    for (const name of this.names(work)) {
      const id = this.resolve(dir, name);
      if (!id) missing.push(name);
      else if (!libraries.some((item) => item.id === id)) libraries.push({ id, title: this.title(dir, id), root: path.join(dir, id), dir });
    }
    return { libraries, missing };
  }
  async linked(work) {
    await this.prepare(work);
    return this.linkedSync(work);
  }

  /** Check the libraries out if the work links any (the synchronous readers need the folder). */
  async prepare(work) {
    if (this.names(work).length) await this.dir(work.repo);
  }

  /** The linked libraries' ids and titles, cheaply (for the work's description). */
  link(work) {
    const { libraries, missing } = this.linkedSync(work);
    return { libraries: libraries.map(({ id, title }) => ({ id, title })), missing };
  }

  /** The linked libraries with their documents (session brief, per-message changes). */
  current(work) {
    return this.linkedSync(work).libraries.map(({ id, title, root }) => ({ library: { id, title }, documents: readLibrary(root) }));
  }

  /**
   * What the AI knew under earlier library names, under the current ones: a renamed library
   * is not "unlinked and linked again".
   */
  follow(work, seen) {
    if (!seen) return {};
    const dir = path.join(this.services.config.dirs.experience, work.repo);
    const next = {};
    for (const [id, entry] of Object.entries(seen)) {
      const current = this.resolve(dir, id) ?? id;
      if (!next[current]) next[current] = current === id ? entry : { ...entry, title: this.title(dir, current) };
    }
    return next;
  }

  /** The libraries' section of the session brief, and what it tells the AI. */
  brief(work) {
    const { missing } = this.linkedSync(work);
    const current = this.current(work);
    const gone = missing.length ? `作品关联的经验库「${missing.join("」「")}」已被删除。` : "";
    if (!current.length) {
      const text = `## 经验库\n\n${gone || "本作品没有关联经验库。"}需要记录经验时，征得用户同意后用 experience_link 关联已有的经验库或新建一个。`;
      return { text, state: { experience: {} } };
    }
    const { sections, seen } = experienceBrief(current);
    const several =
      current.length > 1
        ? `本作品关联了 ${current.length} 个经验库：${current.map((item) => `「${item.library.title}」`).join("")}。记录新经验时按内容选择合适的一个（工具的 library 参数）。`
        : "";
    const lead = `动手前对照经验库，照着做；和用户这次的要求冲突时以用户为准，并更新经验库。${several}${gone}`;
    return { text: `${lead}\n\n${briefText(sections)}`, state: { experience: seen } };
  }

  /** For work_context: built-in agents already have the libraries in their brief, others get them here. */
  summary(work, { inBrief = false } = {}) {
    const { missing } = this.linkedSync(work);
    const current = this.current(work);
    if (!current.length)
      return { libraries: [], missing, hint: "这个作品没有关联经验库。用户同意后用 experience_link 关联（可以多个），用户也可以在左侧「经验」中选择。" };
    return {
      libraries: current.map(({ library, documents }) => ({
        library: library.id,
        title: library.title,
        documents: documents.map(({ path: file, title, summary, chars }) => ({ path: file, title, summary, chars })),
        ...(inBrief ? {} : { readme: documents.find((doc) => doc.path === "README.md")?.content.slice(0, Math.floor(6000 / current.length)) ?? "" }),
      })),
      missing,
      ...(inBrief ? { note: "内容在会话说明的「经验库」一节" } : {}),
    };
  }
}

export function experiencePlugin(services) {
  const { router, tools, works } = services;
  const experience = (services.experience = new Experience(services));
  works.briefProviders.push((work) => experience.brief(work));
  /** Tell the chat session (if any) what its AI just read or wrote, so it is not told again. */
  const noteSeen = (ctx, library, file, hash, level) => ctx.scope.session && services.ai?.noteExperience(ctx.scope.session, library.id, file, hash, level);
  const base = "/api/repos/:repo/experience";
  const scope = (params) => experience.scope(params.repo);

  // ---- libraries ----------------------------------------------------------------
  router.get(`${base}/libraries`, ({ params }) => experience.libraries(params.repo));
  router.post(`${base}/libraries`, async ({ params, req }) => experience.create(params.repo, (await readJson(req)).name));
  router.delete(`${base}/libraries/:lib`, ({ params }) => experience.remove(params.repo, params.lib));
  router.post(`${base}/libraries/:lib/rename`, async ({ params, req }) => experience.rename(params.repo, params.lib, (await readJson(req)).name));

  // ---- files (same shape as a work's file API, so the editor tabs reuse it) --------------
  router.get(`${base}/tree`, async ({ params }) => tree(await experience.dir(params.repo)));
  router.get(`${base}/file`, async ({ params, query }) => readText(await experience.dir(params.repo), query.path));
  router.put(`${base}/file`, async ({ params, req }) => {
    const body = await readJson(req);
    const result = writeText(await experience.dir(params.repo), body.path, body.content, { expectedHash: body.expectedHash });
    experience.changed(params.repo, [body.path]);
    return result;
  });
  router.post(`${base}/move`, async ({ params, req }) => {
    const body = await readJson(req);
    movePath(await experience.dir(params.repo), body.from, body.to);
    experience.changed(params.repo, [body.from, body.to], { from: body.from, to: body.to });
  });
  router.delete(`${base}/file`, async ({ params, query }) => {
    removePath(await experience.dir(params.repo), query.path);
    experience.changed(params.repo, [query.path]);
  });

  // ---- versions: the works' implementation on the experience branch ----------------------
  router.get(`${base}/status`, async ({ params }) => works.status(await scope(params)));
  router.get(`${base}/history`, async ({ params, query }) =>
    works.history(await scope(params), { limit: Number(query.limit || 50), skip: Number(query.skip || 0) }),
  );
  router.get(`${base}/diff`, async ({ params, query }) => ({ diff: await works.diff(await scope(params), { commit: query.commit, file: query.file }) }));
  router.post(`${base}/commit`, async ({ params, req }) => ({ commit: await works.commit(await scope(params), (await readJson(req)).message) }));
  router.post(`${base}/revert`, async ({ params, req }) => {
    const result = { commit: await works.revert(await scope(params), (await readJson(req)).commit) };
    experience.changed(params.repo, []);
    return result;
  });
  router.post(`${base}/discard`, async ({ params, req }) => {
    await works.discard(await scope(params), (await readJson(req)).files || []);
    experience.changed(params.repo, []);
  });
  router.post(`${base}/sync`, async ({ params }) => works.sync(await scope(params)));
  router.post(`${base}/push`, async ({ params }) => works.push(await scope(params)));
  router.post(`${base}/pull`, async ({ params }) => {
    const result = await works.pull(await scope(params));
    experience.changed(params.repo, []);
    return result;
  });
  router.post(`${base}/resolve`, async ({ params, req }) => {
    const result = await works.resolve(await scope(params), (await readJson(req)).strategy);
    experience.changed(params.repo, []);
    return result;
  });

  // ---- AI tools ---------------------------------------------------------------------
  /**
   * The library a tool call means: the `library` argument (any library of the repository, so
   * the AI can also organize libraries the work does not link), or the only one the work links.
   */
  const libraryOf = async (ctx, name) => {
    const work = await ctx.work();
    const { libraries, missing } = await experience.linked(work);
    if (name?.trim()) {
      const dir = await experience.dir(work.repo);
      const all = await experience.libraries(work.repo);
      const id = experience.resolve(dir, name.trim()) ?? all.find((item) => item.title === name.trim())?.id;
      if (!id)
        throw problem(400, `经验库「${name}」不存在。现有的经验库：${all.map((item) => `「${item.title}」`).join("") || "（无）"}；新建用 experience_link 的 create`, "NO_EXPERIENCE");
      return { work, library: libraries.find((item) => item.id === id) ?? { id, title: experience.title(dir, id), root: path.join(dir, id), dir } };
    }
    if (!libraries.length)
      throw problem(
        409,
        missing.length
          ? `关联的经验库「${missing.join("」「")}」已被删除。用 experience_link 关联其他经验库（先征得用户同意），或请用户在左侧「经验」面板中选择。`
          : "这个作品没有关联经验库。用 experience_link 关联已有的或新建一个（先征得用户同意），或请用户在左侧「经验」面板中选择。",
        "NO_EXPERIENCE",
      );
    if (libraries.length === 1) return { work, library: libraries[0] };
    throw problem(400, `作品关联了多个经验库：${libraries.map((item) => `「${item.id}」`).join("")}，用 library 参数指定一个`, "LIBRARY_REQUIRED");
  };
  const docPath = z.string().min(1).max(300).describe("经验库内的相对路径，例如 README.md 或 开场.md");
  const libraryArg = z.string().max(80).optional().describe("经验库名称；作品关联了多个经验库时必填。整理经验库时也可以指定作品没有关联的经验库");

  tools.add({
    name: "experience_read",
    title: "阅读经验库",
    description:
      "阅读作品关联的经验库（同类作品积累的制作经验、用户偏好和避坑记录）。传 path 返回该文档全文，一次读多篇用 paths；不传返回首页和文档目录（内置 AI 的会话说明里已经有，通常不需要）。与当前任务相关的文档读全文，照着做。作品关联了多个经验库时，读文档要用 library 指定是哪个。",
    readOnly: true,
    input: { work: workArg, library: libraryArg, path: docPath.optional(), paths: z.array(docPath).max(30).optional().describe("一次读同一经验库的多篇文档") },
    async run({ library: name, path: file, paths }, ctx) {
      if (paths?.length) {
        const { library } = await libraryOf(ctx, name);
        const parts = [];
        const data = [];
        for (const doc of paths)
          try {
            const result = readText(library.root, doc);
            noteSeen(ctx, library, doc, result.hash, "content");
            parts.push(`=== ${doc}\n${result.content}`);
            data.push({ path: doc, ok: true, sha256: result.hash });
          } catch (error) {
            parts.push(`=== ${doc}：${error.message}`);
            data.push({ path: doc, ok: false, error: error.message });
          }
        return { data: { library: library.id, documents: data }, text: parts.join("\n\n") };
      }
      if (!file && !name) {
        // The overview of every linked library.
        const work = await ctx.work();
        const { libraries } = await experience.linked(work);
        if (!libraries.length) await libraryOf(ctx); // explains why there is none
        const current = libraries.map(({ id, title, root }) => ({ library: { id, title }, documents: readLibrary(root) }));
        const { sections } = experienceBrief(current);
        for (const section of sections)
          for (const [doc, entry] of Object.entries(section.docs))
            noteSeen(
              ctx,
              libraries.find((item) => item.id === section.library.id),
              doc,
              entry.hash,
              entry.level,
            );
        return {
          data: current.map(({ library, documents }) => ({ library: library.id, title: library.title, documents: documents.map(({ path: doc, title, summary }) => ({ path: doc, title, summary })) })),
          text: briefText(sections),
        };
      }
      const { library } = await libraryOf(ctx, name);
      if (file) {
        const result = readText(library.root, file);
        noteSeen(ctx, library, file, result.hash, "content");
        return { data: { path: file, sha256: result.hash }, meta: { library: library.id, path: file, sha256: result.hash }, text: result.content };
      }
      const documents = readLibrary(library.root);
      const brief = libraryBrief({ id: library.id, title: library.title }, documents);
      for (const [doc, entry] of Object.entries(brief.docs)) noteSeen(ctx, library, doc, entry.hash, entry.level);
      return {
        data: { library: library.id, title: library.title, documents: documents.map(({ path: doc, title, summary }) => ({ path: doc, title, summary })) },
        text: briefText([brief]),
      };
    },
  });

  const nameArg = z.string().min(1).max(60).describe("经验库名称");
  tools.add({
    name: "experience_link",
    published: true, // creating libraries is fine on a published work; changing its links is checked below
    title: "关联经验库",
    description:
      "增加或移除本作品关联的经验库（project.ts 的 experiences，可以多个）。add 关联已有的经验库，create 新建经验库（带首页模板）并关联（同名的已存在时直接关联），remove 取消关联（经验库本身不受影响）。用户要求时使用；不确定时先问用户。返回新关联的经验库的首页和目录（小的经验库返回全文）。",
    input: { work: workArg, add: z.array(nameArg).max(10).default([]), remove: z.array(nameArg).max(10).default([]), create: z.array(nameArg).max(5).default([]) },
    async run({ add, remove, create }, ctx) {
      const work = await ctx.work();
      const published = Boolean(works.published(work));
      if (published && (add.length || remove.length))
        throw problem(423, "作品已发布，不能改变它关联的经验库。经验库本身可以照常整理（用 library 参数指定），也可以用 create 新建。要改关联，请用户先取消发布或创建副本。", "PUBLISHED");
      const dir = await experience.dir(work.repo);
      const all = await experience.libraries(work.repo);
      // A folder name (or an earlier one), or a library's title.
      const find = (name) => experience.resolve(dir, name.trim()) ?? all.find((item) => item.title === name.trim())?.id ?? null;
      const unknown = add.filter((name) => !find(name));
      if (unknown.length)
        throw problem(400, `经验库不存在：${unknown.join("、")}。现有的经验库：${all.map((item) => `「${item.title}」`).join("") || "（无）"}；新建用 create`);
      const adding = add.map(find);
      const created = [];
      for (const name of create) {
        const id = find(name) ?? (await experience.create(work.repo, name)).id;
        if (!all.some((item) => item.id === id)) created.push(id);
        adding.push(id);
      }
      if (published)
        return asJson(
          { created, experiences: experience.linkedSync(work).libraries.map(({ id, title }) => ({ id, title })) },
          `${created.length ? `已新建经验库：${created.map((id) => `「${id}」`).join("")}` : "没有新建经验库（同名的已存在）"}。作品已发布，没有关联到它；读写时用 library 参数指定。`,
        );
      const before = experience.linkedSync(work).libraries;
      // Links through earlier names or to deleted libraries can be removed too.
      const dropping = new Set(remove.map((name) => find(name) ?? name.trim()));
      const kept = experience.names(work).filter((name) => !dropping.has(experience.resolve(dir, name) ?? name));
      await works.update(work, { experiences: [...new Set([...kept, ...adding])] });
      const after = experience.linkedSync(work).libraries;
      const added = after.filter((item) => !before.some((old) => old.id === item.id));
      const removed = before.filter((item) => !after.some((now) => now.id === item.id));
      // The new libraries as a brief shows them; the session then knows them like its brief.
      const { sections, seen } = experienceBrief(added.map(({ id, title, root }) => ({ library: { id, title }, documents: readLibrary(root) })));
      if (ctx.scope.session) services.ai?.noteExperienceLibraries(ctx.scope.session, { added: seen, removed: removed.map((item) => item.id) });
      return {
        data: { experiences: after.map(({ id, title }) => ({ id, title })), added: added.map((item) => item.id), removed: removed.map((item) => item.id) },
        text: [
          `本作品关联的经验库：${after.map((item) => `「${item.title}」`).join("") || "（无）"}`,
          removed.length ? `已取消关联：${removed.map((item) => `「${item.title}」`).join("")}，之前读到的那些经验不再适用于这个作品。` : "",
          sections.length ? `新关联的经验库，动手前对照，照着做：\n\n${briefText(sections)}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
    },
  });

  tools.add({
    name: "experience_commit",
    published: true, // the experience branch, not the work: allowed on a published work
    title: "保存经验库版本",
    description:
      "把经验库里未保存的修改保存为一个版本（Git 提交）。同一作品库的经验库在同一个分支上，会一起保存，和用户在「经验」面板点「保存版本」一样。整理完经验、用户认可后调用；message 用一句话说明改了什么。push: true 时保存后推送到 GitHub（作品库连接了 GitHub 时）。",
    input: { work: workArg, message: z.string().min(1).max(200), push: z.boolean().default(false) },
    async run({ message, push }, ctx) {
      const work = await ctx.work();
      const scope = await experience.scope(work.repo);
      const files = (await works.status(scope)).files.map((file) => file.path);
      const commit = await works.commit(scope, message);
      let pushed = null;
      if (push)
        try {
          await works.push(scope);
          pushed = { ok: true };
        } catch (error) {
          pushed = { ok: false, error: error.message };
        }
      const pushText = !pushed ? "" : pushed.ok ? "，已推送到 GitHub" : `。推送到 GitHub 失败：${pushed.error}（请用户在「经验」面板的版本与同步中处理）`;
      return asJson(
        { commit, files, pushed },
        commit ? `已保存经验库版本 ${commit.slice(0, 7)}：${files.join("、")}${pushText}` : `经验库没有未保存的修改${pushText}`,
      );
    },
  });

  const opPath = z.string().min(1).max(300);
  const docOperation = z.discriminatedUnion("op", [
    z.strictObject({ op: z.literal("write"), path: opPath, content: z.string().max(512 * 1024), expectedSha256: z.string().optional() }),
    z.strictObject({ op: z.literal("edit"), path: opPath, edits: editList }),
    z.strictObject({ op: z.literal("delete"), path: opPath }),
    z.strictObject({ op: z.literal("move"), from: opPath, to: opPath }),
  ]);
  tools.add({
    name: "experience_write",
    published: true, // writes outside the work: allowed on a published (view-only) work
    title: "整理经验库",
    description:
      "修改经验库中的 Markdown 文档（路径相对经验库，例如 README.md、开场.md），一次可以做多个操作，按顺序执行：write（新建或整篇重写）、edit（精确替换：每个 oldText 必须与文档逐字一致且恰好出现一次，否则设 replaceAll）、delete（合并到其他文档后删掉旧的）、move（改名）。整理经验时按主题合并到已有文档，不要重复记录；新文档第一行写「# 标题」，下一行一句话说明讲什么（会显示在目录里）。失败的逐项说明原因，只需重试失败的。修改是未保存状态：用户认可后用 experience_commit 保存版本（用户也可以在「经验」面板中保存）。",
    destructive: true,
    input: { work: workArg, library: libraryArg, operations: z.array(docOperation).min(1).max(30) },
    async run({ library: name, operations }, ctx) {
      const { work, library } = await libraryOf(ctx, name);
      const outcome = runFileOperations(library.root, operations, {
        reader: "experience_read",
        allow: (item, paths) => {
          if (paths.some((file) => !/\.(md|txt)$/i.test(file))) throw problem(400, "经验库只存放 .md 或 .txt 文档");
          if (paths[0] === "README.md" && (item.op === "delete" || item.op === "move")) throw problem(400, "README.md 是经验库的入口，不能删除或改名");
        },
      });
      const changed = [...new Set(outcome.changed)];
      for (const file of changed) {
        const exists = fs.existsSync(path.join(library.root, file));
        noteSeen(ctx, library, file, exists ? readText(library.root, file).hash : null, exists ? "content" : undefined);
      }
      if (changed.length) experience.changed(work.repo, changed.map((file) => `${library.id}/${file}`));
      const { summary } = describeFileOperations(outcome);
      return {
        data: { library: library.id, applied: outcome.applied, results: outcome.results },
        text: `经验库「${library.title}」：${summary}${changed.length ? "\n修改未保存：用户认可后用 experience_commit 保存版本。" : ""}`,
      };
    },
  });
}
