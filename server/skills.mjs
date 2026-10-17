import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { git, parseStatus } from "./git.mjs";
import { tree, readText, writeText, downloadPlan, sendZip } from "./files.mjs";
import { readBody, readJson, sendFile } from "./http.mjs";
import { problem, notFound, conflict, confined } from "./util.mjs";
import { GIT_ATTRIBUTES } from "./templates.mjs";
import { sharedBranchRoutes } from "./branch-routes.mjs";

/**
 * The repository's AI skills (Agent Skills: a folder with SKILL.md and whatever it refers to),
 * shared by all its works and by no other repository. They live on the repository's
 * `frame/skills` branch, checked out at <home>/skills/<repo>/, and every change is saved as a
 * version at once. The built-in AI finds them where Claude Code and Codex look for a project's
 * skills: the work root's `.claude/skills` and `.agents/skills` are links to that folder.
 * Before the repository has skills the folder is a plain one; the branch starts with the first
 * skill saved into it (reading never starts it).
 */
export const SKILLS_BRANCH = "frame/skills";
const SKILL_FILE = "SKILL.md";
const ROOT_README = `# FRAME 技能

这个作品库的 AI 技能（Agent Skills），同一作品库的所有作品共用。每个文件夹是一个技能：入口是其中的 \`SKILL.md\`（开头写 name 和 description），参考文档、脚本等放在同一个文件夹里。在 FRAME Studio 的「技能」中管理。
`;
/** Where the agents look for a project's skills, relative to the work root (Claude Code, Codex). */
export const SKILL_LINKS = [".claude/skills", ".agents/skills"];
const UPLOAD_LIMIT = 64 * 1024 * 1024;
const UNPACKED_LIMIT = 256 * 1024 * 1024;
const ENTRY_LIMIT = 5000;
/** What archives made on a Mac or Windows carry besides the files. */
const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i;

/** A skill's folder name: one path segment, letters (any script), digits, ".", "_", "-" (not the branch's README). */
export const validSkillName = (name) =>
  typeof name === "string" && name.length <= 64 && /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(name) && name.toLowerCase() !== "readme.md";

/**
 * The top-level fields of a SKILL.md frontmatter (name, description…), read leniently: plain,
 * quoted, folded (>) and literal (|) values, continued on indented lines. null without one.
 */
