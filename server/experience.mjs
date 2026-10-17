import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { tree, readText, writeText, removePath, movePath } from "./files.mjs";
import { readJson } from "./http.mjs";
import { problem, notFound, confined } from "./util.mjs";
import { workArg, repoArg, asJson } from "./tools/registry.mjs";
import { readLibrary, experienceKnown, libraryOverview, describeDocument } from "./ai/context.mjs";
import { EXPERIENCE_INBOX } from "./works.mjs";
import { editList, runFileOperations, describeFileOperations } from "./tools/file-ops.mjs";
import { findLibrary, unknownLibraries, searchLibraries, searchWords, offerOrder, readmeLead, SUGGEST, trashed } from "./libraries.mjs";
import { LibraryBranches, libraryVersionRoutes, validId, idFrom } from "./library-branches.mjs";
import { frontmatter, validSkillName } from "./skills.mjs";

/**
 * Experience libraries: Markdown documents of production know-how, shared by the works
 * of a content repository. Each library is a branch `experience/<id>` of its own, checked out
 * at <home>/experience/<repo>/<id>/ (library-branches.mjs), with its own versions and sync.
 * A work links libraries (`experiences` in project.ts) by id, which never changes; renaming
 * changes the title (the README's first "# " line). The AI reads them before working, keeps
 * them organized, links them and saves their versions on request; people edit them in the
 * studio, and save each library's changes as its own version.
 */
/** The introduction a new library's README starts with (it says nothing about the library). */
const templateLead = (title) => `「${title}」类作品的制作经验。关联了这个经验库的作品，AI 开始制作时会先看这里。`;
const libraryReadme = (title) => `# ${title}

${templateLead(title)}
`;

/**
 * A skill of the repository (skills.mjs) linked like an experience library: its id is
 * `skill:<skill>`, its documents are the skill's Markdown files where they are (nothing is
 * copied), and a change to them is a version of the skills, saved at once like any change made
 * in the studio (an AI's at the end of its turn).
 */
