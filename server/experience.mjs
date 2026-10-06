import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { git, gitOk, addOrphanWorktree } from "./git.mjs";
import { tree, readText, writeText, removePath, movePath } from "./files.mjs";
import { readJson } from "./http.mjs";
import { problem, notFound, confined, Locks } from "./util.mjs";
import { GIT_ATTRIBUTES } from "./templates.mjs";
import { workArg, asJson } from "./tools/registry.mjs";

/**
 * Experience libraries: Markdown documents of production know-how, shared by the works
 * of a content repository. They live on the repository's `frame/experience` branch
 * (checked out at <home>/experience/<repo>/); each top-level folder is one library.
 * A work links one library (`experience` in project.ts). The AI reads it before working
 * and keeps it organized; people edit it in the studio. Versions work like a work's.
 */
export const EXPERIENCE_BRANCH = "frame/experience";
const ROOT_README = `# FRAME 经验库

每个文件夹是一个经验库（例如“知识类视频”“音乐视频”），里面是 Markdown 写的制作经验。
作品在 FRAME Studio 中关联一个经验库后，AI 开始制作前会先阅读它，也会把新的经验整理进来。
`;
const libraryReadme = (title) => `# ${title}

这里记录「${title}」类作品的制作经验。关联了这个经验库的作品，AI 开始制作前会先阅读这里。

## 文档

- （按主题分文件记录，例如“开场.md”“配色与字体.md”“节奏与转场.md”，并在这里列出）

## 用户偏好

- （用户明确提出过的喜好和要求）
`;

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
        return { id: entry.name, title: this.title(dir, entry.name), files: files.length };
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
    const id = title
      .replace(/[\\/:*?"<>|#%\x00-\x1f]+/g, "-")
      .replace(/^[.\s-]+/, "")
      .slice(0, 60);
    if (!validId(id)) throw problem(400, "请填写经验库名称");
    const dir = await this.dir(repoId);
    if (fs.existsSync(path.join(dir, id))) throw problem(409, `已经有名为「${id}」的经验库`);
    writeText(dir, `${id}/README.md`, libraryReadme(title));
    this.changed(repoId, [`${id}/README.md`]);
    return { id, title };
  }

  async remove(repoId, id) {
    if (!validId(id)) throw notFound("经验库不存在");
    const dir = await this.dir(repoId);
    if (!fs.existsSync(path.join(dir, id))) throw notFound("经验库不存在");
    removePath(dir, id);
    this.changed(repoId, [id]);
  }

  changed(repo, files) {
    this.services.events.emit({ type: "experience-files", repo, files });
  }

  /** The library a work is linked to, or null (unlinked, or the library was removed). */
  async linked(work) {
    const id = this.services.works.meta(work).meta?.experience;
    if (!validId(id)) return null;
    const dir = await this.dir(work.repo);
    const root = path.join(dir, id);
    if (!fs.existsSync(root)) return { id, missing: true };
    return { id, title: this.title(dir, id), root, dir };
  }

  /** What the AI sees first: the library's README and its documents. */
  async summary(work) {
    const library = await this.linked(work).catch(() => null);
    if (!library) return { library: null, hint: "这个作品没有关联经验库。用户可以在左侧「经验」中选择一个。" };
    if (library.missing) return { library: library.id, hint: "关联的经验库已被删除。" };
    const files = tree(library.root)
      .filter((item) => item.type === "file")
      .map((item) => item.path);
    let readme = "";
    try {
      readme = fs.readFileSync(path.join(library.root, "README.md"), "utf8").slice(0, 6000);
    } catch {}
    return { library: library.id, title: library.title, files, readme };
  }

  /** Title of a work's library for the chat context, without touching git (sync). */
  linkedTitleSync(work) {
    const id = this.services.works.meta(work).meta?.experience;
    if (!validId(id)) return null;
    const dir = path.join(this.services.config.dirs.experience, work.repo);
    return fs.existsSync(path.join(dir, id)) ? this.title(dir, id) : null;
  }
}