export function frontmatter(text) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  const fields = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const field = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(lines[index]);
    if (!field) continue;
    let value = (field[2] ?? "").trim();
    const more = [];
    while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]) || (!lines[index + 1].trim() && /^[|>]/.test(value)))) more.push(lines[++index].trim());
    if (/^[|>][+-]?$/.test(value)) value = value.startsWith("|") ? more.join("\n").trim() : more.filter(Boolean).join(" ");
    else if (/^["']/.test(value)) {
      const quote = value[0];
      value = [value, ...more].join(" ");
      value = value.length > 1 && value.endsWith(quote) ? value.slice(1, -1) : value.slice(1);
      value = quote === '"' ? value.replace(/\\(["\\])/g, "$1").replace(/\\n/g, "\n") : value.replace(/''/g, "'");
    } else value = [value, ...more].filter(Boolean).join(" ");
    fields[field[1]] = value;
  }
  return fields;
}

/** A YAML value written so that any text stays one plain field. */
const yamlValue = (text) => (/^[\s\-?:,[\]{}#&*!|>'"%@`]|:\s|:$|\s#|\n|\s$/.test(text) || !text ? JSON.stringify(text) : text);

/** The skills of an archive (.zip / .skill) or of a single SKILL.md: [{ name, files: [[path in the skill, bytes]] }]. */
export function readUpload(fileName, data) {
  const base = String(fileName || "")
    .split(/[\\/]/)
    .pop()
    .replace(/\.(zip|skill|md)$/i, "");
  let entries;
  if (/\.md$/i.test(fileName)) entries = [[SKILL_FILE, data]];
  else if (/\.(zip|skill)$/i.test(fileName)) {
    let unpacked = 0;
    let count = 0;
    let files;
    try {
      files = unzipSync(data, {
        filter(file) {
          unpacked += file.originalSize;
          if (++count > ENTRY_LIMIT) throw problem(413, `压缩包里的文件超过 ${ENTRY_LIMIT} 个`);
          if (unpacked > UNPACKED_LIMIT) throw problem(413, `压缩包解开后超过 ${UNPACKED_LIMIT / 1048576} MB`);
          return !file.name.endsWith("/");
        },
      });
    } catch (error) {
      if (error.status) throw error;
      throw problem(400, `读不了这个压缩包：${error.message}`);
    }
    entries = Object.entries(files).map(([name, bytes]) => [name.replace(/\\/g, "/").replace(/^(\.\/|\/)+/, ""), bytes]);
  } else throw problem(400, "技能请上传文件夹、.zip / .skill 压缩包，或单独一个 SKILL.md");
  entries = entries.filter(([name]) => name && !JUNK.test(name));
  for (const [name] of entries) if (name.split("/").some((part) => part === ".." || part === "")) throw problem(400, `压缩包里的路径不对：${name}`);
  // Each SKILL.md starts a skill; one inside another skill's folder is part of that skill.
  const roots = entries
    .filter(([name]) => name.split("/").pop() === SKILL_FILE)
    .map(([name]) => name.split("/").slice(0, -1).join("/"))
    .sort((a, b) => a.split("/").length - b.split("/").length)
    .filter((root, index, all) => !all.slice(0, index).some((outer) => outer === "" || root.startsWith(outer + "/")));
  if (!roots.length) throw problem(400, "没有找到 SKILL.md：每个技能是一个文件夹，入口文件是其中的 SKILL.md");
  const skills = roots.map((root) => {
    const prefix = root ? root + "/" : "";
    const files = entries.filter(([name]) => name.startsWith(prefix)).map(([name, bytes]) => [name.slice(prefix.length), bytes]);
    const own = frontmatter(Buffer.from(files.find(([name]) => name === SKILL_FILE)[1]).toString("utf8"));
    const name = root ? root.split("/").pop() : own?.name || (/^skill$/i.test(base) ? "" : base);
    if (!name) throw problem(400, "SKILL.md 里没有写 name，不知道这个技能叫什么");
    if (!validSkillName(name)) throw problem(400, `技能名称「${name}」不能用作文件夹名：只能用文字、数字、点、下划线和连字符，最长 64 个字`);
    return { name, files };
  });
  const names = skills.map((skill) => skill.name);
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice) throw problem(400, `压缩包里有两个技能都叫「${twice}」`);
  return skills;
}

/** The skill a message starts with as /<name> (like a command), or null. */
export function leadingSkill(text, names) {
  const name = /^\s*\/([\p{L}\p{N}][\p{L}\p{N}._-]*)(?=\s|$)/u.exec(String(text || ""))?.[1];
  return name && names.includes(name) ? name : null;
}

/** The skills a message names: /<name> at its start, @<name> anywhere (at the start or after a space); in order, once each. */
export function mentionedSkills(text, names) {
  const leading = leadingSkill(text, names);
  const found = leading ? [leading] : [];
  for (const match of String(text || "").matchAll(/(?:^|\s)@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu)) {
    const name = match[1].replace(/\.+$/, "");
    if (names.includes(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

export class Skills {
  constructor(services) {
    this.services = services;
    this.excluded = new Set(); // repositories whose worktrees ignore the links
  }

  /** The folder of a repository's skills (a plain folder until the branch exists here). */
  folder(repo) {
    this.services.repos.get(repo); // a known repository, not a path
    return path.join(this.services.config.dirs.skills, repo);
  }
  isCheckout(dir) {
    return fs.existsSync(path.join(dir, ".git"));
  }
  /**
   * The folder, ready to read: the branch checked out when the repository has one (here or on
   * GitHub), else a plain folder, so the links always lead somewhere.
   */
  async ready(repo) {
    const dir = this.folder(repo);
    if (this.isCheckout(dir)) return dir;
    if (await this.services.repos.hasBranch(repo, SKILLS_BRANCH)) return this.checkout(repo);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  /**
   * Check out the branch (a new one with a README when there is none). What the plain folder
   * holds — written before the branch was here — is kept on top of the branch's files.
   */
  async checkout(repo) {
    const dir = this.folder(repo);
    if (this.isCheckout(dir)) return dir;
    return this.services.repos.locks.run(`skills:${repo}`, () => this.checkoutUnlocked(repo, dir));
  }
  async checkoutUnlocked(repo, dir) {
    if (this.isCheckout(dir)) return dir;
    const kept = fs.existsSync(dir) && fs.readdirSync(dir).length ? `${dir}.pending-${process.pid}-${Date.now()}` : null;
    if (kept) fs.renameSync(dir, kept);
    else fs.rmSync(dir, { recursive: true, force: true });
    try {
      await this.services.repos.branchWorktree(repo, {
        branch: SKILLS_BRANCH,
        dir,
        files: { "README.md": ROOT_README, ".gitattributes": GIT_ATTRIBUTES },
        message: "创建技能分支",
      });
    } catch (error) {
      if (kept && !fs.existsSync(dir)) fs.renameSync(kept, dir);
      throw error;
    }
    if (kept) {
      fs.cpSync(kept, dir, { recursive: true, force: true });
      fs.rmSync(kept, { recursive: true, force: true });
    }
    return dir;
  }
  /** A work-like handle, so the works' version functions (history, push, pull…) apply. */
  handle(repo, root) {
    return { id: `skills-${repo}`, repo, root, dir: root, branch: SKILLS_BRANCH };
  }
  async scope(repo) {
    return this.handle(repo, await this.checkout(repo));
  }
  /** The same, or null while the repository has no skills branch (looking at versions starts nothing). */
  async scopeIfAny(repo) {
    const dir = await this.ready(repo);
    return this.isCheckout(dir) ? this.handle(repo, dir) : null;
  }

  /** The names of the skills (folders with a SKILL.md), read at once (for a turn's prompt). */
  namesSync(repo) {
    const dir = path.join(this.services.config.dirs.skills, repo);
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && fs.existsSync(path.join(dir, entry.name, SKILL_FILE)))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  /** The skill folders, each with what its SKILL.md says and its files. */
  async list(repo) {
    const dir = await this.ready(repo);
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => this.describe(dir, entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  describe(dir, name) {
    const folder = path.join(dir, name);
    let text = null;
    try {
      text = fs.readFileSync(path.join(folder, SKILL_FILE), "utf8");
    } catch {}
    const fields = text === null ? null : frontmatter(text);
    const problems =
      text === null
        ? ["没有 SKILL.md，AI 不会把它当作技能"]
        : !fields
          ? ["SKILL.md 开头没有用 --- 包起来的 name 和 description"]
          : [...(fields.name ? [] : ["SKILL.md 没有写 name"]), ...(fields.description ? [] : ["SKILL.md 没有写 description（AI 靠它判断什么时候用）"])];
    return {
      name,
      title: fields?.name || name,
      description: fields?.description || "",
      files: tree(folder),
      ...(problems.length ? { problem: problems.join("；") } : {}),
    };
  }

  /** Save everything changed as one version (the branch starts here when there is none yet). */
  async save(repo, message) {
    const dir = this.folder(repo);
    if (!this.isCheckout(dir)) {
      if (!fs.existsSync(dir) || !fs.readdirSync(dir).length) return null;
      await this.checkout(repo);
    }
    const commit = await this.services.works.commit(this.handle(repo, dir), message);
    this.changed(repo);
    return commit;
  }
  changed(repo) {
    this.services.events.emit({ type: "skills", repo });
  }
  /** The skills with changes not saved yet (the AI edits them with its own tools). */
  async unsaved(repo) {
    const dir = this.folder(repo);
    if (!fs.existsSync(dir)) return [];
    const files = this.isCheckout(dir)
      ? parseStatus(await git(dir, ["status", "--porcelain=v2", "--untracked-files=all"])).files.map((file) => file.path)
      : fs.readdirSync(dir);
    return [...new Set(files.map((file) => file.split("/")[0]))];
  }
  /** After an AI turn: what it changed in the skills is a version. */
  async saveTurn(repo) {
    try {
      const names = await this.unsaved(repo);
      if (names.length) await this.save(repo, `AI 修改技能：${names.join("、")}`);
    } catch (error) {
      console.warn(`saving the skills of ${repo} after a turn failed:`, error.message);
    }
  }

  /**
   * Link the work's `.claude/skills` and `.agents/skills` to the repository's skills (never
   * committed). A real folder there belongs to the work and is left alone.
   */
  async link(work) {
    const dir = await this.ready(work.repo);
    if (!this.excluded.has(work.repo)) {
      await this.services.repos.prepare(this.services.repos.get(work.repo).dir);
      this.excluded.add(work.repo);
    }
    for (const relative of SKILL_LINKS) {
      const file = path.join(work.root, relative);
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) {
        if (fs.readlinkSync(file) === dir) continue;
        fs.unlinkSync(file);
      } else if (stat) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.symlinkSync(dir, file, process.platform === "win32" ? "junction" : "dir");
    }
  }

  // ---- changes from the studio, each saved at once ------------------------------------------

  async create(repo, { name, description = "" }) {
    name = String(name || "").trim();
    if (!validSkillName(name)) throw problem(400, "技能名称只能用文字、数字、点、下划线和连字符（不能有空格），最长 64 个字");
    const dir = await this.ready(repo);
    if (fs.existsSync(path.join(dir, name))) throw conflict(`已经有技能「${name}」`);
    const about = String(description).trim().replace(/\s+/g, " ") || "这个技能做什么、什么时候用（AI 根据这句话决定是否使用它）";
    writeText(
      dir,
      `${name}/${SKILL_FILE}`,
      `---\nname: ${yamlValue(name)}\ndescription: ${yamlValue(about)}\n---\n\n# ${name}\n\n在这里写步骤、规则和例子。参考文档、脚本等可以放在同一个文件夹里，并在这里写明什么时候读、怎么用。\n`,
    );
    await this.save(repo, `新建技能：${name}`);
    return this.describe(dir, name);
  }
  async upload(repo, fileName, data, { replace = false } = {}) {
    const skills = readUpload(fileName, data);
    const dir = await this.ready(repo);
    const existing = skills.map((skill) => skill.name).filter((name) => fs.existsSync(path.join(dir, name)));
    if (existing.length && !replace) throw conflict(`已经有技能「${existing.join("」「")}」，要替换吗？`, { existing });
    for (const skill of skills) {
      const folder = confined(dir, skill.name);
      fs.rmSync(folder, { recursive: true, force: true });
      for (const [relative, bytes] of skill.files) {
        const file = confined(folder, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
      }
    }
    const names = skills.map((skill) => skill.name);
    await this.save(repo, `${existing.length ? "更新" : "上传"}技能：${names.join("、")}`);
    return { skills: names.map((name) => this.describe(dir, name)) };
  }
  async remove(repo, name) {
    if (!validSkillName(name)) throw problem(400, `没有技能「${name}」`);
    const dir = await this.ready(repo);
    if (!fs.existsSync(path.join(dir, name))) throw notFound(`没有技能「${name}」`);
    fs.rmSync(confined(dir, name), { recursive: true, force: true });
    await this.save(repo, `删除技能：${name}`);
  }
  /** A file inside a skill (`<skill>/<path>`): its skill's name and the rest. */
  split(file) {
    const [name, ...rest] = String(file || "").split("/");
    if (!validSkillName(name) || !rest.length || rest.some((part) => !part || part === "..")) throw problem(400, `不是技能里的文件：${file}`);
    return { name, rest: rest.join("/") };
  }
  async read(repo, file) {
    this.split(file);
    return readText(await this.ready(repo), file);
  }
  async write(repo, file, content, expectedHash) {
    const { name, rest } = this.split(file);
    const dir = await this.ready(repo);
    if (!fs.existsSync(path.join(dir, name))) throw notFound(`没有技能「${name}」`);
    const result = writeText(dir, file, content, { expectedHash });
    await this.save(repo, `修改技能「${name}」：${rest}`);
    return result;
  }
  async removeFile(repo, file) {
    const { name, rest } = this.split(file);
    if (rest === SKILL_FILE) throw problem(400, "SKILL.md 是技能的入口，不能单独删除；不要这个技能时删除整个技能");
    const dir = await this.ready(repo);
    const target = confined(dir, file);
    if (!fs.existsSync(target)) throw notFound(`文件不存在：${file}`);
    fs.rmSync(target, { recursive: true, force: true });
    await this.save(repo, `删除技能「${name}」的文件：${rest}`);
  }
}

export function skillsPlugin(services) {
  const { router } = services;
  const skills = (services.skills = new Skills(services));
  const base = "/api/repos/:repo/skills";

  router.get(base, async ({ params }) => {
    const list = await skills.list(params.repo);
    return { skills: list, versioned: skills.isCheckout(skills.folder(params.repo)) };
  });
  router.post(`${base}/create`, async ({ params, req }) => skills.create(params.repo, await readJson(req)));
  // An archive (a folder is zipped by the studio) or one SKILL.md; `replace=1` overwrites skills of the same name.
  router.post(
    `${base}/upload`,
    async ({ params, query, req }) =>
      skills.upload(params.repo, String(query.name || ""), await readBody(req, UPLOAD_LIMIT), { replace: query.replace === "1" }),
    { raw: true },
  );
  router.delete(`${base}/skill`, async ({ params, query }) => skills.remove(params.repo, String(query.name || "")));
  router.get(`${base}/download`, async ({ params, query, req, res }) => {
    const name = String(query.name || "");
    if (!validSkillName(name)) throw notFound(`没有技能「${name}」`);
    const plan = downloadPlan(await skills.ready(params.repo), [name], name);
    return sendZip(req, res, plan.entries, plan.name);
  });
  // Files as editor tabs (paths `<skill>/<file>`, like the experience documents).
  router.get(`${base}/file`, async ({ params, query }) => skills.read(params.repo, query.path));
  router.put(`${base}/file`, async ({ params, req }) => {
    const body = await readJson(req);
    return skills.write(params.repo, body.path, body.content, body.expectedHash);
  });
  router.delete(`${base}/file`, async ({ params, query }) => skills.removeFile(params.repo, query.path));
  // A file as it is (pictures, videos…): the 经验 and 素材 views show a skill's files where they are.
  router.get(`${base}/raw`, async ({ params, query, req, res }) => {
    const file = String(query.path || "");
    skills.split(file);
    return sendFile(req, res, confined(await skills.ready(params.repo), file));
  });

  sharedBranchRoutes(services, base, {
    branch: SKILLS_BRANCH,
    scope: (repo) => skills.scope(repo),
    scopeIfAny: (repo) => skills.scopeIfAny(repo),
    changed: (repo) => skills.changed(repo),
    // What the AI changed in a turn that has not ended is saved or dropped like a work's changes.
    commit: async (repo, message) => ({ commit: await skills.save(repo, message || "保存技能") }),
    discard: async (repo, files) => {
      const handle = await skills.scopeIfAny(repo);
      if (handle) await services.works.discard(handle, files);
      skills.changed(repo);
    },
  });
}