export const SKILL_LIBRARY = "skill:";
const skillOf = (id) => (typeof id === "string" && id.startsWith(SKILL_LIBRARY) && validSkillName(id.slice(SKILL_LIBRARY.length)) ? id.slice(SKILL_LIBRARY.length) : null);
/** What of a skill is its documents: its Markdown (a .txt in a skill is mostly a program's data). */
const SKILL_DOCUMENT = /\.(md|markdown)$/i;
/** A skill's documents, and the folders leading to them. */
const skillTree = (root) => {
  const entries = tree(root, { maxEntries: 100000 });
  const documents = entries.filter((entry) => entry.type === "file" && SKILL_DOCUMENT.test(entry.path));
  const folders = new Set(documents.flatMap((entry) => entry.path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"))));
  return entries.filter((entry) => (entry.type === "dir" ? folders.has(entry.path) : SKILL_DOCUMENT.test(entry.path)));
};

/** A version's message from what the AI said it recorded (else the files it changed). */
export const versionMessage = (notes, files) => {
  const said = [...new Set(notes.map((note) => String(note || "").trim()).filter(Boolean))].join("；");
  return (said || `记录经验：${files.join("、")}`).slice(0, 200);
};

export class Experience {
  constructor(services) {
    this.services = services;
    this.branches = new LibraryBranches(services, { prefix: "experience", base: "experience", noun: "经验库" });
  }

  /** The folder holding the repository's library checkouts. */
  dir(repoId) {
    return this.branches.dir(repoId);
  }
  /** One library as a work-like handle, so the works' version functions (status, history, diff, push…) apply. */
  scope(repoId, id) {
    return this.branches.scope(repoId, id);
  }

  /**
   * The libraries: id, title, number of documents and the README's introduction (`about`).
   * With `documents`, also the documents' paths and titles, and as `extra` the text a search by
   * topic looks through.
   */
  async libraries(repoId, { documents = false } = {}) {
    const dir = await this.dir(repoId);
    const entry = (library, root, files) => {
      library.files = files.length;
      if (documents) {
        library.documents = files
          .filter((item) => /\.(md|markdown|txt)$/i.test(item.path) && item.path !== "README.md")
          .map((item) => {
            let title = "";
            try {
              title = describeDocument(item.path, fs.readFileSync(path.join(root, item.path), "utf8").slice(0, 2000)).title;
            } catch {}
            return { path: item.path, title };
          });
        library.extra = library.documents.map((doc) => `${doc.path.replace(/\.(md|markdown|txt)$/i, "")} ${doc.title}`).join(" ");
      }
      return library;
    };
    const branches = (await this.branches.ids(repoId)).map((id) => {
      const title = this.title(dir, id);
      const files = tree(path.join(dir, id), { maxEntries: 100000 }).filter((item) => item.type === "file");
      return entry({ id, title, about: readmeLead(path.join(dir, id, "README.md"), templateLead(title)) }, path.join(dir, id), files);
    });
    const skills = (await this.skills(repoId)).map(({ id, name, root, about }) =>
      entry({ id, title: name, about, skill: name }, root, skillTree(root).filter((item) => item.type === "file")),
    );
    return [...branches, ...skills].sort((a, b) => a.title.localeCompare(b.title, "zh"));
  }

  /** The repository's skills as libraries: `skill:<name>`, the folder, what SKILL.md says the skill is for. */
  async skills(repoId) {
    const { skills } = this.services;
    if (!skills) return [];
    await skills.ready(repoId);
    return skills.namesSync(repoId).map((name) => {
      const root = path.join(skills.folder(repoId), name);
      let about = "";
      try {
        about = frontmatter(fs.readFileSync(path.join(root, "SKILL.md"), "utf8"))?.description ?? "";
      } catch {}
      return { id: SKILL_LIBRARY + name, name, root, about: about.length > 160 ? about.slice(0, 159) + "…" : about };
    });
  }

  /**
   * A library by id as it is here: { id, title, root, dir }, and `skill` for a skill's
   * documents (its folder is the skill's). Null when there is none (deleted, in the bin).
   */
  locate(repoId, id) {
    const name = skillOf(id);
    if (name) {
      const dir = path.join(this.services.config.dirs.skills, repoId);
      return fs.existsSync(path.join(dir, name, "SKILL.md")) ? { id, title: name, root: path.join(dir, name), dir, skill: name } : null;
    }
    const dir = path.join(this.services.config.dirs.experience, repoId);
    return this.branches.exists(dir, id) ? { id, title: this.title(dir, id), root: path.join(dir, id), dir } : null;
  }
  /** A library's documents with their text (a skill's: its Markdown only). */
  documents(library) {
    return readLibrary(library.root, library.skill ? SKILL_DOCUMENT : undefined);
  }
  /** The document a path from the libraries' root means (`<library id>/<path>`): its library and the path in it. */
  async place(repoId, file) {
    await this.dir(repoId);
    if (skillOf(String(file || "").split("/")[0])) await this.services.skills?.ready(repoId);
    const [id, ...rest] = String(file || "").split("/");
    const library = this.locate(repoId, id);
    if (!library || !rest.length) throw problem(400, `${file} 不在任何经验库里：路径写成 <经验库 id>/<文档>，新经验库先新建`);
    return { library, path: rest.join("/") };
  }

  title(dir, id) {
    return this.branches.title(dir, id);
  }

  /** A new library (its id from the name, for good), saved at once with its README. */
  async create(repoId, name) {
    const title = String(name || "").trim();
    const id = idFrom(title);
    if (!title || !validId(id)) throw problem(400, "请填写经验库名称");
    await this.branches.create(repoId, id, { files: { "README.md": libraryReadme(title) }, message: `新建经验库：${title}` });
    this.changed(repoId, [`${id}/README.md`]);
    return { id, title };
  }

  /** A new name (the README's title), saved at once; the id works link stays. */
  async rename(repoId, id, name) {
    const result = await this.branches.retitle(repoId, id, name);
    this.changed(repoId, [`${id}/README.md`]);
    return result;
  }

  /** Delete a library: into the recycle bin (with its unsaved edits). Works linking it see it missing until it is restored. */
  async remove(repoId, id) {
    const result = await this.branches.trash(repoId, id);
    this.changed(repoId, [id]);
    return result;
  }
  /** The libraries' folder (looking creates no branch). */
  existing(repoId) {
    return this.dir(repoId);
  }
  /** The libraries in the recycle bin. */
  async trash(repoId) {
    return trashed(await this.dir(repoId));
  }
  /** A library back from the bin: under its id, or a free one when that was taken meanwhile. */
  async restore(repoId, key) {
    const result = await this.branches.restore(repoId, key);
    this.changed(repoId, [result.id]);
    return result;
  }
  /** Delete binned libraries for good (`key` null: all of them), versions and all. */
  async purge(repoId, key = null) {
    const result = await this.branches.purge(repoId, key);
    this.changed(repoId, []);
    return { purged: result.purged };
  }

  /**
   * At the end of an AI turn: each library the AI wrote to becomes a version of what it wrote
   * (only those files: someone's other edits stay unsaved). `writes`: [{ repo, library, files, notes }].
   */
  async saveTurn(writes) {
    for (const { repo, library, files, notes } of writes)
      try {
        const skill = skillOf(library);
        // A skill's documents: a version of the skills (with whatever else the AI changed in them).
        if (skill) await this.services.skills?.save(repo, versionMessage(notes, [...files].map((file) => `${skill}/${file}`)));
        else await this.branches.commitPaths(repo, library, [...files], versionMessage(notes, [...files]));
      } catch (error) {
        console.warn(`saving experience ${repo}/${library} after a turn failed:`, error.message);
      }
  }

  /** `moved` ({from, to}) lets open editor tabs follow a moved document. */
  changed(repo, files, moved) {
    this.services.events.emit({ type: "experience-files", repo, files, ...(moved ? { moved } : {}) });
  }

  /** The library names a work links (project.ts `experiences`), in its order. */
  names(work) {
    const value = this.services.works.meta(work).meta?.experiences;
    return Array.isArray(value) ? [...new Set(value.filter((name) => validId(name) || skillOf(name)))] : [];
  }

  /**
   * The work's libraries as they are now (renames followed), read synchronously, and the
   * names that lead nowhere (deleted libraries). Needs the libraries checked out (prepare).
   */
  linkedSync(work) {
    const libraries = [];
    const missing = [];
    for (const name of this.names(work)) {
      const library = this.locate(work.repo, name);
      if (!library) missing.push(name);
      else if (!libraries.some((item) => item.id === library.id)) libraries.push(library);
    }
    return { libraries, missing };
  }
  async linked(work) {
    await this.prepare(work);
    return this.linkedSync(work);
  }

  /**
   * What moving a work to repository `to` means for its linked libraries: those `to` lacks are
   * copied there as they are now (`copy`); a library with the same id there is linked instead
   * (`shared`).
   */
  async movePlan(work, to) {
    const names = this.names(work);
    const plan = { copy: [], shared: [] };
    if (!names.length) return plan;
    const source = await this.dir(work.repo);
    const target = await this.dir(to);
    for (const id of names) {
      if (!this.branches.exists(source, id)) continue;
      const library = { id, title: this.title(source, id) };
      if (this.branches.exists(target, id)) plan.shared.push(library);
      else plan.copy.push(library);
    }
    return plan;
  }

  /** Before the work moves: copy the libraries `to` lacks, each a new library there (with what was unsaved). */
  async carry(work, to, from) {
    const plan = await this.movePlan(work, to);
    const source = await this.dir(work.repo);
    for (const { id } of plan.copy) await this.branches.create(to, id, { from: path.join(source, id), message: `从「${from}」迁入` });
    if (plan.copy.length) this.changed(to, plan.copy.map((library) => library.id));
    return plan;
  }

  /** Check the libraries out if the work links any (the synchronous readers need the folder). */
  async prepare(work) {
    const names = this.names(work);
    if (names.length) await this.dir(work.repo);
    if (names.some(skillOf)) await this.services.skills?.ready(work.repo);
  }

  /** The linked libraries' ids and titles, cheaply (for the work's description). */
  link(work) {
    const { libraries, missing } = this.linkedSync(work);
    return { libraries: libraries.map(({ id, title }) => ({ id, title })), missing };
  }

  /** The linked libraries with their documents (session brief, per-message changes). */
  current(work) {
    return this.linkedSync(work).libraries.map((library) => ({ library: { id: library.id, title: library.title }, documents: this.documents(library) }));
  }

  /** What the AI knew of each library, under its title as it is now: a renamed library is not a new one. */
  follow(work, seen) {
    if (!seen) return {};
    return Object.fromEntries(
      Object.entries(seen).map(([id, entry]) => {
        const library = this.locate(work.repo, id);
        return [id, library ? { ...entry, title: library.title } : entry];
      }),
    );
  }

  /** What the AI is told about linked names that lead nowhere: in the recycle bin, or deleted. */
  goneText(work, missing) {
    if (!missing.length) return "";
    const bin = trashed(path.join(this.services.config.dirs.experience, work.repo));
    const binned = missing.filter((name) => bin.some((entry) => entry.id === name));
    const skills = missing.filter((name) => skillOf(name));
    const deleted = missing.filter((name) => !binned.includes(name) && !skills.includes(name));
    return [
      skills.length ? `作品关联的技能${skills.map((name) => `「${skillOf(name)}」`).join("")}已不在这个作品库的技能里。` : "",
      binned.length ? `作品关联的经验库${binned.map((name) => `「${name}」`).join("")}在回收站里，用户恢复后才能用（在「经验库」选项卡的回收站中恢复）。` : "",
      deleted.length ? `作品关联的经验库${deleted.map((name) => `「${name}」`).join("")}已被删除。` : "",
    ].join("");
  }

  /** How many libraries the repository has, without listing them (the brief is written synchronously). */
  countSync(repo) {
    try {
      const dir = path.join(this.services.config.dirs.experience, repo);
      return fs.readdirSync(dir).filter((name) => this.branches.exists(dir, name)).length;
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
  /** The work's 经验.md: reusable experience recorded with the work because no linked library suits it (or none is linked). */
  inbox(work) {
    try {
      return fs.readFileSync(path.join(work.dir, EXPERIENCE_INBOX), "utf8").trim();
    } catch {
      return "";
    }
  }

  /** The brief's lines on experience: where the work's 经验.md and its libraries are; the AI reads what it needs. */
  brief(work) {
    const { missing } = this.linkedSync(work);
    const current = this.current(work);
    const inbox = this.inbox(work);
    const entries = (inbox.match(/^##\s+\S/gm) ?? []).length;
    const lines = [
      inbox
        ? `- 记下但还没整理进经验库的经验：\`projects/${work.slug}/${EXPERIENCE_INBOX}\`（${entries ? `${entries} 条` : `${Math.max(1, Math.round(Buffer.byteLength(inbox) / 1024))} KB`}）。`
        : `- 可以复用、但没有合适经验库的经验记在 \`projects/${work.slug}/${EXPERIENCE_INBOX}\`（还没有）。`,
      current.length
        ? `- 经验库：${current.map((item) => `「${item.library.title}」${item.library.title !== item.library.id ? `（id ${item.library.id}）` : ""}`).join("、")}，需要时用 experience_read 读。`
        : "- 经验库：本作品没有关联。",
    ];
    const gone = this.goneText(work, missing);
    if (gone) lines.push(`- ${gone}`);
    return { lines, state: { experience: experienceKnown(current) } };
  }

  /** For work_context: built-in agents already have the libraries in their brief, others get them here. */
  async summary(work) {
    const { missing } = this.linkedSync(work);
    const current = this.current(work);
    // The work's own record of reusable experience (经验.md), not yet in a library.
    const pending = this.inbox(work);
    const inbox = pending ? { inbox: pending } : {};
    if (!current.length) {
      const annotated = this.services.libraries ? await this.services.libraries.annotate("experiences", work.repo, await this.libraries(work.repo), work) : [];
      const { label, list } = this.offers(annotated);
      return {
        libraries: [],
        missing,
        ...(missing.length ? { gone: this.goneText(work, missing) } : {}),
        available: annotated.length,
        ...(list.length ? { offered: label, offers: list.map(({ id, title, about, files, works, why }) => ({ library: id, title, about, documents: files, works, why })) } : {}),
        hint: `这个作品没有关联经验库${annotated.length ? `（作品库里有 ${annotated.length} 个，experience_list 按主题查找）` : ""}。可复用的经验先记在作品的 ${EXPERIENCE_INBOX}；用户同意后用 experience_link 关联（可以多个），用户也可以在「经验」面板的「管理…」（经验库选项卡）中关联。`,
        ...inbox,
      };
    }
    return {
      libraries: current.map(({ library, documents }) => ({
        library: library.id,
        title: library.title,
        documents: documents.map(({ path: file, title, summary, chars }) => ({ path: file, title, summary, chars })),
      })),
      missing,
      note: "需要的文档用 experience_read 读",
      ...inbox,
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
  /** The libraries' folder, for a path that must lie in one of them (each library is its own checkout). */
  const within = async (repo, ...files) => {
    const dir = await experience.dir(repo);
    for (const file of files)
      if (!experience.branches.exists(dir, String(file || "").split("/")[0])) throw problem(400, `${file} 不在任何经验库里：路径写成 <经验库 id>/<文档>，新经验库先新建`);
    return dir;
  };
  /** A skill's documents are the skill's own files: they are renamed and deleted with the skill, in 技能. */
  const notSkill = (id) => {
    if (skillOf(id)) throw problem(400, "这是技能里的文档，技能在「技能」中改名或删除");
  };
  /** What may be written to a skill's documents (and SKILL.md stays where it is). */
  const skillDocument = (file, { moving = false } = {}) => {
    if (!SKILL_DOCUMENT.test(file)) throw problem(400, "技能里作为经验的是 Markdown 文档（.md）");
    if (moving && file === "SKILL.md") throw problem(400, "SKILL.md 是技能的入口，不能删除、改名或移动");
  };
  // GitHub was asked: it may have libraries made on another device.
  services.events.subscribe((event) => event.type === "repos" && experience.branches.refresh());

  // ---- libraries ----------------------------------------------------------------
  // With `work`: whether it links each library and how well each suits it (the picker's 推荐).
  router.get(`${base}/libraries`, async ({ params, query }) => {
    const libraries = await experience.libraries(params.repo);
    if (!services.libraries) return libraries;
    const work = query.work ? await services.openWork(query.work, params.repo) : null;
    return services.libraries.annotate("experiences", params.repo, libraries, work);
  });
  router.post(`${base}/libraries`, async ({ params, req }) => experience.create(params.repo, (await readJson(req)).name));
  router.delete(`${base}/libraries/:lib`, ({ params }) => (notSkill(params.lib), experience.remove(params.repo, params.lib)));
  // The recycle bin of deleted libraries.
  router.get(`${base}/trash`, ({ params }) => experience.trash(params.repo));
  router.post(`${base}/trash/:key/restore`, ({ params }) => experience.restore(params.repo, params.key));
  router.delete(`${base}/trash/:key`, ({ params }) => experience.purge(params.repo, params.key));
  router.delete(`${base}/trash`, ({ params }) => experience.purge(params.repo));
  router.post(`${base}/libraries/:lib/rename`, async ({ params, req }) => (notSkill(params.lib), experience.rename(params.repo, params.lib, (await readJson(req)).name)));

  // ---- files (same shape as a work's file API, so the editor tabs reuse it) --------------
  // One library's documents (paths from the branch root), or the whole branch.
  // A document comes with its title and first line, so the trees say what it is about without opening it.
  router.get(`${base}/tree`, async ({ params, query }) => {
    const dir = await experience.dir(params.repo);
    if (!query.library) return tree(dir);
    if (skillOf(query.library)) await services.skills?.ready(params.repo);
    const library = experience.locate(params.repo, String(query.library));
    if (!library) throw notFound("经验库不存在");
    return (library.skill ? skillTree(library.root) : tree(confined(dir, library.id))).map((entry) => {
      let about = {};
      if (entry.type === "file" && /\.(md|markdown|txt)$/i.test(entry.path))
        try {
          about = describeDocument(entry.path, fs.readFileSync(path.join(library.root, entry.path), "utf8").slice(0, 2000));
        } catch {}
      return { ...entry, ...about, path: `${library.id}/${entry.path}` };
    });
  });
  /** Documents of every library whose name or title has all the words (the 经验 view's filter). */
  router.get(`${base}/find`, async ({ params, query }) => {
    const words = searchWords(query.q);
    if (!words.length) return [];
    const found = [];
    for (const { id } of await experience.libraries(params.repo)) {
      const library = experience.locate(params.repo, id);
      if (!library) continue;
      for (const entry of library.skill ? skillTree(library.root) : tree(library.root, { maxEntries: 100000 })) {
        if (entry.type !== "file" || !/\.(md|markdown|txt)$/i.test(entry.path)) continue;
        let title = "";
        try {
          title = describeDocument(entry.path, fs.readFileSync(path.join(library.root, entry.path), "utf8").slice(0, 2000)).title;
        } catch {}
        const text = `${entry.path} ${title}`.toLowerCase();
        if (words.every((word) => text.includes(word))) found.push({ library: library.id, path: `${library.id}/${entry.path}`, title });
        if (found.length >= 200) return found;
      }
    }
    return found;
  });
  // A skill's documents (`skill:<skill>/…`) are its own files; each change is a version of the skills at once, as in 技能.
  router.get(`${base}/file`, async ({ params, query }) => {
    const { library, path: file } = await experience.place(params.repo, query.path);
    return { ...readText(library.root, file), path: query.path };
  });
  router.put(`${base}/file`, async ({ params, req }) => {
    const body = await readJson(req);
    const { library, path: file } = await experience.place(params.repo, body.path);
    if (library.skill) skillDocument(file);
    const result = writeText(library.skill ? library.root : await within(params.repo, body.path), library.skill ? file : body.path, body.content, {
      expectedHash: body.expectedHash,
    });
    if (library.skill) await services.skills.save(params.repo, `修改技能「${library.skill}」：${file}`);
    experience.changed(params.repo, [body.path]);
    return { ...result, path: body.path };
  });
  router.post(`${base}/move`, async ({ params, req }) => {
    const body = await readJson(req);
    const from = await experience.place(params.repo, body.from);
    const to = await experience.place(params.repo, body.to);
    if (from.library.skill || to.library.skill) {
      if (from.library.id !== to.library.id) throw problem(400, "技能里的文档只能在同一个技能里移动");
      skillDocument(from.path, { moving: true });
      skillDocument(to.path, { moving: true });
      movePath(from.library.root, from.path, to.path);
      await services.skills.save(params.repo, `移动技能「${from.library.skill}」的文档：${from.path} → ${to.path}`);
    } else movePath(await within(params.repo, body.from, body.to), body.from, body.to);
    experience.changed(params.repo, [body.from, body.to], { from: body.from, to: body.to });
  });
  router.delete(`${base}/file`, async ({ params, query }) => {
    const { library, path: file } = await experience.place(params.repo, query.path);
    if (library.skill) {
      skillDocument(file, { moving: true });
      removePath(library.root, file);
      await services.skills.save(params.repo, `删除技能「${library.skill}」的文档：${file}`);
    } else removePath(await within(params.repo, query.path), query.path);
    experience.changed(params.repo, [query.path]);
  });

  // ---- versions: each library's, like a work's ------------------------------------------
  libraryVersionRoutes(services, { base, branches: experience.branches, changed: (repo, id) => experience.changed(repo, [id]) });

  // ---- AI tools ---------------------------------------------------------------------
  /**
   * The library a tool call means: the `library` argument (any library of the repository, so
   * the AI can also organize libraries the work does not link), or the only one the work links.
   */
  const libraryOf = async (ctx, name) => {
    // Without a work (only `repo`), a library of that repository named by `library`.
    const work = await ctx.place();
    const { libraries, missing } = work.dir ? await experience.linked(work) : { libraries: [], missing: [] };
    if (name?.trim()) {
      const dir = await experience.dir(work.repo);
      if (skillOf(name.trim())) await services.skills?.ready(work.repo);
      // Linked libraries by name or title first (cheap); any other library of the repository after.
      const id =
        experience.locate(work.repo, name.trim())?.id ?? findLibrary(name, libraries)?.id ?? findLibrary(name, await experience.libraries(work.repo))?.id;
      if (!id)
        throw problem(400, unknownLibraries("experiences", [name.trim()], await experience.libraries(work.repo), trashed(dir)).replace(/新建用 create$/, "新建用 experience_link 的 create"), "NO_EXPERIENCE");
      return { work, library: libraries.find((item) => item.id === id) ?? experience.locate(work.repo, id) };
    }
    if (!work.dir) throw problem(400, "只指定作品库（repo）时，用 library 写明是哪个经验库（experience_list 查找）", "LIBRARY_REQUIRED");
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
  const libraryArg = z.string().max(80).optional().describe("经验库 id 或名称；作品关联了多个经验库时必填。整理经验库时也可以指定作品没有关联的经验库");

  tools.add({
    name: "experience_read",
    title: "阅读经验库",
    description:
      "阅读经验库（同类作品积累的制作经验、用户偏好和避坑记录）。传 path 读一篇全文，paths 一次读多篇；不传返回 README 和文档目录。作品关联了多个经验库时用 library 指定。还没有作品时用 repo 指定作品库，library 写明经验库。",
    readOnly: true,
    input: { work: workArg, repo: repoArg, library: libraryArg, path: docPath.optional(), paths: z.array(docPath).max(30).optional().describe("一次读同一经验库的多篇文档") },
    async run({ library: name, path: file, paths }, ctx) {
      if (file && paths?.length) throw problem(400, "path 读一篇，paths 读多篇：二选一");
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
        const work = await ctx.place();
        if (!work.dir) throw problem(400, "只指定作品库（repo）时，用 library 写明读哪个经验库（experience_list 查找）", "LIBRARY_REQUIRED");
        const { libraries } = await experience.linked(work);
        if (!libraries.length) await libraryOf(ctx); // explains why there is none
        const current = libraries.map((library) => ({ library: { id: library.id, title: library.title }, documents: experience.documents(library) }));
        // The READMEs come in full: the AI has read them.
        for (const { library, documents } of current) {
          const readme = documents.find((doc) => doc.path === "README.md");
          if (readme) noteSeen(ctx, libraries.find((item) => item.id === library.id), readme.path, readme.hash, "content");
        }
        return {
          data: current.map(({ library, documents }) => ({
            library: library.id,
            title: library.title,
            documents: documents.map(({ path: doc, title, summary }) => ({ path: doc, title, summary })),
          })),
          text: current.map(({ library, documents }) => libraryOverview(library, documents)).join("\n\n"),
        };
      }
      const { library } = await libraryOf(ctx, name);
      if (file) {
        const result = readText(library.root, file);
        noteSeen(ctx, library, file, result.hash, "content");
        return { data: { path: file, sha256: result.hash }, meta: { library: library.id, path: file, sha256: result.hash }, text: result.content };
      }
      const documents = experience.documents(library);
      const readme = documents.find((doc) => doc.path === "README.md");
      if (readme) noteSeen(ctx, library, readme.path, readme.hash, "content");
      return {
        data: { library: library.id, title: library.title, documents: documents.map(({ path: doc, title, summary }) => ({ path: doc, title, summary })) },
        text: libraryOverview({ id: library.id, title: library.title }, documents),
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
        const facts = [
          library.skill ? `技能 ${library.skill} 里的文档` : "",
          `${library.files} 篇文档`,
          library.works ? `${library.works} 个作品在用` : "没有作品在用",
          library.linked ? "本作品已关联" : "",
          ...(library.linked ? [] : (library.why ?? [])),
        ]
          .filter(Boolean)
          .join("；");
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
      "增加或移除本作品关联的经验库（project.ts 的 experiences，可以多个）。add 关联已有的经验库，create 新建经验库（带首页模板）并关联（同名的已存在时直接关联），remove 取消关联（经验库本身不受影响）。名称写 id 或标题（大小写、空格、标点不同也能认出）；作品按 id 关联，经验库改名（只改标题）不影响关联；作品库的技能里的文档也可以作为经验库关联（id 是 skill:<技能名>，它的文档就是技能里的 Markdown，改了就是改技能）；不存在时返回最接近的几个，经验库很多时先用 experience_list 查找。用户要求时使用；不确定时先问用户。返回新关联的经验库的首页和目录（小的经验库返回全文）。",
    input: { work: workArg, add: z.array(nameArg).max(10).default([]), remove: z.array(nameArg).max(10).default([]), create: z.array(nameArg).max(5).default([]) },
    async run({ add, remove, create }, ctx) {
      const work = await ctx.work();
      const published = Boolean(works.published(work));
      if (published && (add.length || remove.length))
        throw problem(423, "作品已发布，不能改变它关联的经验库。经验库本身可以照常整理（用 library 参数指定），也可以用 create 新建。要改关联，请用户先取消发布或创建副本。", "PUBLISHED");
      const dir = await experience.dir(work.repo);
      const all = await experience.libraries(work.repo);
      // A library's id or title, or either written a little differently.
      const find = (name) => findLibrary(name, all)?.id ?? null;
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
      // Links to deleted libraries can be removed too.
      const dropping = new Set(remove.map((name) => find(name) ?? name.trim()));
      const kept = experience.names(work).filter((name) => !dropping.has(name));
      await works.update(work, { experiences: [...new Set([...kept, ...adding])] });
      const after = experience.linkedSync(work).libraries;
      const added = after.filter((item) => !before.some((old) => old.id === item.id));
      const removed = before.filter((item) => !after.some((now) => now.id === item.id));
      // The session knows the new libraries' documents by name, as a new session would.
      const seen = experienceKnown(added.map((library) => ({ library: { id: library.id, title: library.title }, documents: experience.documents(library) })));
      if (ctx.scope.session) services.ai?.noteExperienceLibraries(ctx.scope.session, { added: seen, removed: removed.map((item) => item.id) });
      return {
        data: { experiences: after.map(({ id, title }) => ({ id, title })), added: added.map((item) => item.id), removed: removed.map((item) => item.id) },
        text: [
          `本作品关联的经验库：${after.map((item) => `「${item.title}」`).join("") || "（无）"}`,
          removed.length ? `已取消关联：${removed.map((item) => `「${item.title}」`).join("")}，之前读到的那些经验不再适用于这个作品。` : "",
          added.length ? `新关联：${added.map((item) => `「${item.title}」`).join("")}，需要时用 experience_read 读。` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
    },
  });

  tools.add({
    name: "experience_commit",
    published: true, // the library branches, not the work: allowed on a published work
    title: "保存经验库版本",
    description:
      "把经验库里未保存的修改保存为版本（Git 提交）。你用 experience_write 改的每轮结束时已经自动保存，这个工具用于用户在工作台里手动改了、要你保存的时候。每个经验库是自己的分支：library 指定只保存哪个；不写时有修改的经验库各自保存一个版本（message 相同）。message 用一句话说明改了什么。push: true 时保存后推送到 GitHub（作品库连接了 GitHub 时）。还没有作品时用 repo 指定作品库。",
    input: { work: workArg, repo: repoArg, library: libraryArg, message: z.string().min(1).max(200), push: z.boolean().default(false) },
    async run({ library: name, message, push }, ctx) {
      const work = await ctx.place();
      const ids = name?.trim() ? [(await libraryOf(ctx, name)).library.id] : await experience.branches.ids(work.repo);
      const saved = [];
      // A skill's documents: their changes are saved with the skills (at once, or at the end of the turn).
      const skill = skillOf(ids[0]);
      if (skill) {
        const commit = await services.skills.save(work.repo, message);
        return asJson({ saved: commit ? [{ library: ids[0], commit }] : [] }, commit ? `已保存技能的版本 ${commit.slice(0, 7)}` : `技能「${skill}」没有未保存的修改`);
      }
      for (const id of ids) {
        const scope = await experience.scope(work.repo, id);
        const files = (await works.status(scope)).files.map((file) => `${id}/${file.path}`);
        const commit = await works.commit(scope, message);
        if (!commit) continue;
        let pushed = null;
        if (push)
          try {
            await works.push(scope);
            pushed = { ok: true };
          } catch (error) {
            pushed = { ok: false, error: error.message };
          }
        saved.push({ library: id, commit, files, pushed });
      }
      const lines = saved.map(
        (item) =>
          `「${item.library}」${item.commit.slice(0, 7)}：${item.files.join("、")}${!item.pushed ? "" : item.pushed.ok ? "，已推送到 GitHub" : `。推送到 GitHub 失败：${item.pushed.error}（请用户在「版本与同步」中处理）`}`,
      );
      return asJson({ saved }, saved.length ? `已保存经验库版本：\n${lines.join("\n")}` : `${name?.trim() ? `经验库「${ids[0]}」` : "经验库"}没有未保存的修改`);
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
      "修改经验库中的 Markdown 文档（路径相对经验库，例如 README.md、开场.md），一次可以做多个操作，按顺序执行：write（新建或整篇重写）、edit（精确替换：每个 oldText 必须与文档逐字一致且恰好出现一次，否则设 replaceAll）、delete、move（改名、移动）。怎么组织由你决定。note 一句话说明这次记了什么：对话中每轮结束时改过的经验库各自自动保存为一个版本，note 就是版本说明；没有对话时写入后立即保存。失败的逐项说明原因，只需重试失败的。还没有作品时用 repo 指定作品库，library 写明经验库。",
    destructive: true,
    input: {
      work: workArg,
      repo: repoArg,
      library: libraryArg,
      operations: z.array(docOperation).min(1).max(30),
      note: z.string().max(120).optional().describe("一句话说明这次记了什么，用作版本说明，例如“开场：前 2 秒亮出冲突”"),
    },
    async run({ library: name, operations, note }, ctx) {
      const { work, library } = await libraryOf(ctx, name);
      const outcome = runFileOperations(library.root, operations, {
        reader: "experience_read",
        allow: (item, paths) => {
          if (library.skill) return paths.forEach((file, index) => skillDocument(file, { moving: index === 0 && (item.op === "delete" || item.op === "move") }));
          if (paths.some((file) => !/\.(md|txt)$/i.test(file))) throw problem(400, "经验库只存放 .md 或 .txt 文档");
          if (paths[0] === "README.md" && (item.op === "delete" || item.op === "move")) throw problem(400, "README.md 是经验库的入口，不能删除或改名");
        },
      });
      const changed = [...new Set(outcome.changed)];
      for (const file of changed) {
        const exists = fs.existsSync(path.join(library.root, file));
        noteSeen(ctx, library, file, exists ? readText(library.root, file).hash : null, exists ? "content" : undefined);
      }
      let saved = null;
      if (changed.length) {
        experience.changed(work.repo, changed.map((file) => `${library.id}/${file}`));
        // In a conversation the turn's end saves it; called from outside one, now.
        if (ctx.scope.session && services.ai?.noteExperienceWrite) services.ai.noteExperienceWrite(ctx.scope.session, { repo: work.repo, library: library.id, files: changed, note });
        else if (library.skill) saved = await services.skills.save(work.repo, versionMessage([note], changed.map((file) => `${library.skill}/${file}`)));
        else saved = await experience.branches.commitPaths(work.repo, library.id, changed, versionMessage([note], changed));
        if (library.skill) services.skills.changed(work.repo);
      }
      const { summary } = describeFileOperations(outcome);
      return {
        data: { library: library.id, applied: outcome.applied, results: outcome.results, ...(saved ? { commit: saved } : {}) },
        text: [`经验库「${library.title}」：${summary}`, !changed.length ? "" : saved ? `已保存为一个版本 ${saved.slice(0, 7)}。` : "这一轮结束时自动保存为一个版本。"]
          .filter(Boolean)
          .join("\n"),
      };
    },
  });
}
