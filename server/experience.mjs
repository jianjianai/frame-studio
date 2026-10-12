import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { tree, readText, writeText, removePath, movePath } from "./files.mjs";
import { readJson } from "./http.mjs";
import { problem, notFound, conflict, confined } from "./util.mjs";
import { GIT_ATTRIBUTES } from "./templates.mjs";
import { workArg, repoArg, asJson } from "./tools/registry.mjs";
import { readLibrary, libraryBrief, experienceBrief, briefText, describeDocument } from "./ai/context.mjs";
import { editList, runFileOperations, describeFileOperations } from "./tools/file-ops.mjs";
import { findLibrary, unknownLibraries, searchLibraries, searchWords, offerOrder, readmeLead, SUGGEST, TRASH, trashed, moveToTrash, trashNote, moveFromTrash, purgeTrash } from "./libraries.mjs";
import { git, gitOk } from "./git.mjs";

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
/** The introduction a new library's README starts with (it says nothing about the library). */
const templateLead = (title) => `「${title}」类作品的制作经验。关联了这个经验库的作品，AI 开始制作时会先看这里。`;
const libraryReadme = (title) => `# ${title}

${templateLead(title)}

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
  }

  /** The experience worktree of a repository, created (or checked out from GitHub) on first use. */
  dir(repoId) {
    return this.services.repos.branchWorktree(repoId, {
      branch: EXPERIENCE_BRANCH,
      dir: path.join(this.services.config.dirs.experience, repoId),
      files: { "README.md": ROOT_README, ".gitattributes": GIT_ATTRIBUTES },
      message: "创建经验库",
    });
  }

  /** A work-like handle so the works' version functions (status, history, diff, push…) apply. */
  async scope(repoId) {
    const root = await this.dir(repoId);
    return { id: `experience-${repoId}`, repo: repoId, root, dir: root, branch: EXPERIENCE_BRANCH };
  }

  /**
   * The libraries: folder name, title, number of documents, earlier names, and the README's
   * introduction (`about`). With `documents`, also the documents' paths and titles, and as
   * `extra` the text a search by topic looks through.
   */
  async libraries(repoId, { documents = false } = {}) {
    const dir = await this.dir(repoId);
    // Earlier names, which works may still link: each with the library it leads to now.
    const aliases = Object.keys(this.aliases(dir)).map((name) => [name, this.resolve(dir, name)]);
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => {
        const files = tree(path.join(dir, entry.name), { maxEntries: 100000 }).filter((item) => item.type === "file");
        const title = this.title(dir, entry.name);
        const library = {
          id: entry.name,
          title,
          files: files.length,
          aliases: aliases.filter(([, target]) => target === entry.name).map(([name]) => name),
          about: readmeLead(path.join(dir, entry.name, "README.md"), templateLead(title)),
        };
        if (documents) {
          library.documents = files
            .filter((item) => /\.(md|txt)$/i.test(item.path) && item.path !== "README.md")
            .map((item) => {
              let title = "";
              try {
                title = describeDocument(item.path, fs.readFileSync(path.join(dir, entry.name, item.path), "utf8").slice(0, 2000)).title;
              } catch {}
              return { path: item.path, title };
            });
          library.extra = library.documents.map((doc) => `${doc.path.replace(/\.(md|txt)$/i, "")} ${doc.title}`).join(" ");
        }
        return library;
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

  /**
   * Save only these paths as a version, now: moving a library into or out of the recycle bin is
   * kept at once (other unsaved edits stay unsaved). Paths neither on disk nor in the last
   * version are left out (a library made and deleted before any version).
   */
  async commitPaths(repoId, paths, message) {
    const scope = await this.scope(repoId);
    const { works } = this.services;
    return works.locks.run(`${scope.repo}/${scope.id}`, async () => {
      const known = [];
      for (const item of paths)
        if (fs.existsSync(path.join(scope.root, item)) || (await git(scope.root, ["ls-files", "--", item]).catch(() => "")).trim()) known.push(item);
      if (!known.length) return null;
      await git(scope.root, ["add", "-A", "--", ...known]);
      if (await gitOk(scope.root, ["diff", "--cached", "--quiet", "--", ...known])) return null;
      await git(scope.root, ["commit", "-q", "-m", message, "--", ...known]);
      this.services.events.emit({ type: "work-versions", work: scope.id });
      works.saved(scope);
      return true;
    });
  }

  /**
   * Delete a library: into the recycle bin (.trash/ on the branch), saved as a version at once.
   * Works linking it see it missing until it is restored; earlier names keep leading to it.
   */
  async remove(repoId, id) {
    if (!validId(id)) throw notFound("经验库不存在");
    const dir = await this.dir(repoId);
    if (!fs.existsSync(path.join(dir, id))) throw notFound("经验库不存在");
    const title = this.title(dir, id);
    const key = moveToTrash(dir, id, title);
    await this.commitPaths(repoId, [id, TRASH], `删除经验库：${title}（移到回收站）`);
    this.changed(repoId, [id, `${TRASH}/${key}`]);
    return { key, id, title };
  }
  /** The worktree when the branch exists (here or on GitHub), else null: looking need not create it. */
  async existing(repoId) {
    if (fs.existsSync(path.join(this.services.config.dirs.experience, repoId, ".git"))) return this.dir(repoId);
    return (await this.services.repos.hasBranch(repoId, EXPERIENCE_BRANCH)) ? this.dir(repoId) : null;
  }
  /** The libraries in the recycle bin. */
  async trash(repoId) {
    const dir = await this.existing(repoId);
    return dir ? trashed(dir) : [];
  }
  /** A library back from the bin: under its name, or a free one when that was taken meanwhile. */
  async restore(repoId, key) {
    const dir = await this.dir(repoId);
    const note = trashNote(dir, key);
    // Taken: a library's name, or an earlier name works still use for one.
    let id = note.id;
    for (let n = 2; this.resolve(dir, id); n++) id = `${note.id} ${n}`;
    moveFromTrash(dir, key, id);
    await this.commitPaths(repoId, [TRASH, id], `恢复经验库：${note.title}${id !== note.id ? `（改名为「${id}」）` : ""}`);
    this.changed(repoId, [id, TRASH]);
    return { id, title: note.title, renamed: id !== note.id };
  }
  /**
   * Delete a library in the bin for good (`key` null: all of them); the history keeps them.
   * Earlier names that led to it now lead nowhere and go too.
   */
  async purge(repoId, key = null) {
    const dir = await this.dir(repoId);
    const notes = key === null ? trashed(dir) : [trashNote(dir, key)];
    if (!notes.length) return { purged: [] };
    for (const note of notes) purgeTrash(dir, note.key);
    // Earlier names of the deleted libraries (each kept one step from its library).
    const gone = new Set(notes.map((note) => note.id).filter((id) => !fs.existsSync(path.join(dir, id))));
    const aliases = this.aliases(dir);
    const left = Object.fromEntries(Object.entries(aliases).filter(([, to]) => !gone.has(to)));
    const pruned = Object.keys(left).length !== Object.keys(aliases).length;
    if (pruned) Object.keys(left).length ? writeText(dir, ALIASES, JSON.stringify(left, null, 2) + "\n") : removePath(dir, ALIASES);
    await this.commitPaths(repoId, [TRASH, ...(pruned ? [ALIASES] : [])], key === null ? "清空经验库回收站" : `从回收站删除经验库：${notes[0].title}`);
    this.changed(repoId, [TRASH, ALIASES]);
    return { purged: notes.map((note) => note.key) };
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

  /** What the AI is told about linked names that lead nowhere: in the recycle bin, or deleted. */
  goneText(work, missing) {
    if (!missing.length) return "";
    const bin = trashed(path.join(this.services.config.dirs.experience, work.repo));
    const binned = missing.filter((name) => bin.some((entry) => entry.id === name));
    const deleted = missing.filter((name) => !binned.includes(name));
    return [
      binned.length ? `作品关联的经验库${binned.map((name) => `「${name}」`).join("")}在回收站里，用户恢复后才能用（在「经验库」选项卡的回收站中恢复）。` : "",
      deleted.length ? `作品关联的经验库${deleted.map((name) => `「${name}」`).join("")}已被删除。` : "",
    ].join("");
  }

  /** How many libraries the repository has, without listing them (the brief is written synchronously). */
  countSync(repo) {
    try {
      return fs.readdirSync(path.join(this.services.config.dirs.experience, repo), { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).length;
    } catch {
      return 0;
    }
  }

  /**
   * Libraries the work does not link that are worth naming to the AI: all of a few, else
   * those that suit the work (or the most used), at most `count`. `annotated`: the
   * repository's libraries from the library index (linked, works, score, why).
   */
  offers(annotated, count = 5) {
    const others = offerOrder(annotated.filter((library) => !library.linked));
    if (others.length <= 8) return { label: "作品库里的经验库", list: others };
    const suitable = others.filter((library) => library.score >= SUGGEST).slice(0, count);
    if (suitable.length) return { label: "可能适合本作品的", list: suitable };
    return { label: "用得最多的", list: others.filter((library) => library.works).slice(0, count) };
  }
  /** One line per library for the AI: name, introduction, documents, how much it is used, why it fits. */
  offerLine(library) {
    const facts = [`${library.files} 篇文档`, library.works ? `${library.works} 个作品在用` : "", ...(library.why ?? [])].filter(Boolean).join("；");
    return `- 「${library.id}」${library.title !== library.id ? `（${library.title}）` : ""}${library.about ? `：${library.about}` : ""}（${facts}）`;
  }

  /** The libraries' section of the session brief, and what it tells the AI. */
  brief(work) {
    const { missing } = this.linkedSync(work);
    const current = this.current(work);
    const gone = this.goneText(work, missing);
    const total = this.countSync(work.repo);
    if (!current.length) {
      // What the repository has: prepared before a session starts (it needs every work's links).
      const annotated = this.services.libraries?.preparedFor(work)?.experiences;
      let offer = total ? `作品库里有 ${total} 个经验库，用 experience_list 按主题查找。` : "作品库里还没有经验库。";
      if (annotated?.length) {
        const { label, list } = this.offers(annotated);
        if (list.length)
          offer = `${label}${list.length < total ? `（作品库里共 ${total} 个，其他的用 experience_list 按主题查找）` : ""}：\n${list.map((library) => this.offerLine(library)).join("\n")}\n\n`;
      }
      const text = `## 经验库\n\n${gone || "本作品没有关联经验库。"}${offer}需要参考或记录经验时，征得用户同意后用 experience_link 关联（可以多个）或新建一个；没关联的经验库也可以用 experience_read（library 参数）先看看。`;
      return { text, state: { experience: {} } };
    }
    const { sections, seen } = experienceBrief(current);
    const several =
      current.length > 1
        ? `本作品关联了 ${current.length} 个经验库：${current.map((item) => `「${item.library.title}」`).join("")}。记录新经验时按内容选择合适的一个（工具的 library 参数）。`
        : "";
    const others = total - current.length;
    const more = others > 0 ? `作品库里还有 ${others} 个经验库没有关联（experience_list 按主题查找；要关联先征得用户同意）。` : "";
    const lead = `动手前对照经验库，照着做；和用户这次的要求冲突时以用户为准，并更新经验库。${several}${gone}${more}`;
    return { text: `${lead}\n\n${briefText(sections)}`, state: { experience: seen } };
  }

  /** For work_context: built-in agents already have the libraries in their brief, others get them here. */
  async summary(work, { inBrief = false } = {}) {
    const { missing } = this.linkedSync(work);
    const current = this.current(work);
    if (!current.length) {
      const annotated = this.services.libraries ? await this.services.libraries.annotate("experiences", work.repo, await this.libraries(work.repo), work) : [];
      const { label, list } = this.offers(annotated);
      return {
        libraries: [],
        missing,
        ...(missing.length ? { gone: this.goneText(work, missing) } : {}),
        available: annotated.length,
        ...(list.length ? { offered: label, offers: list.map(({ id, title, about, files, works, why }) => ({ library: id, title, about, documents: files, works, why })) } : {}),
        hint: `这个作品没有关联经验库${annotated.length ? `（作品库里有 ${annotated.length} 个，experience_list 按主题查找）` : ""}。用户同意后用 experience_link 关联（可以多个），用户也可以在「经验」面板的「管理…」（经验库选项卡）中关联。`,
      };
    }
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
  // With `work`: whether it links each library and how well each suits it (the picker's 推荐).
  router.get(`${base}/libraries`, async ({ params, query }) => {
    const libraries = await experience.libraries(params.repo);
    if (!services.libraries) return libraries;
    const work = query.work ? await services.openWork(query.work, params.repo) : null;
    return services.libraries.annotate("experiences", params.repo, libraries, work);
  });
  router.post(`${base}/libraries`, async ({ params, req }) => experience.create(params.repo, (await readJson(req)).name));
  router.delete(`${base}/libraries/:lib`, ({ params }) => experience.remove(params.repo, params.lib));
  // The recycle bin of deleted libraries.
  router.get(`${base}/trash`, ({ params }) => experience.trash(params.repo));
  router.post(`${base}/trash/:key/restore`, ({ params }) => experience.restore(params.repo, params.key));
  router.delete(`${base}/trash/:key`, ({ params }) => experience.purge(params.repo, params.key));
  router.delete(`${base}/trash`, ({ params }) => experience.purge(params.repo));
  router.post(`${base}/libraries/:lib/rename`, async ({ params, req }) => experience.rename(params.repo, params.lib, (await readJson(req)).name));

  // ---- files (same shape as a work's file API, so the editor tabs reuse it) --------------
  // One library's documents (paths from the branch root), or the whole branch.
  router.get(`${base}/tree`, async ({ params, query }) => {
    const dir = await experience.dir(params.repo);
    if (!query.library) return tree(dir);
    if (!validId(query.library) || !fs.existsSync(path.join(dir, query.library))) throw notFound("经验库不存在");
    return tree(confined(dir, query.library)).map((entry) => ({ ...entry, path: `${query.library}/${entry.path}` }));
  });
  /** Documents of every library whose name or title has all the words (the 经验 view's filter). */
  router.get(`${base}/find`, async ({ params, query }) => {
    const words = searchWords(query.q);
    if (!words.length) return [];
    const dir = await experience.dir(params.repo);
    const found = [];
    for (const library of await experience.libraries(params.repo))
      for (const entry of tree(path.join(dir, library.id), { maxEntries: 100000 })) {
        if (entry.type !== "file" || !/\.(md|txt)$/i.test(entry.path)) continue;
        let title = "";
        try {
          title = describeDocument(entry.path, fs.readFileSync(path.join(dir, library.id, entry.path), "utf8").slice(0, 2000)).title;
        } catch {}
        const text = `${entry.path} ${title}`.toLowerCase();
        if (words.every((word) => text.includes(word))) found.push({ library: library.id, path: `${library.id}/${entry.path}`, title });
        if (found.length >= 200) return found;
      }
    return found;
  });
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
  router.get(`${base}/changes`, async ({ params, query }) => works.changes(await scope(params), query.commit));
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
      // Linked libraries by name or title first (cheap); any other library of the repository after.
      const id =
        experience.resolve(dir, name.trim()) ?? findLibrary(name, libraries)?.id ?? findLibrary(name, await experience.libraries(work.repo), (alias) => experience.resolve(dir, alias))?.id;
      if (!id)
        throw problem(400, unknownLibraries("experiences", [name.trim()], await experience.libraries(work.repo), trashed(dir)).replace(/新建用 create$/, "新建用 experience_link 的 create"), "NO_EXPERIENCE");
      return { work, library: libraries.find((item) => item.id === id) ?? { id, title: experience.title(dir, id), root: path.join(dir, id), dir } };
    }
    if (!libraries.length)
      throw problem(
        409,
        missing.length
          ? `${experience.goneText(work, missing)}用 experience_link 关联其他经验库（先征得用户同意），或请用户在「经验」面板的「管理…」（经验库选项卡）中关联或恢复。`
          : `这个作品没有关联经验库${experience.countSync(work.repo) ? `（作品库里有 ${experience.countSync(work.repo)} 个，用 experience_list 查找；没关联的也可以用 library 参数读）` : ""}。用 experience_link 关联已有的或新建一个（先征得用户同意），或请用户在「经验」面板的「管理…」（经验库选项卡）中关联。`,
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

  tools.add({
    name: "experience_list",
    title: "查找经验库",
    description:
      "列出或按主题查找作品库里的经验库：名称、介绍、文档数、几个作品在用、本作品是否已关联、为什么适合本作品。query 按名称、介绍和文档标题找（例如「开场」「卡点」「知识类」），同时列出相关的文档；不给 query 时本作品关联的在前，其余按适合本作品的程度和使用次数排列。经验库很多时用它找合适的，征得用户同意后用 experience_link 关联；没关联的也可以先用 experience_read（library 参数）看看。还没有作品时用 repo 指定作品库。",
    readOnly: true,
    input: {
      work: workArg,
      repo: repoArg,
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    },
    async run({ query, limit, offset }, ctx) {
      const place = await ctx.place();
      const work = place.dir ? place : null;
      const all = await experience.libraries(place.repo, { documents: Boolean(query?.trim()) });
      const annotated = services.libraries ? await services.libraries.annotate("experiences", place.repo, all, work) : all;
      const order = work ? experience.linkedSync(work).libraries.map((library) => library.id) : [];
      const linked = annotated.filter((library) => library.linked).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      const ordered = query?.trim() ? searchLibraries(annotated, query) : [...linked, ...offerOrder(annotated.filter((library) => !library.linked))];
      const page = ordered.slice(offset, offset + limit);
      const words = searchWords(query);
      const line = (library) => {
        const facts = [`${library.files} 篇文档`, library.works ? `${library.works} 个作品在用` : "没有作品在用", library.linked ? "本作品已关联" : "", ...(library.linked ? [] : (library.why ?? []))].filter(Boolean).join("；");
        const docs = words.length ? (library.documents ?? []).filter((doc) => words.some((word) => `${doc.path} ${doc.title}`.toLowerCase().includes(word))).slice(0, 4) : [];
        return [
          `- 「${library.id}」${library.title !== library.id ? `（${library.title}）` : ""}${library.about ? `：${library.about}` : ""}（${facts}）`,
          ...(docs.length ? [`  相关文档：${docs.map((doc) => `${doc.path}${doc.title ? `（${doc.title}）` : ""}`).join("、")}`] : []),
        ].join("\n");
      };
      const head = `作品库 ${place.repo} 有 ${all.length} 个经验库${work ? `，本作品关联了 ${linked.length} 个${linked.length ? `：${linked.map((library) => `「${library.title}」`).join("")}` : ""}` : ""}。`;
      const body = query?.trim()
        ? ordered.length
          ? `与「${query.trim()}」相关的 ${ordered.length} 个${ordered.length > page.length ? `（第 ${offset + 1}–${offset + page.length} 个）` : ""}：\n${page.map(line).join("\n")}`
          : `没有找到与「${query.trim()}」相关的经验库（按名称、介绍和文档标题找）。换个说法，或用 search（scope: ["experience"]）搜文档内容。`
        : all.length
          ? `${offset ? `第 ${offset + 1}–${offset + page.length} 个` : "本作品关联的在前，其余按适合本作品的程度和使用次数"}：\n${page.map(line).join("\n")}`
          : "还没有经验库：征得用户同意后用 experience_link 的 create 新建。";
      const rest = ordered.length - offset - page.length;
      const more = rest > 0 ? `\n还有 ${rest} 个：offset: ${offset + page.length} 看下一页${query?.trim() ? "" : "，或用 query 按主题查找"}。` : "";
      const next = page.length ? "\n关联用 experience_link（先征得用户同意）；看内容用 experience_read 的 library（不用先关联）。" : "";
      return {
        data: { total: all.length, matched: ordered.length, libraries: page.map(({ extra, documents, ...library }) => library) },
        text: `${head}\n${body}${more}${next}`,
      };
    },
  });

  const nameArg = z.string().min(1).max(60).describe("经验库名称（文件夹名或标题）");
  tools.add({
    name: "experience_link",
    published: true, // creating libraries is fine on a published work; changing its links is checked below
    title: "关联经验库",
    description:
      "增加或移除本作品关联的经验库（project.ts 的 experiences，可以多个）。add 关联已有的经验库，create 新建经验库（带首页模板）并关联（同名的已存在时直接关联），remove 取消关联（经验库本身不受影响）。名称写文件夹名或标题（大小写、空格、标点不同也能认出）；不存在时返回最接近的几个，经验库很多时先用 experience_list 查找。用户要求时使用；不确定时先问用户。返回新关联的经验库的首页和目录（小的经验库返回全文）。",
    input: { work: workArg, add: z.array(nameArg).max(10).default([]), remove: z.array(nameArg).max(10).default([]), create: z.array(nameArg).max(5).default([]) },
    async run({ add, remove, create }, ctx) {
      const work = await ctx.work();
      const published = Boolean(works.published(work));
      if (published && (add.length || remove.length))
        throw problem(423, "作品已发布，不能改变它关联的经验库。经验库本身可以照常整理（用 library 参数指定），也可以用 create 新建。要改关联，请用户先取消发布或创建副本。", "PUBLISHED");
      const dir = await experience.dir(work.repo);
      const all = await experience.libraries(work.repo);
      // A folder name (or an earlier one), a library's title, or either written a little differently.
      const find = (name) => findLibrary(name, all, (alias) => experience.resolve(dir, alias))?.id ?? null;
      const unknown = add.filter((name) => !find(name));
      if (unknown.length) throw problem(400, unknownLibraries("experiences", unknown, all, trashed(dir)));
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
      "把经验库里未保存的修改保存为一个版本（Git 提交）。同一作品库的经验库在同一个分支上，会一起保存，和用户在「版本与同步」→ 经验库里点「保存版本」一样。整理完经验、用户认可后调用；message 用一句话说明改了什么。push: true 时保存后推送到 GitHub（作品库连接了 GitHub 时）。",
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
      const pushText = !pushed ? "" : pushed.ok ? "，已推送到 GitHub" : `。推送到 GitHub 失败：${pushed.error}（请用户在「版本与同步」→ 经验库中处理）`;
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
      "修改经验库中的 Markdown 文档（路径相对经验库，例如 README.md、开场.md），一次可以做多个操作，按顺序执行：write（新建或整篇重写）、edit（精确替换：每个 oldText 必须与文档逐字一致且恰好出现一次，否则设 replaceAll）、delete（合并到其他文档后删掉旧的）、move（改名）。整理经验时按主题合并到已有文档，不要重复记录；新文档第一行写「# 标题」，下一行一句话说明讲什么（会显示在目录里）。失败的逐项说明原因，只需重试失败的。修改是未保存状态：用户认可后用 experience_commit 保存版本（用户也可以在「版本与同步」中保存）。",
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
