import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { git, gitOk, gitToFile } from "./git.mjs";
import { tree, writeText, writeStream, removePath, movePath, uniquePath, contentVersion, TEXT_LIMIT } from "./files.mjs";
import { readJson, sendFile } from "./http.mjs";
import { problem, notFound, conflict, confined, inside, sha256, Locks, Lru, writeFileAtomic } from "./util.mjs";
import { MATERIALS_BRANCH } from "./repos.mjs";
import { workArg, repoArg, asJson } from "./tools/registry.mjs";
import { importFromUrl, decodeData } from "./tools/asset-tools.mjs";
import { eachSettled, summarize, errorOf } from "./tools/batch.mjs";
import { Readable } from "node:stream";
import { editList, applyEdits } from "./tools/file-ops.mjs";
import { probe } from "./media.mjs";
import { appRoot } from "./config.mjs";
import { findLibrary, unknownLibraries, closestLibraries, searchLibraries, searchWords, offerOrder, readmeLead, TRASH, trashed, moveToTrash, trashNote, restoreName, moveFromTrash, purgeTrash } from "./libraries.mjs";

/**
 * Material libraries: media shared by the works of a content repository (images, video,
 * audio, fonts, Lottie…), on its `frame/materials` branch (checked out at
 * <home>/libraries/<repo>/). Each top-level folder is one library, with a README that
 * keeps the files' sources and licenses. Every change is saved as a version at once.
 *
 * A work references libraries by name (project.ts `materials`) and uses their files
 * directly as `materials/<library>/<path>`. The version of each file it uses is locked in
 * its materials.lock.json ("<library>/<path>" → git blob), so a later change to the file
 * does not change the work until its lock is updated; unlocked files show as they are now.
 *
 * Library code is imported as `@materials/<library>/<path>` (extension optional). The
 * versions a work uses are copied into <work root>/.materials/ (generated, never committed),
 * where the preview, type checks, exports and the AI's own tsc find them: library code then
 * runs like the work's own (a library's top folder imports the engine as ../../src/engine/…).
 * Locking follows imports: the code's own imports and the materials it uses are locked too.
 */