export function experiencePlugin(services) {
  const { router, tools, works } = services;
  const experience = (services.experience = new Experience(services));
  const base = "/api/repos/:repo/experience";
  const scope = (params) => experience.scope(params.repo);

  // ---- libraries ----------------------------------------------------------------
  router.get(`${base}/libraries`, ({ params }) => experience.libraries(params.repo));
  router.post(`${base}/libraries`, async ({ params, req }) => experience.create(params.repo, (await readJson(req)).name));
  router.delete(`${base}/libraries/:lib`, ({ params }) => experience.remove(params.repo, params.lib));

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
    experience.changed(params.repo, [body.from, body.to]);
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
  const libraryOf = async (ctx) => {
    const work = await ctx.work();
    const library = await experience.linked(work);
    if (!library) throw problem(409, "这个作品没有关联经验库。请用户在左侧「经验」面板中为作品选择一个经验库（或新建）。", "NO_EXPERIENCE");
    if (library.missing) throw problem(409, `关联的经验库「${library.id}」已被删除，请用户重新选择。`, "NO_EXPERIENCE");
    return { work, library };
  };
  const docPath = z.string().min(1).max(300).describe("经验库内的相对路径，例如 README.md 或 开场.md");
  const notify = (work, library, file) => experience.changed(work.repo, [`${library.id}/${file}`]);

  tools.add({
    name: "experience_read",
    title: "阅读经验库",
    description:
      "阅读作品关联的经验库（这类作品积累的制作经验、用户偏好和避坑记录）。不传 path 返回经验库的 README 和全部文档列表；传 path 返回该文档。开始制作前先阅读，照着已有经验做。",
    readOnly: true,
    input: { work: workArg, path: docPath.optional() },
    async run({ path: file }, ctx) {
      const { library } = await libraryOf(ctx);
      if (file) {
        const result = readText(library.root, file);
        return { data: { path: file, sha256: result.hash }, meta: { library: library.id, path: file, sha256: result.hash }, text: result.content };
      }
      const files = tree(library.root).filter((item) => item.type === "file");
      const readme = fs.existsSync(path.join(library.root, "README.md")) ? fs.readFileSync(path.join(library.root, "README.md"), "utf8") : "（没有 README.md）";
      return {
        data: { library: library.id, title: library.title, files: files.map((item) => item.path) },
        text: `经验库「${library.title}」\n文档：${files.map((item) => item.path).join("、") || "无"}\n\n--- README.md ---\n${readme}`,
      };
    },
  });

  tools.add({
    name: "experience_write",
    title: "写入经验",
    description:
      "创建或整体替换经验库中的一篇 Markdown 文档。整理经验时：先 experience_read 阅读，按主题合并到已有文档，不要重复记录；新文档要在 README.md 的文档列表中登记。只改几处时用 experience_edit。修改是未保存状态，用户在「经验」面板中查看并保存版本。",
    destructive: true,
    input: { work: workArg, path: docPath, content: z.string().max(512 * 1024), expectedSha256: z.string().optional() },
    async run({ path: file, content, expectedSha256 }, ctx) {
      const { work, library } = await libraryOf(ctx);
      if (!/\.(md|txt)$/i.test(file)) throw problem(400, "经验库只存放 .md 或 .txt 文档");
      const result = writeText(library.root, file, content, { expectedHash: expectedSha256 });
      notify(work, library, file);
      return { data: { path: file, sha256: result.hash }, meta: { sha256: result.hash }, text: `已写入经验库「${library.title}」的 ${file}` };
    },
  });

  tools.add({
    name: "experience_edit",
    title: "修改经验",
    description: "在经验库文档中做精确替换（按顺序执行，全部成功才写入）。每个 oldText 必须与文档内容逐字一致且恰好出现一次，否则设置 replaceAll。",
    input: {
      work: workArg,
      path: docPath,
      edits: z
        .array(z.strictObject({ oldText: z.string().min(1), newText: z.string(), replaceAll: z.boolean().default(false) }))
        .min(1)
        .max(50),
    },
    async run({ path: file, edits }, ctx) {
      const { work, library } = await libraryOf(ctx);
      const current = readText(library.root, file);
      let content = current.content;
      for (const [index, edit] of edits.entries()) {
        const count = content.split(edit.oldText).length - 1;
        if (count === 0) throw problem(400, `第 ${index + 1} 处替换：找不到 oldText，先用 experience_read 读取最新内容`);
        if (count > 1 && !edit.replaceAll) throw problem(400, `第 ${index + 1} 处替换：oldText 出现了 ${count} 次，请提供更多上下文或设置 replaceAll`);
        content = edit.replaceAll ? content.split(edit.oldText).join(edit.newText) : content.replace(edit.oldText, () => edit.newText);
      }
      const result = writeText(library.root, file, content, { expectedHash: current.hash });
      notify(work, library, file);
      return {
        data: { path: file, sha256: result.hash },
        meta: { sha256: result.hash },
        text: `已修改经验库「${library.title}」的 ${file}（${edits.length} 处）`,
      };
    },
  });

  tools.add({
    name: "experience_delete",
    title: "删除经验文档",
    description: "删除经验库中的一篇文档（合并到其他文档后清理旧文档时用）。可以从经验库的版本历史恢复。",
    destructive: true,
    input: { work: workArg, path: docPath },
    async run({ path: file }, ctx) {
      const { work, library } = await libraryOf(ctx);
      if (file === "README.md") throw problem(400, "README.md 是经验库的入口，不能删除");
      confined(library.root, file);
      removePath(library.root, file);
      notify(work, library, file);
      return asJson({ deleted: file }, `已删除经验库「${library.title}」的 ${file}`);
    },
  });
}