const LOCK_FILE = "materials.lock.json";
const validId = (id) => typeof id === "string" && /^[^\\/:*?"<>|#%\x00-\x1f.][^\\/:*?"<>|#%\x00-\x1f]{0,59}$/.test(id);
const folderOf = (name) =>
  String(name || "")
    .trim()
    .replace(/[\\/:*?"<>|#%\x00-\x1f]+/g, "-")
    .replace(/^[.\s-]+/, "")
    .slice(0, 60);
const validRef = (ref) => typeof ref === "string" && /^[^/]+\/.+/.test(ref) && !ref.split("/").some((part) => !part || part === "." || part === "..");
/** materials/<library>/<path> as code, layers and audio documents write it. */
const MATERIAL_REF = /(?<![@\w])materials\/([^/"'`\s)\\]+\/[^"'`\s)\\]+)/g;

// ---- library code: imports and their files -----------------------------------------------
export const MATERIALIZED = ".materials";
/** Library files a work may import (text). Scripts are also followed for their own imports. */
const IMPORTABLE = /\.(m?[jt]sx?|cjs|json|glsl|frag|vert|wgsl|css|txt|svg)$/i;
const SCRIPT = /\.(m?[jt]sx?|cjs)$/i;
/** Library files material_read returns as text: code, data, notes, subtitles and lyrics. */
const TEXT = /\.(m?[jt]sx?|cjs|json|glsl|frag|vert|wgsl|css|txt|svg|md|markdown|csv|tsv|ya?ml|toml|html?|xml|srt|vtt|lrc)$/i;
/** An address built at run time (`materials/lib/fonts/${name}.ttf`, "materials/lib/fonts/" + name): the part known in advance; null for a plain address. */
const prefixOf = (ref) => (ref.includes("${") ? ref.slice(0, ref.indexOf("${")) : ref.endsWith("/") ? ref : null);
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'`]([^"'`\n]+)["'`]/g;
const SPEC_ENDINGS = ["", ".ts", ".tsx", ".js", ".mjs", ".jsx", ".json", "/index.ts", "/index.tsx", "/index.js"];
/** Module specifiers in code (static, side-effect and dynamic imports, re-exports). */
export const importSpecs = (code) => [...code.matchAll(IMPORT_SPEC)].map((match) => match[1]).filter((spec) => !spec.includes("${"));
/** The library file an import means (`<library>/<path>`, extension optional), or null. */
export function resolveSpec(spec, exists) {
  const base = spec.split("?")[0].replace(/\/+$/, "");
  for (const ending of SPEC_ENDINGS) if (validRef(base + ending) && exists(base + ending)) return base + ending;
  return null;
}

const KINDS = [
  ["image", /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i],
  ["video", /\.(mp4|webm|mov|m4v)$/i],
  ["audio", /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i],
  ["font", /\.(ttf|otf|woff2?)$/i],
  ["model", /\.(glb|gltf|fbx|obj)$/i],
  ["environment", /\.(hdr|exr)$/i],
  ["code", /\.(m?[jt]sx?|cjs|glsl|frag|vert|wgsl|css)$/i],
  ["data", /\.(json|csv|txt|md)$/i],
];
const kindOf = (file) => KINDS.find(([, pattern]) => pattern.test(file))?.[0] ?? "file";
/** Words a kind of file is found by in the studio's search. */
const KIND_WORDS = { image: "图片 图像", video: "视频", audio: "音频 声音 音乐 音效", font: "字体", model: "模型 三维 3d", environment: "全景图 环境光 hdr", code: "代码", data: "数据" };
/** What a listing says about a media file besides its kind: size, length, animations, problems. */
export const mediaFacts = (info) =>
  Object.fromEntries(
    Object.entries({
      width: info.width,
      height: info.height,
      duration: info.duration,
      fps: info.kind === "lottie" ? info.fps : undefined,
      animations: info.animations?.length ? info.animations : undefined,
      triangles: info.triangles,
      problem: info.problem,
    }).filter(([, value]) => value !== undefined && value !== 0),
  );

/** The introduction a new library's README starts with (it says nothing about the library). */
const templateLead = (title) => `素材库「${title}」。引用了它的作品可以直接使用其中的文件：\`materials/${folderOf(title)}/<文件>\`。`;
const libraryReadme = (title) => `# ${title}

${templateLead(title)}

## 来源与许可

`;

export class Materials {
  constructor(services) {
    this.services = services;
    this.locks = new Locks();
    this.heads = new Map(); // repo → Promise<Map path → blob>, dropped when the branch changes
    this.blobs = new Lru(500); // blob → text of library code (blobs never change)
    this.links = new Lru(20000); // blob → what library code names: imports, materials/… addresses (small; follow() runs per listing and thumbnail)
    this.manifests = new Map(); // root → { ref: blob } of its .materials copies
    this.excluded = new Set(); // repositories whose worktrees ignore .materials
    this.listed = new Map(); // repo → { commit, libraries }: the listing walks every file, so it is kept per version
    this.sizes = new Lru(20000); // blob → size of its content (an LFS pointer's object)
  }

  /** The materials worktree of a repository (checked out on first use). */
  dir(repo) {
    return this.services.repos.library(repo);
  }
  /** A work-like handle, so the works' version functions (history, push, pull…) apply. */
  async scope(repo) {
    const root = await this.dir(repo);
    return { id: `materials-${repo}`, repo, root, dir: root, branch: MATERIALS_BRANCH };
  }

  // ---- libraries --------------------------------------------------------------------

  title(dir, id) {
    try {
      return /^#\s+(.+)$/m.exec(fs.readFileSync(path.join(dir, id, "README.md"), "utf8"))?.[1].trim() || id;
    } catch {
      return id;
    }
  }
  /**
   * The libraries: folder name, title, number of files and their size, and the README's
   * introduction (`about`). Every change is a version, so the listing is kept until the
   * branch moves.
   */
  async libraries(repo) {
    const dir = await this.dir(repo);
    const commit = (await git(dir, ["rev-parse", "HEAD"]).catch(() => "")).trim();
    const known = this.listed.get(repo);
    if (commit && known?.commit === commit) return known.libraries.map((library) => ({ ...library }));
    const libraries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => {
        const files = tree(path.join(dir, entry.name), { maxEntries: 100000 }).filter((item) => item.type === "file" && item.path !== "README.md");
        const title = this.title(dir, entry.name);
        return {
          id: entry.name,
          title,
          files: files.length,
          size: files.reduce((sum, item) => sum + (item.size || 0), 0),
          about: readmeLead(path.join(dir, entry.name, "README.md"), templateLead(title)),
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title, "zh"));
    if (commit) this.listed.set(repo, { commit, libraries });
    return libraries.map((library) => ({ ...library }));
  }
  /** Run a change in the worktree and save it as a version (only the given paths). */
  async save(repo, paths, message, change) {
    const dir = await this.dir(repo);
    return this.locks.run(repo, async () => {
      const result = await change(dir);
      await git(dir, ["add", "-A", "--", ...paths]);
      const changed = !(await gitOk(dir, ["diff", "--cached", "--quiet"]));
      if (changed) await git(dir, ["commit", "-q", "-m", message]);
      this.services.events.emit({ type: "materials", repo, paths });
      if (changed) this.services.works.saved(await this.scope(repo));
      return result;
    });
  }
  async create(repo, name) {
    const title = String(name || "").trim();
    const id = folderOf(title);
    if (!validId(id)) throw problem(400, "请填写素材库名称");
    const dir = await this.dir(repo);
    if (fs.existsSync(path.join(dir, id))) throw conflict(`已经有名为「${id}」的素材库`);
    await this.save(repo, [id], `新建素材库：${title}`, () => writeText(dir, `${id}/README.md`, libraryReadme(title)));
    return { id, title };
  }
  /**
   * Delete a library: into the recycle bin (.trash/ on the branch), from where it can come
   * back. Works keep the versions they locked either way: those stay in the branch's history.
   */
  async remove(repo, id) {
    const dir = await this.dir(repo);
    if (!validId(id) || !fs.existsSync(path.join(dir, id))) throw notFound("素材库不存在");
    const title = this.title(dir, id);
    const key = await this.save(repo, [id, TRASH], `删除素材库：${title}（移到回收站）`, () => moveToTrash(dir, id, title));
    return { key, id, title };
  }
  /** The worktree when the branch exists (here or on GitHub), else null: looking need not create it. */
  async existing(repo) {
    if (fs.existsSync(path.join(this.services.config.dirs.libraries, repo, ".git"))) return this.dir(repo);
    return (await this.services.repos.hasBranch(repo, MATERIALS_BRANCH)) ? this.dir(repo) : null;
  }
  /** The libraries in the recycle bin. */
  async trash(repo) {
    const dir = await this.existing(repo);
    return dir ? trashed(dir) : [];
  }
  /** A library back from the bin: under its name, or a free one when that was taken meanwhile. */
  async restore(repo, key) {
    const dir = await this.dir(repo);
    const note = trashNote(dir, key);
    const id = restoreName(dir, note);
    await this.save(repo, [TRASH, id], `恢复素材库：${note.title}${id !== note.id ? `（改名为「${id}」）` : ""}`, () => moveFromTrash(dir, key, id));
    return { id, title: note.title, renamed: id !== note.id };
  }
  /** Delete a library in the bin for good; `key` null empties the bin. The history keeps them. */
  async purge(repo, key = null) {
    const dir = await this.dir(repo);
    const notes = key === null ? trashed(dir) : [trashNote(dir, key)];
    if (!notes.length) return { purged: [] };
    await this.save(repo, [TRASH], key === null ? "清空素材库回收站" : `从回收站删除素材库：${notes[0].title}`, () => {
      for (const note of notes) purgeTrash(dir, note.key);
    });
    return { purged: notes.map((note) => note.key) };
  }

  /** The current versions in the branch: path → blob. */
  async head(dir) {
    const out = await git(dir, ["ls-tree", "-r", "-z", "HEAD"]).catch(() => "");
    const blobs = new Map();
    for (const line of out.split("\0").filter(Boolean)) {
      const [info, file] = line.split("\t");
      blobs.set(file, info.split(" ")[2]);
    }
    return blobs;
  }
  async files(repo, id) {
    const dir = await this.dir(repo);
    if (!validId(id) || !fs.existsSync(path.join(dir, id))) throw notFound("素材库不存在");
    const blobs = await this.head(dir);
    const result = [];
    for (const item of tree(path.join(dir, id), { maxEntries: 100000 }).filter((entry) => entry.type === "file" && entry.path !== "README.md"))
      result.push(await this.describeFile(dir, id, item.path, item.size, blobs.get(`${id}/${item.path}`) ?? null));
    return result;
  }
  /**
   * A library file as listings show it. Size, length and contents for the thumbnails (cached
   * until the file changes): a .webm may hold only sound, a .json may be a Lottie animation.
   */
  async describeFile(dir, id, relative, size, blob) {
    const kind = kindOf(relative);
    const probed = ["image", "video", "audio", "model", "environment"].includes(kind) || /\.json$/i.test(relative);
    const info = probed ? await probe(path.join(dir, id, relative)).catch(() => ({})) : {};
    return {
      path: relative,
      ref: `${id}/${relative}`,
      url: `materials/${id}/${relative}`,
      kind: info.kind === "audio" && kind === "video" ? "audio" : info.kind === "lottie" ? "lottie" : kind,
      size,
      blob,
      ...mediaFacts(info),
    };
  }
  /**
   * Files of every library whose path (or kind, in Chinese) has all the words: finding a file
   * without knowing which of many libraries holds it. Only the matches are looked into.
   */
  async find(repo, query, limit = 120) {
    const words = searchWords(query);
    if (!words.length) return [];
    const dir = await this.dir(repo);
    const result = [];
    for (const [ref, blob] of await this.head(dir)) {
      const [id, ...rest] = ref.split("/");
      const relative = rest.join("/");
      if (!relative || relative === "README.md" || id.startsWith(".")) continue;
      if (!words.every((word) => `${ref} ${KIND_WORDS[kindOf(relative)] ?? ""}`.toLowerCase().includes(word))) continue;
      const stat = fs.statSync(path.join(dir, ref), { throwIfNoEntry: false });
      if (!stat?.isFile()) continue;
      result.push(await this.describeFile(dir, id, relative, stat.size, blob));
      if (result.length >= limit) break;
    }
    return result;
  }
  libraryOf(dir, id) {
    if (!validId(id) || !fs.existsSync(path.join(dir, id))) {
      // The closest names (from the folders: this runs synchronously), as the link tools say them.
      const all = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => ({ id: entry.name, title: this.title(dir, entry.name) }));
      const close = closestLibraries(String(id), all, 5);
      throw notFound(`素材库「${id}」不存在${close.length ? `。最接近的：${close.map((item) => `「${item.id}」`).join("")}` : ""}（素材库很多时用 materials_list 的 query 查找，新建用 materials_link 的 create）`);
    }
    return path.join(dir, id);
  }
  /** Note where a third-party file comes from, in the library's README. */
  credit(dir, id, relative, { source, license }) {
    if (!source && !license) return;
    const file = path.join(dir, id, "README.md");
    let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : libraryReadme(id);
    if (!/^## 来源与许可/m.test(text)) text = text.replace(/\n*$/, "\n\n## 来源与许可\n\n");
    const line = `- \`${relative}\`：${[source && `来源 ${source}`, license && `许可 ${license}`].filter(Boolean).join("；")}`;
    writeFileAtomic(file, text.replace(/\n*$/, "\n") + line + "\n");
  }
  /**
   * Keep the README's source notes in step with the files: lines of files that moved follow
   * them (to another library's README too), lines of deleted files go.
   */
  recredit(dir, id, from, to = null, toLibrary = id) {
    const file = path.join(dir, id, "README.md");
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const mine = (line) => {
      const named = /^- `([^`]+)`：/.exec(line)?.[1];
      return named && (named === from || named.startsWith(from + "/")) ? named : null;
    };
    const moved = lines.filter(mine).map((line) => line.replace(/^- `([^`]+)`/, (_, named) => `- \`${to}${named.slice(from.length)}\``));
    if (!moved.length) return 0;
    writeFileAtomic(file, lines.filter((line) => !mine(line)).join("\n"));
    if (!to) return moved.length;
    if (toLibrary === id) {
      const text = fs.readFileSync(file, "utf8");
      writeFileAtomic(file, text.replace(/\n*$/, "\n") + moved.join("\n") + "\n");
      return moved.length;
    }
    for (const line of moved) {
      const [, named, note] = /^- `([^`]+)`：(.*)$/.exec(line);
      const source = /来源 ([^；]+)/.exec(note)?.[1];
      const license = /许可 (.+)$/.exec(note)?.[1];
      this.credit(dir, toLibrary, named, { source, license });
    }
    return moved.length;
  }
  /**
   * A new README: the library's title (its first "# " line), introduction (first paragraph)
   * and notes. Source notes of the old one that the new text lacks are kept at its end (for
   * files still there).
   */
  readme(dir, id, text) {
    const file = path.join(dir, id, "README.md");
    const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const exists = (line) => fs.existsSync(path.join(dir, id, /^- `([^`]+)`：/.exec(line)[1]));
    const notes = old.split("\n").filter((line) => /^- `[^`]+`：/.test(line) && exists(line) && !text.includes(line.slice(0, line.indexOf("：") + 1)));
    let next = text.replace(/\n*$/, "\n");
    if (notes.length) next = (/^## 来源与许可/m.test(next) ? next : next + "\n## 来源与许可\n\n") + notes.join("\n") + "\n";
    writeFileAtomic(file, next);
    return notes.length;
  }
  /** Add or replace a file: from a stream (upload), a URL, a file on disk or text content. */
  async put(repo, id, relative, from, { source, license, replace = true } = {}) {
    const dir = await this.dir(repo);
    this.libraryOf(dir, id);
    if (!relative) throw problem(400, "需要文件路径");
    if (relative === "README.md") {
      if (typeof from.content !== "string") throw problem(400, "README.md 用 content 写入文本");
      if (!/^#\s+\S/m.test(from.content)) throw problem(400, "README.md 需要一个一级标题（# 素材库名称）：它是素材库显示的名称，标题后的第一段是介绍");
      const kept = await this.save(repo, [id], `素材库「${this.title(dir, id)}」：更新 README.md`, () => this.readme(dir, id, from.content));
      return { ref: `${id}/README.md`, url: `materials/${id}/README.md`, path: "README.md", kind: "text", kept };
    }
    let target = `${id}/${relative}`;
    confined(dir, target);
    const existed = fs.existsSync(path.join(dir, target));
    if (existed && !replace) target = uniquePath(dir, target);
    const saved = await this.save(repo, [id], `素材库「${this.title(dir, id)}」：${existed && replace ? "更新" : "添加"} ${target.slice(id.length + 1)}`, async () => {
      if (from.url) {
        if (existed && replace) fs.rmSync(path.join(dir, target));
        target = await importFromUrl({ dir }, from.url, { name: path.basename(target), folder: path.dirname(target), publicOnly: this.services.auth.required });
      }
      else if (from.stream) await writeStream(dir, target, from.stream, { overwrite: true });
      else if (from.file) {
        fs.mkdirSync(path.dirname(path.join(dir, target)), { recursive: true });
        fs.copyFileSync(from.file, path.join(dir, target));
      } else writeText(dir, target, String(from.content ?? ""));
      this.credit(dir, id, target.slice(id.length + 1), { source, license });
      return target;
    });
    // A .json may be a Lottie animation: the listing and the AI see it as one.
    const lottie = /\.json$/i.test(saved) && (await probe(path.join(dir, saved)).catch(() => ({}))).kind === "lottie";
    return { ref: saved, url: `materials/${saved}`, path: saved.slice(id.length + 1), kind: lottie ? "lottie" : kindOf(saved) };
  }
  async move(repo, id, from, to, { toLibrary } = {}) {
    const dir = await this.dir(repo);
    this.libraryOf(dir, id);
    const target = toLibrary || id;
    this.libraryOf(dir, target);
    if (from === "README.md" || to === "README.md") throw problem(400, "README.md 不能移动或被替换：直接用 put（content）或 edit 修改它");
    const notes = await this.save(repo, [id, target], `素材库：移动 ${id}/${from} → ${target}/${to}`, () => {
      movePath(dir, `${id}/${from}`, `${target}/${to}`);
      return this.recredit(dir, id, from, to, target);
    });
    return { ref: `${target}/${to}`, url: `materials/${target}/${to}`, notes };
  }
  async delete(repo, id, relative) {
    const dir = await this.dir(repo);
    this.libraryOf(dir, id);
    if (relative === "README.md") throw problem(400, "README.md 是素材库的说明并记录素材的来源与许可，不能删除；要改内容用 put（content）或 edit");
    return this.save(repo, [id], `素材库「${this.title(dir, id)}」：删除 ${relative}`, () => {
      removePath(dir, `${id}/${relative}`);
      return this.recredit(dir, id, relative);
    });
  }

  // ---- works ------------------------------------------------------------------------

  /** The library names a work references (project.ts `materials`). */
  names(work) {
    const value = this.services.works.meta(work).meta?.materials;
    return Array.isArray(value) ? [...new Set(value.filter(validId))] : [];
  }
  async linked(work) {
    const dir = await this.dir(work.repo);
    const names = this.names(work);
    return {
      libraries: names.filter((name) => fs.existsSync(path.join(dir, name))).map((id) => ({ id, title: this.title(dir, id) })),
      missing: names.filter((name) => !fs.existsSync(path.join(dir, name))),
    };
  }
  readLocks(dir) {
    if (!dir) return {}; // the library root: no work, no locks
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }
  /** Write the lock file (none when nothing is locked) and let the copies and the preview follow. */
  async saveLocks(work, locks) {
    const file = path.join(work.dir, LOCK_FILE);
    const sorted = Object.fromEntries(Object.entries(locks).sort(([a], [b]) => a.localeCompare(b)));
    if (Object.keys(sorted).length) writeFileAtomic(file, JSON.stringify(sorted, null, 2) + "\n");
    else fs.rmSync(file, { force: true });
    await this.refreshCopies({ root: work.root, repo: work.repo, dir: work.dir });
    this.services.events.emit({ type: "work-materials", work: work.id, repo: work.repo });
    // Same addresses, other content: the preview reloads the media.
    this.services.preview?.assetsChanged?.(work, [file]);
  }
  /** The work's own source files (not its media, exports or notes). */
  sourceFiles(work) {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || ["node_modules", "exports", "public", "production"].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs|json)$/.test(entry.name) && entry.name !== LOCK_FILE) files.push(full);
      }
    };
    walk(work.dir);
    return files;
  }
  /** `@materials/…` imports in a work's code. */
  imports(work) {
    const imports = [];
    for (const file of this.sourceFiles(work))
      if (/\.(ts|tsx|js|mjs)$/.test(file))
        for (const spec of importSpecs(fs.readFileSync(file, "utf8")))
          if (spec.startsWith("@materials/")) imports.push({ spec: spec.slice(11), from: path.relative(work.dir, file).split(path.sep).join("/") });
    return imports;
  }

  /**
   * Every library file the work uses: materials/<ref> in its code and documents, the library
   * code it imports (@materials/…) with that code's own imports, and the materials that code
   * uses. `unresolved`: imports that lead to no library file. `prefixes`: the known start of
   * addresses built at run time (any file under one may be used).
   */
  async usage(work) {
    const refs = new Set();
    const prefixes = new Set();
    // Library code named by a document (a sound module in audio.json) runs like an import.
    const named = [];
    for (const file of this.sourceFiles(work))
      for (const match of fs.readFileSync(file, "utf8").matchAll(MATERIAL_REF)) {
        const prefix = prefixOf(match[1]);
        if (prefix !== null) prefixes.add(prefix);
        else if (validRef(match[1])) {
          refs.add(match[1]);
          if (SCRIPT.test(match[1])) named.push({ spec: match[1], from: path.relative(work.dir, file).split(path.sep).join("/") });
        }
      }
    const imports = [...this.imports(work), ...named];
    if (!imports.length) return { refs, unresolved: [], prefixes: [...prefixes] };
    const code = await this.follow(work.repo, this.readLocks(work.dir), imports);
    for (const ref of code.refs) refs.add(ref);
    for (const prefix of code.prefixes) prefixes.add(prefix);
    return { refs, unresolved: code.unresolved, prefixes: [...prefixes] };
  }
  async references(work) {
    return (await this.usage(work)).refs;
  }

  /**
   * The library files a work plays (code runs from .materials, so not code): what it uses or
   * has locked, and for addresses built at run time every file under the known part. With
   * their size and a version for the browser's asset precache: the locked blob, else the
   * content of the file as it is now. Nothing is extracted or downloaded here.
   */
  async playback(work) {
    const head = await this.headOf(work.repo).catch(() => null);
    if (!head) return [];
    const dir = await this.dir(work.repo);
    const locks = this.readLocks(work.dir);
    const { refs, prefixes } = await this.usage(work);
    const wanted = new Set([...Object.keys(locks), ...refs]);
    for (const prefix of prefixes) for (const ref of [...Object.keys(locks), ...head.keys()]) if (ref.startsWith(prefix)) wanted.add(ref);
    const files = [];
    for (const ref of [...wanted].sort()) {
      if (!validRef(ref) || SCRIPT.test(ref) || ref.startsWith(".") || ref.endsWith("/README.md")) continue;
      if (locks[ref]) {
        const size = await this.blobSize(dir, locks[ref]);
        if (size !== null) files.push({ ref, size, version: "git-" + locks[ref] });
        continue;
      }
      const file = path.join(dir, ref);
      const stat = inside(dir, file) ? fs.statSync(file, { throwIfNoEntry: false }) : null;
      if (stat?.isFile()) files.push({ ref, size: stat.size, version: await contentVersion(file, stat) });
    }
    return files;
  }
  /** Size of a blob's content (a Git LFS pointer's object), or null when the blob is not here. */
  async blobSize(dir, blob) {
    if (!/^[0-9a-f]{40,64}$/.test(blob)) return null;
    if (this.sizes.has(blob)) return this.sizes.get(blob);
    const stored = Number((await git(dir, ["cat-file", "-s", blob]).catch(() => "")).trim() || NaN);
    if (!Number.isFinite(stored)) return null;
    let size = stored;
    if (stored < 1024) {
      const text = await git(dir, ["cat-file", "blob", blob]).catch(() => "");
      const pointer = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n[\s\S]*?^size (\d+)$/m.exec(text);
      if (pointer) size = Number(pointer[1]);
    }
    this.sizes.set(blob, size);
    return size;
  }

  /**
   * Library code reached from imports (`{ spec, from }`, spec without "@materials/"), at the
   * versions in `locks` or else as the library has it now: the files, their relative and
   * @materials imports, and the materials/<ref> they use.
   */
  async follow(repo, locks, imports) {
    const head = await this.headOf(repo);
    const exists = (ref) => Boolean(locks[ref] || head.has(ref));
    const refs = new Set();
    const prefixes = new Set();
    const unresolved = [];
    const queue = [];
    const visit = (spec, from) => {
      const ref = resolveSpec(spec, exists);
      if (!ref) unresolved.push({ spec: `@materials/${spec}`, from });
      else if (!refs.has(ref)) {
        refs.add(ref);
        queue.push(ref);
      }
    };
    for (const { spec, from } of imports) visit(spec, from);
    while (queue.length) {
      const ref = queue.shift();
      if (!SCRIPT.test(ref)) continue;
      const links = await this.linksOf(repo, locks[ref] ?? head.get(ref));
      for (const item of links.refs) refs.add(item);
      for (const prefix of links.prefixes) prefixes.add(prefix);
      for (const spec of links.specs) {
        if (spec.startsWith("@materials/")) visit(spec.slice(11), `materials/${ref}`);
        else if (/^\.\.?\//.test(spec)) {
          // Relative imports stay in the libraries; ../../src/engine/… leaves them (the engine).
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(ref), spec.split("?")[0]));
          if (!target.startsWith("../")) visit(target, `materials/${ref}`);
        }
      }
    }
    return { refs, unresolved, prefixes: [...prefixes] };
  }

  /** What one version of library code names: its import specifiers and materials/… addresses. */
  async linksOf(repo, blob) {
    let links = this.links.get(blob);
    if (links) return links;
    let text;
    try {
      text = await this.text(repo, blob);
    } catch {
      return { refs: [], prefixes: [], specs: [] };
    }
    links = { refs: [], prefixes: [], specs: importSpecs(text) };
    for (const match of text.matchAll(MATERIAL_REF)) {
      const prefix = prefixOf(match[1]);
      if (prefix !== null) links.prefixes.push(prefix);
      else if (validRef(match[1])) links.refs.push(match[1]);
    }
    this.links.set(blob, links);
    return links;
  }

  /** The branch's current files (cached until the libraries change). */
  headOf(repo) {
    if (!this.heads.has(repo)) {
      const pending = this.dir(repo).then((dir) => this.head(dir));
      pending.catch(() => this.heads.delete(repo));
      this.heads.set(repo, pending);
    }
    return this.heads.get(repo);
  }
  /** Text of a library code file by blob. */
  async text(repo, blob) {
    if (!blob || !/^[0-9a-f]{40,64}$/.test(blob)) throw notFound("没有这个版本");
    let text = this.blobs.get(blob);
    if (text === undefined) {
      text = await git(await this.dir(repo), ["cat-file", "blob", blob]);
      this.blobs.set(blob, text);
    }
    return text;
  }

  /**
   * Lock files a work uses at their current version (or move existing locks to it with
   * `update`). Library code (extension optional) brings the files it imports and the
   * materials it uses. Returns what changed and the references that point at nothing.
   */
  async lock(work, refs, { update = false } = {}) {
    this.services.works.assertEditable(work);
    const dir = await this.dir(work.repo);
    const head = await this.head(dir);
    this.heads.set(work.repo, Promise.resolve(head));
    const locks = this.readLocks(work.dir);
    const exists = (ref) => Boolean(locks[ref] || head.has(ref));
    const wanted = new Set();
    const missing = [];
    const code = [];
    for (const ref of new Set(refs)) {
      const found = validRef(ref) && exists(ref) ? ref : resolveSpec(ref, exists);
      if (!found) missing.push(ref);
      else {
        wanted.add(found);
        if (SCRIPT.test(found)) code.push({ spec: found, from: "" });
      }
    }
    // Updated code brings what it imports now; a first lock keeps the versions locked before.
    for (const ref of (await this.follow(work.repo, update ? {} : locks, code)).refs) wanted.add(ref);
    const locked = [];
    for (const ref of wanted) {
      if (locks[ref] && !update) continue;
      const blob = head.get(ref);
      if (!blob) {
        if (!locks[ref]) missing.push(ref);
        continue;
      }
      if (locks[ref] !== blob) {
        locks[ref] = blob;
        locked.push(ref);
      }
    }
    if (locked.length) await this.saveLocks(work, locks);
    return { locked, missing };
  }
  /**
   * Lock what the work uses and has not locked yet (after placing a material, before a
   * version), and link the libraries those files are in, as materials_use does.
   */
  async lockReferenced(work) {
    if (this.services.works.published(work)) return { locked: [], missing: [] };
    const locks = this.readLocks(work.dir);
    const refs = await this.references(work);
    const result = await this.lock(
      work,
      [...refs].filter((ref) => !locks[ref]),
    );
    const names = this.names(work);
    const dir = await this.dir(work.repo);
    const unlinked = [...new Set([...refs].map((ref) => ref.split("/")[0]))].filter((id) => !names.includes(id) && fs.existsSync(path.join(dir, id)));
    if (unlinked.length) await this.services.works.update(work, { materials: [...names, ...unlinked] });
    return result;
  }
  /**
   * Before a version (and a publication): the lock file holds what the work uses. New references
   * are locked; locks of files it no longer uses are dropped (a file taken up again later is
   * locked at that day's version). Addresses built at run time keep every lock they may name.
   */
  async syncLocks(work) {
    if (this.services.works.published(work)) return { locked: [], missing: [], dropped: [] };
    const result = await this.lockReferenced(work);
    const locks = this.readLocks(work.dir);
    const { refs, prefixes } = await this.usage(work);
    const dropped = Object.keys(locks).filter((ref) => !refs.has(ref) && !prefixes.some((prefix) => ref.startsWith(prefix)));
    if (dropped.length) {
      for (const ref of dropped) delete locks[ref];
      await this.saveLocks(work, locks);
    }
    return { ...result, dropped };
  }

  // ---- a work moving to another repository (works.move) ----------------------------------

  /**
   * What moving a work to repository `to` means for its materials: the libraries it uses that
   * `to` lacks are copied there as they are now (`copy`); same-named libraries there are used
   * instead (`shared`). Files the work uses that `to` will have in another version than the one
   * it uses now (`changed`: locked earlier, or a different library of that name) or not at all
   * (`missing`).
   */
  async movePlan(work, to) {
    const source = await this.existing(work.repo);
    if (!source) return { copy: [], shared: [], changed: [], missing: [] };
    const head = await this.head(source);
    const used = new Map(Object.entries(this.readLocks(work.dir)));
    for (const ref of await this.references(work)) if (!used.has(ref) && head.has(ref)) used.set(ref, head.get(ref));
    const names = [...new Set([...this.names(work), ...[...used.keys()].map((ref) => ref.split("/")[0])])].filter((id) =>
      fs.existsSync(path.join(source, id)),
    );
    const target = await this.existing(to);
    const there = target ? await this.head(target) : new Map();
    const copied = (id) => !target || !fs.existsSync(path.join(target, id));
    const changed = [];
    const missing = [];
    for (const [ref, blob] of [...used].sort(([a], [b]) => a.localeCompare(b))) {
      const id = ref.split("/")[0];
      const after = names.includes(id) && copied(id) ? head.get(ref) : there.get(ref);
      if (!after) missing.push(ref);
      else if (after !== blob) changed.push(ref);
    }
    const describe = (id) => ({ id, title: this.title(source, id) });
    return { copy: names.filter(copied).map(describe), shared: names.filter((id) => !copied(id)).map(describe), changed, missing };
  }

  /** Before the work moves: copy the libraries it uses that `to` lacks there, as one version. */
  async carry(work, to, from) {
    const plan = await this.movePlan(work, to);
    if (!plan.copy.length) return plan;
    const source = await this.dir(work.repo);
    const ids = plan.copy.map((library) => library.id);
    await this.save(to, ids, `从「${from}」迁入素材库：${plan.copy.map((library) => library.title).join("、")}`, (dir) => {
      for (const id of ids) fs.cpSync(path.join(source, id), path.join(dir, id), { recursive: true });
    });
    return plan;
  }

  /**
   * After the work moved: its locks name the versions of its old repository; lock the files
   * at the versions this repository has (none when it lacks a file), and save that as a
   * version (published works too). Returns the files whose lock changed.
   */
  async relock(work) {
    const locks = this.readLocks(work.dir);
    if (!Object.keys(locks).length) return [];
    const head = await this.head(await this.dir(work.repo));
    const changed = Object.keys(locks).filter((ref) => head.get(ref) !== locks[ref]);
    if (!changed.length) return [];
    for (const ref of changed) {
      if (head.has(ref)) locks[ref] = head.get(ref);
      else delete locks[ref];
    }
    const { works } = this.services;
    const published = works.published(work);
    if (published) works.lockFiles(work.root, false);
    try {
      await this.saveLocks(work, locks);
      if (await works.locks.run(`${work.repo}/${work.id}`, () => works.commitAll(work.root, "迁移后改用这个作品库里的素材版本"))) works.saved(work);
    } finally {
      if (published) works.lockFiles(work.root, true);
    }
    return changed;
  }

  // ---- .materials: the library code a work (or export snapshot) runs ---------------------

  /**
   * Where library code runs as the library has it now, outside any work (resource previews
   * and thumbnails): <tmp>/library/<repo>/ with its own .materials copies, never a work's
   * locked versions — a work may hold old locks of some files, and mixing those with the
   * current ones breaks the code.
   */
  libraryRoot(repo) {
    this.services.repos.get(repo);
    const root = path.join(this.services.config.dirs.tmp, "library", repo);
    fs.mkdirSync(root, { recursive: true });
    for (const name of ["src", "node_modules"]) {
      const link = path.join(root, name);
      const target = path.join(appRoot, name);
      try {
        if (fs.readlinkSync(link) === target) continue;
        fs.unlinkSync(link);
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "EINVAL") throw error;
      }
      fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    }
    return root;
  }

  /** Where pages load library code and files from as the library has them now (resource previews). */
  libraryBases(repo) {
    return {
      materialBase: this.services.preview.moduleUrl(path.join(this.libraryRoot(repo), MATERIALIZED)) + "/",
      assetBase: `/files/${repo}/-/`,
    };
  }

  /** The work, export snapshot or library root a file belongs to: its root, repository and lock file folder. */
  rootOf(file) {
    const { works: worksDir, tmp } = this.services.config.dirs;
    const library = path.join(tmp, "library");
    if (inside(library, file)) {
      const [repo] = path.relative(library, file).split(path.sep);
      try {
        return { root: this.libraryRoot(repo), repo, dir: null };
      } catch {
        return null;
      }
    }
    if (inside(worksDir, file)) {
      const [repo, id] = path.relative(worksDir, file).split(path.sep);
      if (!repo || !id) return null;
      try {
        return { root: path.join(worksDir, repo, id), repo, dir: this.services.works.describe(repo, id).dir };
      } catch {
        return null;
      }
    }
    const snapshots = path.join(tmp, "snapshots");
    if (inside(snapshots, file)) {
      const [id] = path.relative(snapshots, file).split(path.sep);
      if (!id) return null;
      const root = path.join(snapshots, id);
      try {
        const source = JSON.parse(fs.readFileSync(path.join(root, ".frame-snapshot.json"), "utf8"));
        return { root, repo: source.repo, dir: path.join(root, "projects", source.slug) };
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Vite: `@materials/<library>/<path>` imported by a work (or an export snapshot), and
   * relative imports inside the copied library code. Returns the copy in .materials/.
   */
  async resolveImport(source, importer) {
    const marker = `${path.sep}${MATERIALIZED}${path.sep}`;
    const bare = source.split("?")[0];
    const query = source.slice(bare.length);
    // A page's own request (Vite names the HTML entry as importer): /@fs/<root>/.materials/<ref>
    if (bare.startsWith("/@fs/")) return this.resolveRequest(bare, query);
    if (!importer) return null;
    importer = importer.split("?")[0];
    let spec;
    if (bare.startsWith("@materials/")) spec = bare.slice(11);
    else if (/^\.\.?\//.test(bare) && importer.includes(marker)) {
      const base = importer.slice(0, importer.indexOf(marker) + marker.length - 1);
      const target = path.resolve(path.dirname(importer), bare);
      if (!inside(base, target)) return null; // the engine, node_modules
      spec = path.relative(base, target).split(path.sep).join("/");
    } else return null;
    const place = this.rootOf(importer);
    if (!place) return null;
    const locks = this.readLocks(place.dir);
    const head = await this.headOf(place.repo);
    const ref = resolveSpec(spec, (candidate) => Boolean(locks[candidate] || head.has(candidate)));
    if (!ref) {
      if (bare.startsWith("@materials/")) throw new Error(`素材库里没有 ${bare}：先引用它所在的素材库，并检查路径`);
      return null;
    }
    return (await this.copy(place, ref, locks[ref] ?? head.get(ref))) + query;
  }

  /**
   * A page importing library code a document names (src/engine/materials.ts):
   * /@fs/<root>/.materials/<ref>, copied there first at the version the work uses.
   */
  async resolveRequest(bare, query) {
    if (!bare.startsWith("/@fs/") || !bare.includes(`/${MATERIALIZED}/`)) return null;
    const decode = (part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    };
    const file = path.resolve(bare.slice(4).split("/").map(decode).join("/"));
    const place = this.rootOf(file);
    const base = place && path.join(place.root, MATERIALIZED);
    if (!place || !inside(base, file)) return null;
    const spec = path.relative(base, file).split(path.sep).join("/");
    const locks = this.readLocks(place.dir);
    const head = await this.headOf(place.repo);
    const ref = resolveSpec(spec, (candidate) => Boolean(locks[candidate] || head.has(candidate)));
    if (!ref) throw new Error(`素材库里没有 materials/${spec}：先引用它所在的素材库，并检查路径`);
    return (await this.copy(place, ref, locks[ref] ?? head.get(ref))) + query;
  }

  /** Put one library file into <root>/.materials/ at a version; returns its path there. */
  async copy(place, ref, blob) {
    const file = path.join(place.root, MATERIALIZED, ...ref.split("/"));
    await this.ignoreCopies(place.repo);
    return this.locks.run(`copy:${place.root}`, async () => {
      const manifest = this.manifest(place.root);
      if (manifest[ref] === blob && fs.existsSync(file)) return file;
      writeFileAtomic(file, await this.text(place.repo, blob));
      manifest[ref] = blob;
      this.saveManifest(place.root);
      this.services.preview?.invalidateFile?.(file); // a page reloading right now must not get the old compiled code
      return file;
    });
  }
  manifest(root) {
    if (!this.manifests.has(root)) {
      let value = {};
      try {
        value = JSON.parse(fs.readFileSync(path.join(root, MATERIALIZED, ".manifest.json"), "utf8"));
      } catch {}
      this.manifests.set(root, value);
    }
    return this.manifests.get(root);
  }
  saveManifest(root) {
    writeFileAtomic(path.join(root, MATERIALIZED, ".manifest.json"), JSON.stringify(this.manifest(root), null, 2) + "\n");
  }
  /** Worktrees never commit the copies (also in repositories set up before they existed). */
  async ignoreCopies(repo) {
    if (this.excluded.has(repo)) return;
    await this.services.repos.prepare(this.services.repos.get(repo).dir);
    this.excluded.add(repo);
  }

  /**
   * Bring a root's copies up to date with its locks and the libraries: changed versions are
   * rewritten (the preview reloads them), files no longer there are removed. With `all`,
   * every library file the work imports is copied first (before a type check).
   */
  async refreshCopies(place, { all = false } = {}) {
    const locks = this.readLocks(place.dir);
    const head = await this.headOf(place.repo);
    const wanted = new Set(Object.keys(this.manifest(place.root)));
    if (all) for (const ref of (await this.follow(place.repo, locks, this.imports({ dir: place.dir }))).refs) if (IMPORTABLE.test(ref)) wanted.add(ref);
    for (const ref of wanted) {
      const blob = locks[ref] ?? head.get(ref);
      if (blob) await this.copy(place, ref, blob);
      else
        await this.locks.run(`copy:${place.root}`, async () => {
          fs.rmSync(path.join(place.root, MATERIALIZED, ...ref.split("/")), { force: true });
          delete this.manifest(place.root)[ref];
          this.saveManifest(place.root);
        });
    }
  }
  /** A repository removed from this machine: what was kept of its libraries goes. */
  forget(repo) {
    const library = path.join(this.services.config.dirs.tmp, "library", repo);
    const works = path.join(this.services.config.dirs.works, repo);
    this.heads.delete(repo);
    this.listed.delete(repo);
    this.excluded.delete(repo);
    for (const root of this.manifests.keys()) if (root === library || inside(works, root)) this.manifests.delete(root);
    fs.rmSync(library, { recursive: true, force: true });
  }

  /** After the libraries changed: works running copies of their code follow (where not locked), and so does the library root. */
  async refreshRepo(repo) {
    this.heads.delete(repo);
    const library = path.join(this.services.config.dirs.tmp, "library", repo);
    if (fs.existsSync(path.join(library, MATERIALIZED, ".manifest.json"))) await this.refreshCopies({ root: library, repo, dir: null }).catch(() => {});
    const base = path.join(this.services.config.dirs.works, repo);
    if (!fs.existsSync(base)) return;
    for (const id of fs.readdirSync(base)) {
      if (!fs.existsSync(path.join(base, id, MATERIALIZED, ".manifest.json"))) continue;
      const place = this.rootOf(path.join(base, id, "projects"));
      if (place) await this.refreshCopies(place).catch(() => {});
    }
  }

  /** The work's libraries and the files it uses: locked version, current version. */
  async status(work) {
    const dir = await this.dir(work.repo);
    const head = await this.head(dir);
    const locks = this.readLocks(work.dir);
    const { refs: used, unresolved, prefixes } = await this.usage(work);
    const files = [...new Set([...Object.keys(locks), ...used])].sort().map((ref) => ({
      ref,
      url: `materials/${ref}`,
      used: used.has(ref) || prefixes.some((prefix) => ref.startsWith(prefix)),
      locked: locks[ref] ?? null,
      current: head.get(ref) ?? null,
      outdated: Boolean(locks[ref] && head.get(ref) && locks[ref] !== head.get(ref)),
    }));
    return { ...(await this.linked(work)), files, unresolved };
  }

  /**
   * The file behind materials/<ref> for a work (`locks` from its lock file): the locked
   * version, else the current file. Locked versions are read from the branch history
   * (cached by blob), their media downloaded from Git LFS when not stored here.
   */
  async file(repo, locks, ref) {
    if (!validRef(ref)) throw problem(400, "Invalid path");
    const dir = await this.dir(repo);
    const blob = locks[ref];
    if (!blob) {
      const file = confined(dir, ref);
      if (!fs.existsSync(file)) throw notFound(`素材不存在：materials/${ref}`);
      return file;
    }
    if (!/^[0-9a-f]{40,64}$/.test(blob)) throw problem(400, "无效的素材版本");
    const cache = path.join(this.services.config.dirs.tmp, "material-blobs");
    const target = path.join(cache, blob + path.extname(ref).toLowerCase());
    if (fs.existsSync(target)) return target;
    fs.mkdirSync(cache, { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await gitToFile(dir, ["cat-file", "blob", blob], temp);
    } catch {
      throw notFound(`素材 materials/${ref} 锁定的版本不在本机，先在「素材库」中从 GitHub 拉取`);
    }
    const start = Buffer.alloc(64);
    const fd = fs.openSync(temp, "r");
    fs.readSync(fd, start, 0, 64, 0);
    fs.closeSync(fd);
    if (fs.statSync(temp).size < 1024 && start.toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1")) {
      // A Git LFS pointer: smudge gives the content (downloading it if needed).
      const pointer = fs.readFileSync(temp, "utf8");
      const info = this.services.repos.get(repo);
      await gitToFile(dir, ["lfs", "smudge", "--", ref], temp, { input: pointer, env: this.services.repos.env(info) });
    }
    fs.renameSync(temp, target);
    return target;
  }
}

export function materialsPlugin(services) {
  const { router, tools, works } = services;
  const materials = (services.materials = new Materials(services));
  // A version of a work (and its publication) records the material versions it uses, and only those.
  works.beforeSave.push((work) => materials.syncLocks(work));
  services.repos.beforeRemove.push((repo) => materials.forget(repo));
  // Library code: the preview resolves @materials/… to copies at the versions each work uses,
  // which follow the libraries (unlocked files) and the works' lock files (pull, revert, edits).
  services.preview?.importResolvers?.push((source, importer) => materials.resolveImport(source, importer));
  // The branch also moves without a change made here (GitHub's newer versions brought in, a
  // conflict settled): its versions event then counts as a change of the libraries.
  const seen = new Map(); // repo → the commit the libraries were last known at
  const commitOf = async (repo) => (await git(await materials.dir(repo), ["rev-parse", "HEAD"]).catch(() => "")).trim();
  services.events.subscribe((event) => {
    if (event.type === "materials" && event.repo) {
      void commitOf(event.repo).then((commit) => seen.set(event.repo, commit));
      void materials.refreshRepo(event.repo).catch(() => {});
    }
    if (event.type === "work-versions" && String(event.work).startsWith("materials-")) {
      const repo = String(event.work).slice("materials-".length);
      void commitOf(repo).then((commit) => {
        if (!commit || seen.get(repo) === commit) return;
        seen.set(repo, commit);
        services.events.emit({ type: "materials", repo, paths: [] });
      });
    }
    if (event.type === "work-files" && event.files?.some((file) => file.endsWith(LOCK_FILE))) {
      const place = materials.rootOf(path.join(services.config.dirs.works, event.repo, event.work, "projects"));
      if (place) void materials.refreshCopies(place).catch(() => {});
    }
  });
  const base = "/api/repos/:repo/materials";
  const scope = (params) => materials.scope(params.repo);

  // With `work`: whether it uses each library and how well each suits it (the picker's 推荐).
  router.get(`${base}/libraries`, async ({ params, query }) => {
    if (!services.libraries) return materials.libraries(params.repo);
    const work = query.work ? await services.openWork(query.work, params.repo) : null;
    // What the libraries hold counts for what suits the work; the words themselves stay here.
    const libraries = work ? await (services.resources?.librariesWithWords(params.repo) ?? materials.libraries(params.repo)) : await materials.libraries(params.repo);
    return (await services.libraries.annotate("materials", params.repo, libraries, work)).map(({ extra: _extra, ...library }) => library);
  });
  router.post(`${base}/libraries`, async ({ params, req }) => materials.create(params.repo, (await readJson(req)).name));
  router.delete(`${base}/libraries/:lib`, ({ params }) => materials.remove(params.repo, params.lib));
  // The recycle bin of deleted libraries.
  router.get(`${base}/trash`, ({ params }) => materials.trash(params.repo));
  router.post(`${base}/trash/:key/restore`, ({ params }) => materials.restore(params.repo, params.key));
  router.delete(`${base}/trash/:key`, ({ params }) => materials.purge(params.repo, params.key));
  router.delete(`${base}/trash`, ({ params }) => materials.purge(params.repo));
  router.get(`${base}/libraries/:lib/files`, ({ params }) => materials.files(params.repo, params.lib));
  router.get(`${base}/find`, ({ params, query }) => materials.find(params.repo, String(query.q || "")));
  router.post(
    `${base}/libraries/:lib/upload`,
    ({ params, req, query }) =>
      materials.put(params.repo, params.lib, String(query.path || ""), { stream: req }, { source: query.source, license: query.license, replace: query.replace === "1" }),
    { raw: true },
  );
  router.post(`${base}/libraries/:lib/import`, async ({ params, req }) => {
    const body = await readJson(req);
    if (body.work) {
      // From a work's own files (its public/ folder): share it with other works.
      const work = await services.openWork(body.work, params.repo);
      const file = confined(work.dir, body.path);
      return materials.put(params.repo, params.lib, body.name || path.basename(file), { file }, { source: body.source, license: body.license, replace: false });
    }
    return materials.put(params.repo, params.lib, body.name || "", { url: body.url }, { source: body.source || body.url, license: body.license, replace: false });
  });
  router.post(`${base}/libraries/:lib/move`, async ({ params, req }) => {
    const body = await readJson(req);
    return materials.move(params.repo, params.lib, body.from, body.to, { toLibrary: body.library });
  });
  router.delete(`${base}/libraries/:lib/file`, ({ params, query }) => materials.delete(params.repo, params.lib, String(query.path || "")));
  /** A file as it is now (browsing a library outside a work). */
  router.get(`${base}/file`, async ({ params, query, req, res }) => sendFile(req, res, await materials.file(params.repo, {}, String(query.path || ""))));
  // Versions: every change is one already; history and sync like a work's.
  router.get(`${base}/status`, async ({ params }) => works.status(await scope(params)));
  router.get(`${base}/history`, async ({ params, query }) => works.history(await scope(params), { limit: Number(query.limit || 50), skip: Number(query.skip || 0) }));
  router.get(`${base}/changes`, async ({ params, query }) => works.changes(await scope(params), query.commit));
  router.get(`${base}/diff`, async ({ params, query }) => ({ diff: await works.diff(await scope(params), { commit: query.commit, file: query.file }) }));
  router.post(`${base}/revert`, async ({ params, req }) => {
    // Restoring an earlier version is itself a new version; works keep the versions they locked.
    const result = { commit: await works.revert(await scope(params), (await readJson(req)).commit) };
    services.events.emit({ type: "materials", repo: params.repo, paths: [] });
    return result;
  });
  // Every change is saved at once, so there is nothing to save or discard; kept for the shared versions panel.
  router.post(`${base}/commit`, () => ({ commit: null }));
  router.post(`${base}/discard`, () => null);
  router.post(`${base}/sync`, async ({ params }) => works.sync(await scope(params)));
  router.post(`${base}/push`, async ({ params }) => works.push(await scope(params)));
  router.post(`${base}/pull`, async ({ params }) => {
    const result = await works.pull(await scope(params));
    services.events.emit({ type: "materials", repo: params.repo, paths: [] });
    return result;
  });
  router.post(`${base}/resolve`, async ({ params, req }) => {
    const result = await works.resolve(await scope(params), (await readJson(req)).strategy);
    services.events.emit({ type: "materials", repo: params.repo, paths: [] });
    return result;
  });

  // The materials a work uses.
  router.get("/api/works/:repo/:id/materials", async ({ params }) => materials.status(await services.openWork(params.id, params.repo)));
  router.post("/api/works/:repo/:id/materials/lock", async ({ params, req }) => {
    const work = await services.openEditable(params.id, params.repo);
    const body = await readJson(req);
    const refs = body.refs ?? Object.keys(materials.readLocks(work.dir));
    return materials.lock(work, refs, { update: Boolean(body.update) });
  });

  // ---- AI tools ---------------------------------------------------------------------
  const refArg = z.string().regex(/^[^/]+\/.+/).describe("<素材库>/<文件路径>，例如 通用素材/logo.svg（写成 materials/通用素材/logo.svg 也可以）");
  // Listings, layers and audio write materials/<库>/<文件>: the same file, so take it as written.
  const bareRef = (ref) => (/^materials\/[^/]+\/./.test(ref) ? ref.slice("materials/".length) : ref);
  const libraryArg = z.string().min(1).max(60).describe("素材库名称");

  const KIND_LABELS = { image: "图片", video: "视频", audio: "音频", font: "字体", model: "三维模型", environment: "全景图", lottie: "Lottie", code: "代码", data: "数据", file: "文件" };
  const sizeText = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
  const fileLine = (file, lock) =>
    `- materials/${file.ref} · ${[
      KIND_LABELS[file.kind] ?? file.kind,
      file.width ? `${file.width}×${file.height}` : "",
      file.duration ? `${+file.duration.toFixed(2)} 秒` : "",
      file.animations?.length ? `动画 ${file.animations.map((item) => item.name).join("、")}` : "",
      sizeText(file.size),
      lock?.locked ? (lock.outdated ? "本作品锁定的是旧版本（有更新）" : "本作品已锁定") : "",
      file.problem ? `注意：${file.problem}` : "",
    ]
      .filter(Boolean)
      .join(" · ")}`;

  tools.add({
    name: "materials_list",
    title: "素材库",
    description:
      "不传 library：列出或查找作品库里的素材库——名称、介绍、文件数、几个作品在用、本作品是否已引用、为什么适合本作品；本作品引用的在前，其余按适合本作品的程度和使用次数排列。query 按名称、介绍和其中资源的名称、标签查找（素材库很多时用它；要找具体的角色、效果、音效、文件用 resources_search）。传 library：列出其中的文件——地址 materials/<库>/<文件>、类型、尺寸、时长、大小，以及本作品锁定的版本是否落后；文件多时 query 按路径和类型筛选。结果多时 offset 翻页。作品只能用它引用的素材库（materials_use 会自动引用）。还没有作品时用 repo 只看某个作品库的素材库。",
    readOnly: true,
    input: {
      work: workArg,
      repo: repoArg,
      library: libraryArg.optional(),
      query: z.string().max(200).optional().describe("不传 library 时按名称、介绍和资源找素材库；传了 library 时按路径和类型筛选文件"),
      limit: z.number().int().min(1).max(200).default(30),
      offset: z.number().int().min(0).default(0),
    },
    async run({ library, query, limit, offset }, ctx) {
      const work = await ctx.place();
      const status = work.dir ? await materials.status(work) : { libraries: [], missing: [], files: [], unresolved: [] };
      // With the words of what they hold: a query finds a library by its resources too.
      const all = library ? await materials.libraries(work.repo) : await (services.resources?.librariesWithWords(work.repo) ?? materials.libraries(work.repo));
      const more = (rest, next, how) => (rest > 0 ? `\n还有 ${rest} 个：offset: ${next} 看下一页${how}。` : "");
      if (!library) {
        const annotated = services.libraries ? await services.libraries.annotate("materials", work.repo, all, work.dir ? work : null) : all;
        const order = work.dir ? materials.names(work) : [];
        const linked = annotated.filter((item) => item.linked).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
        const ordered = query?.trim() ? searchLibraries(annotated, query) : [...linked, ...offerOrder(annotated.filter((item) => !item.linked))];
        const page = ordered.slice(offset, offset + limit);
        const line = (item) => {
          const facts = [`文件 ${item.files} 个，${sizeText(item.size)}`, item.works ? `${item.works} 个作品在用` : "没有作品在用", item.linked ? "本作品已引用" : "", ...(item.linked ? [] : (item.why ?? []))].filter(Boolean).join("；");
          return `- 「${item.id}」${item.title !== item.id ? `（${item.title}）` : ""}${item.about ? `：${item.about}` : ""}（${facts}）`;
        };
        const outdated = status.files.filter((item) => item.outdated && item.used);
        const lines = [
          `作品库 ${work.repo} 有 ${all.length} 个素材库${work.dir ? `，本作品引用了 ${linked.length} 个${linked.length ? `：${linked.map((item) => `「${item.id}」`).join("")}` : ""}` : ""}。`,
          query?.trim()
            ? ordered.length
              ? `与「${query.trim()}」相关的 ${ordered.length} 个${ordered.length > page.length ? `（第 ${offset + 1}–${offset + page.length} 个）` : ""}：\n${page.map(line).join("\n")}`
              : `没有找到名称或介绍与「${query.trim()}」相关的素材库。按内容找（角色、效果、音效、图片、模型等）用 resources_search。`
            : all.length
              ? `${offset ? `第 ${offset + 1}–${offset + page.length} 个` : work.dir ? "本作品引用的在前，其余按适合本作品的程度和使用次数" : "按使用次数"}：\n${page.map(line).join("\n")}`
              : "还没有素材库：新建用 materials_link 的 create。",
          more(ordered.length - offset - page.length, offset + page.length, query?.trim() ? "" : "，或用 query 按名称和介绍查找").trim(),
          status.missing.length ? `本作品引用的素材库${status.missing.map((name) => `「${name}」`).join("")}已不存在。` : "",
          status.files.length ? `本作品用到素材库文件 ${status.files.filter((item) => item.used).length} 个${outdated.length ? `，其中 ${outdated.length} 个在素材库里有新版本（materials_use 加 update: true 更新）` : ""}。` : "",
          page.length ? "用 library 列出一个素材库的文件；resources_search 找其中声明的角色、效果、音效等资源。" : "",
        ];
        return {
          data: { total: all.length, matched: ordered.length, libraries: page.map(({ extra: _extra, ...item }) => item), missing: status.missing, used: status.files },
          text: lines.filter(Boolean).join("\n"),
        };
      }
      const found = findLibrary(library, all);
      if (!found) throw problem(404, unknownLibraries("materials", [library], all).replace(/新建用 create$/, "新建用 materials_link 的 create"), "NOT_FOUND");
      const locks = new Map(status.files.map((item) => [item.ref, item]));
      const files = await materials.files(work.repo, found.id);
      const words = searchWords(query);
      const matched = words.length ? files.filter((file) => words.every((word) => `${file.path} ${KIND_LABELS[file.kind] ?? ""} ${file.kind}`.toLowerCase().includes(word))) : files;
      const page = matched.slice(offset, offset + limit);
      // What the rest is, by top folder: enough to page or filter towards it.
      const rest = matched.slice(offset + page.length);
      const folders = new Map();
      for (const file of rest) {
        const folder = file.path.includes("/") ? file.path.split("/")[0] + "/" : "（根目录）";
        folders.set(folder, (folders.get(folder) ?? 0) + 1);
      }
      const head = `素材库「${found.id}」${found.title !== found.id ? `（${found.title}）` : ""}${found.about ? `：${found.about}` : ""}\n文件 ${files.length} 个${words.length ? `，符合「${query.trim()}」的 ${matched.length} 个` : ""}${matched.length > page.length ? `（第 ${offset + 1}–${offset + page.length} 个）` : ""}：`;
      const restText = rest.length
        ? `\n还有 ${rest.length} 个：${[...folders].map(([folder, count]) => `${folder}（${count}）`).join("、")}。offset: ${offset + page.length} 看下一页，或用 query 筛选（例如文件夹名、扩展名、"字体"）。`
        : "";
      const linkedNote = work.dir && !status.libraries.some((item) => item.id === found.id) ? "\n本作品还没有引用这个素材库：materials_use 使用其中的文件时会自动引用。" : "";
      return {
        data: { library: found.id, total: files.length, matched: matched.length, files: page.map((file) => ({ ...file, locked: locks.get(file.ref)?.locked ? (locks.get(file.ref).outdated ? "outdated" : "locked") : null })) },
        text: `${head}\n${page.map((file) => fileLine(file, locks.get(file.ref))).join("\n") || (words.length ? "（没有符合的文件）" : "（还没有文件）")}${restText}${linkedNote}`,
      };
    },
  });

  tools.add({
    name: "materials_link",
    published: true, // creating libraries is fine on a published work; changing its links is checked below
    title: "关联素材库",
    description:
      "增加或移除本作品关联（引用）的素材库（project.ts 的 materials，可以多个）。add 关联已有的素材库，create 新建空素材库并关联（同名的已存在时直接关联），remove 取消关联（素材库本身不受影响，已经锁定、正在使用的文件照常可用）。名称写文件夹名或标题（大小写、空格、标点不同也能认出）；不存在时返回最接近的几个，素材库很多时先用 materials_list 的 query 查找。用户要求时使用；不确定时先问用户。不针对作品、只新建素材库时用 repo 指定作品库（只能 create）。",
    input: {
      work: workArg,
      repo: repoArg,
      add: z.array(libraryArg).max(20).default([]),
      remove: z.array(libraryArg).max(20).default([]),
      create: z.array(libraryArg).max(5).default([]),
    },
    async run({ add, remove, create }, ctx) {
      const work = await ctx.place();
      if (!work.dir) {
        if (add.length || remove.length) throw problem(400, "add / remove 改变的是作品关联的素材库：需要 work；只指定 repo 时只能 create");
        const existing = await materials.libraries(work.repo);
        const created = [];
        for (const name of create) if (!findLibrary(name, existing)) created.push((await materials.create(work.repo, name)).id);
        return asJson({ created }, created.length ? `已在作品库 ${work.repo} 新建素材库：${created.map((id) => `「${id}」`).join("")}。用 material_write（repo: "${work.repo}"）往里放文件。README.md 已有模板：把第一段改成一句介绍（work_context 和资源目录里显示），后面写资源清单和用法` : "没有新建素材库（同名的已存在）");
      }
      const published = Boolean(works.published(work));
      if (published && (add.length || remove.length))
        throw problem(423, "作品已发布，不能改变它关联的素材库。素材库本身可以照常整理（material_write），也可以用 create 新建。要改关联，请用户先取消发布或创建副本。", "PUBLISHED");
      const all = await materials.libraries(work.repo);
      // A folder name or title, also written a little differently (case, spaces, a "素材库" ending).
      const find = (name) => findLibrary(name, all)?.id ?? null;
      const unknown = add.filter((name) => !find(name));
      if (unknown.length)
        throw problem(400, `${unknownLibraries("materials", unknown, all, await materials.trash(work.repo))}。素材库属于作品库（这里是 ${work.repo}），别的作品库里的素材库要在那个作品库里新建作品才能用`);
      const adding = add.map(find);
      const created = [];
      for (const name of create) {
        const id = find(name) ?? (await materials.create(work.repo, name)).id;
        if (!all.some((item) => item.id === id)) created.push(id);
        adding.push(id);
      }
      if (published)
        return asJson(
          { created, materials: materials.names(work) },
          `${created.length ? `已新建素材库：${created.map((id) => `「${id}」`).join("")}` : "没有新建素材库（同名的已存在）"}。作品已发布，没有关联到它；用 material_write 往里放文件。`,
        );
      const dropping = new Set(remove.map((name) => find(name) ?? name.trim()));
      const before = materials.names(work);
      await works.update(work, { materials: [...new Set([...before.filter((name) => !dropping.has(name)), ...adding])] });
      const after = materials.names(work);
      const added = after.filter((name) => !before.includes(name));
      const removed = before.filter((name) => !after.includes(name));
      return asJson(
        { materials: after, added, removed },
        [
          `本作品关联的素材库：${after.map((name) => `「${name}」`).join("") || "（无）"}`,
          added.length ? `新关联：${added.join("、")}（用 materials_list 查看文件，materials_use 使用）` : "",
          removed.length ? `已取消关联：${removed.join("、")}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    },
  });

  tools.add({
    name: "materials_use",
    title: "使用素材",
    description:
      "在作品中使用素材库里的文件前调用：锁定这些文件当前的版本（之后素材库里的改动不会影响作品），作品还没关联的素材库会自动关联。返回用法：素材用地址 materials/<库>/<文件>（图层、音轨里直接写，代码里写 assetUrl(地址)）；素材库里的代码用 import … from \"@materials/<库>/<路径>\"（扩展名可省略），它导入的其他文件和用到的素材一并锁定。update: true 把已锁定的文件更新到最新版本。保存版本时只保留作品用到的文件的锁定。",
    input: { work: workArg, files: z.array(refArg).min(1).max(100), update: z.boolean().default(false) },
    async run({ files: given, update }, ctx) {
      const work = await ctx.work();
      const files = given.map(bareRef);
      const { libraries } = await materials.linked(work);
      const linked = new Set(libraries.map((item) => item.id));
      // Using a library's files means using the library: link it here instead of a separate call.
      const all = await materials.libraries(work.repo);
      const existing = new Set(all.map((item) => item.id));
      const needed = [...new Set(files.map((ref) => ref.split("/")[0]))].filter((id) => !linked.has(id));
      const unknown = needed.filter((id) => !existing.has(id));
      if (unknown.length)
        throw problem(404, `作品库 ${work.repo} 里没有素材库：${unknown.join("、")}${(() => {
          const close = [...new Set(unknown.flatMap((name) => closestLibraries(name, all).map((item) => item.id)))].slice(0, 5);
          return close.length ? `。最接近的：${close.map((id) => `「${id}」`).join("")}（地址写 <素材库文件夹名>/<路径>）` : "";
        })()}（素材库属于作品库，用 materials_list 的 query 查找这个作品库的素材库）`);
      if (needed.length) await works.update(work, { materials: [...materials.names(work), ...needed] });
      const result = await materials.lock(work, files, { update });
      if (result.missing.length) throw problem(404, `素材不存在：${result.missing.join("、")}`);
      const usage = files.map((ref) =>
        SCRIPT.test(ref) || !/\.[^/]+$/.test(ref) ? { ref, import: `@materials/${ref.replace(/\.(m?[jt]sx?)$/, "")}` } : { ref, url: `materials/${ref}` },
      );
      return asJson(
        { files: usage, locked: result.locked, linked: needed },
        `${needed.length ? `已为作品关联素材库：${needed.join("、")}。` : ""}可以使用：${usage.map((item) => (item.import ? `import … from "${item.import}"` : item.url)).join("、")}${result.locked.length ? `（已锁定 ${result.locked.length} 个文件的当前版本：${result.locked.join("、")}）` : ""}`,
      );
    },
  });

  /** A library file as text (current version, or the version this work locked). */
  const readMaterial = async (work, wanted, locked) => {
    if (!validRef(wanted)) throw problem(400, "无效的路径");
    const versions = locked ? materials.readLocks(work.dir) : {};
    let ref = wanted;
    if (!versions[ref]) {
      // The library written a little differently (case, spaces, punctuation) is the same one;
      // a name that leads nowhere gets the close ones (the folder names).
      const [name, ...rest] = ref.split("/");
      const found = findLibrary(name, await materials.libraries(work.repo));
      if (found) ref = [found.id, ...rest].join("/");
      else materials.libraryOf(await materials.dir(work.repo), name);
    }
    if (locked && !versions[ref]) throw problem(404, `本作品没有锁定 materials/${ref}`);
    if (!TEXT.test(ref)) {
      const info = await probe(await materials.file(work.repo, versions, ref)).catch(() => null);
      if (!info) throw notFound(`素材不存在：materials/${ref}`);
      return { ref, info, text: null };
    }
    if (versions[ref]) return { ref, text: await materials.text(work.repo, versions[ref]) };
    const file = confined(await materials.dir(work.repo), ref);
    if (!fs.existsSync(file)) throw notFound(`素材不存在：materials/${ref}`);
    if (fs.statSync(file).size > TEXT_LIMIT) throw problem(413, "文件太大，不能作为文本读取");
    return { ref, text: fs.readFileSync(file, "utf8") };
  };
  tools.add({
    name: "material_read",
    readOnly: true,
    title: "阅读素材库文件",
    description:
      "读取素材库里的文本文件（代码、JSON、SVG、Markdown 说明如 README.md、CSV、字幕和歌词等）。默认是素材库现在的版本；locked: true 读本作品锁定的版本（作品实际运行的那个）。一次读多个用 paths（\"<库>/<路径>\"）。媒体文件只返回信息。还没有作品时用 repo 指定作品库。",
    input: {
      work: workArg,
      repo: repoArg,
      library: libraryArg.optional(),
      path: z.string().min(1).max(300).optional(),
      paths: z.array(z.string().min(3).max(360)).max(30).optional().describe('一次读多个："<素材库>/<路径>"（或 materials/<素材库>/<路径>）'),
      locked: z.boolean().default(false),
    },
    async run({ library, path: relative, paths, locked }, ctx) {
      const work = await ctx.place();
      if (locked && !work.dir) throw problem(400, "locked 读的是某个作品锁定的版本：需要 work");
      if (paths?.length && (library || relative)) throw problem(400, "library + path 读一个文件，paths 读多个：二选一（paths 每项写 <素材库>/<路径>）");
      if (!paths?.length) {
        if (!library || !relative) throw problem(400, "需要 library 和 path，或者 paths");
        const read = await readMaterial(work, `${library}/${relative}`, locked);
        if (read.text === null) return asJson({ ref: read.ref, ...read.info }, `materials/${read.ref} 是媒体文件，不能作为文本读取`);
        return { data: { ref: read.ref, version: locked ? "locked" : "current", sha256: sha256(read.text) }, text: read.text };
      }
      paths = paths.map(bareRef);
      const results = await eachSettled(paths, (ref) => readMaterial(work, ref, locked));
      return {
        data: results.map((result, index) =>
          result.ok
            ? { ref: paths[index], ok: true, ...(result.value.text === null ? { media: result.value.info } : { sha256: sha256(result.value.text) }) }
            : { ref: paths[index], ok: false, error: errorOf(result.error) },
        ),
        text: results
          .map((result, index) =>
            !result.ok
              ? `=== materials/${paths[index]}：${result.error.message}`
              : result.value.text === null
                ? `=== materials/${paths[index]}（媒体文件，${result.value.info.kind}）`
                : `=== materials/${paths[index]}\n${result.value.text}`,
          )
          .join("\n\n"),
      };
    },
  });

  const pathArg = z.string().min(1).max(300);
  const inLibrary = z.string().min(1).max(60).optional();
  const materialOperation = z.discriminatedUnion("op", [
    z.strictObject({
      op: z.literal("put"),
      library: inLibrary,
      path: pathArg,
      url: z.string().url().optional(),
      work_file: z.string().optional(),
      content: z.string().max(4 * 1024 * 1024).optional(),
      data: z.string().max(12 * 1024 * 1024).optional(),
      source: z.string().max(300).optional(),
      license: z.string().max(300).optional(),
    }),
    z.strictObject({ op: z.literal("edit"), library: inLibrary, path: pathArg, edits: editList }),
    z.strictObject({ op: z.literal("move"), library: inLibrary, from: pathArg, to: pathArg, to_library: libraryArg.optional() }),
    z.strictObject({ op: z.literal("delete"), library: inLibrary, path: pathArg }),
  ]);
  tools.add({
    name: "material_write",
    published: true, // the libraries are not the work: allowed on a published one
    title: "修改素材库",
    description:
      "修改素材库，一次可以做多个操作，按顺序执行，每个操作保存为素材库的一个版本。每个操作的 library 不写则用外层的 library，path 是素材库内的路径（例如 logos/brand.svg）。put 放入文件（从网址 url、本作品的文件 work_file（相对 projects/<名称>/）、文本 content 如 SVG/JSON/代码、或 base64 data（≤8 MB，没有终端时用），四选一；同名文件替换为新版本）、edit 精确替换文本文件（每个 oldText 必须逐字一致且恰好出现一次，否则设 replaceAll）、move 移动或改名（to_library 移到另一个素材库）、delete 删除。素材库根目录的 README.md 是它的说明：第一个「# 」标题是素材库显示的名称，标题后的第一段是介绍（work_context 和资源目录里显示），用 put 的 content 或 edit 修改；它的「来源与许可」记录各文件的来源，随文件的移动、删除自动更新，不能删除或移动 README.md。锁定了旧版本的作品不受影响，要用新版本时 materials_use update: true。你所在电脑上的文件用 upload_link 上传。第三方素材在 source / license 中写清来源与许可。失败的逐项说明原因，只需重试失败的。新建素材库用 materials_link 的 create。不针对作品整理素材库时用 repo 指定作品库。",
    destructive: true,
    input: {
      work: workArg,
      repo: repoArg,
      library: libraryArg.optional().describe("各操作默认的素材库"),
      operations: z.array(materialOperation).min(1).max(30),
    },
    async run({ library: fallback, operations }, ctx) {
      const work = await ctx.place();
      const one = async (item) => {
        const library = item.library ?? fallback;
        if (!library) throw problem(400, "需要 library（写在操作里或外层）");
        if (item.op === "put") {
          const { url, work_file, content, data, source, license } = item;
          if ([url, work_file, content, data].filter((value) => value !== undefined).length !== 1) throw problem(400, "url、work_file、content、data 必须且只能提供一个");
          if (work_file && !work.dir) throw problem(400, "work_file 是作品里的文件：需要 work");
          const from = url
            ? { url }
            : work_file
              ? { file: confined(work.dir, work_file) }
              : data !== undefined
                ? { stream: Readable.from([decodeData(data, item.path)]) }
                : { content };
          const saved = await materials.put(work.repo, library, item.path, from, { source: source || url, license });
          const info = await probe(await materials.file(work.repo, {}, saved.ref)).catch(() => ({}));
          const kept = saved.kept ? `（新内容里没有的 ${saved.kept} 条素材来源记录已保留在「来源与许可」）` : "";
          return { ...saved, ...info, line: `materials/${saved.ref}${kept}` };
        }
        if (item.op === "edit") {
          const ref = `${library}/${item.path}`;
          if (!validRef(ref) || !TEXT.test(ref)) throw problem(400, "只能修改素材库里的文本文件（代码、JSON、SVG、Markdown、CSV、字幕等）");
          const file = confined(await materials.dir(work.repo), ref);
          if (!fs.existsSync(file)) throw notFound(`素材不存在：materials/${ref}`);
          const content = applyEdits(fs.readFileSync(file, "utf8"), item.edits, "material_read");
          const saved = await materials.put(work.repo, library, item.path, { content }, { replace: true });
          return { ...saved, sha256: sha256(content), line: `materials/${saved.ref}（${item.edits.length} 处）` };
        }
        if (item.op === "move") {
          const moved = await materials.move(work.repo, library, item.from, item.to, { toLibrary: item.to_library });
          return { ...moved, line: `materials/${library}/${item.from} → materials/${moved.ref}${moved.notes ? `（README 的来源记录跟着改了 ${moved.notes} 条）` : ""}` };
        }
        const notes = await materials.delete(work.repo, library, item.path);
        return { deleted: `${library}/${item.path}`, line: `已删除 materials/${library}/${item.path}${notes ? `（README 里它的来源记录也删了 ${notes} 条）` : ""}` };
      };
      // One after another: later operations may depend on earlier ones.
      const results = await eachSettled(operations, one, 1);
      return {
        data: results.map((result, index) =>
          result.ok ? { ok: true, op: operations[index].op, ...Object.fromEntries(Object.entries(result.value).filter(([key]) => key !== "line")) } : { ok: false, item: index, error: errorOf(result.error) },
        ),
        text: summarize(results, (result, index) =>
          result.ok
            ? `✓ ${index + 1}. ${operations[index].op} ${result.value.line}`
            : `✗ ${index + 1}. ${operations[index].op} ${operations[index].library ?? fallback ?? ""}/${operations[index].path ?? operations[index].from}：${result.error.message}`,
        ),
      };
    },
  });
}
