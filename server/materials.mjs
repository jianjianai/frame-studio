import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { git, gitOk, gitToFile } from "./git.mjs";
import { tree, writeText, writeStream, removePath, movePath, uniquePath, TEXT_LIMIT } from "./files.mjs";
import { readJson, sendFile } from "./http.mjs";
import { problem, notFound, conflict, confined, inside, sha256, Locks, writeFileAtomic } from "./util.mjs";
import { MATERIALS_BRANCH } from "./repos.mjs";
import { workArg, asJson } from "./tools/registry.mjs";
import { importFromUrl } from "./tools/asset-tools.mjs";
import { nearMiss } from "./tools/work-tools.mjs";
import { probe } from "./media.mjs";

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
  ["model", /\.(glb|gltf)$/i],
  ["code", /\.(m?[jt]sx?|cjs|glsl|frag|vert|wgsl|css)$/i],
  ["data", /\.(json|csv|txt|md)$/i],
];
const kindOf = (file) => KINDS.find(([, pattern]) => pattern.test(file))?.[0] ?? "file";

const libraryReadme = (title) => `# ${title}

素材库「${title}」。引用了它的作品可以直接使用其中的文件：\`materials/${folderOf(title)}/<文件>\`。

## 来源与许可

`;

export class Materials {
  constructor(services) {
    this.services = services;
    this.locks = new Locks();
    this.heads = new Map(); // repo → Promise<Map path → blob>, dropped when the branch changes
    this.blobs = new Map(); // blob → text of library code (blobs never change)
    this.manifests = new Map(); // root → { ref: blob } of its .materials copies
    this.excluded = new Set(); // repositories whose worktrees ignore .materials
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
  async libraries(repo) {
    const dir = await this.dir(repo);
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => {
        const files = tree(path.join(dir, entry.name)).filter((item) => item.type === "file" && item.path !== "README.md");
        return { id: entry.name, title: this.title(dir, entry.name), files: files.length, size: files.reduce((sum, item) => sum + (item.size || 0), 0) };
      })
      .sort((a, b) => a.title.localeCompare(b.title, "zh"));
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
  async remove(repo, id) {
    const dir = await this.dir(repo);
    if (!validId(id) || !fs.existsSync(path.join(dir, id))) throw notFound("素材库不存在");
    // Works keep the versions they locked: they stay in the branch's history.
    await this.save(repo, [id], `删除素材库：${this.title(dir, id)}`, () => removePath(dir, id));
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
    for (const item of tree(path.join(dir, id)).filter((entry) => entry.type === "file" && entry.path !== "README.md")) {
      const kind = kindOf(item.path);
      // Size and length for the thumbnails (cached until the file changes); a .webm may hold only sound.
      const info = ["image", "video", "audio"].includes(kind) ? await probe(path.join(dir, id, item.path)).catch(() => ({})) : {};
      result.push({
        path: item.path,
        ref: `${id}/${item.path}`,
        url: `materials/${id}/${item.path}`,
        kind: info.kind === "audio" && kind === "video" ? "audio" : kind,
        size: item.size,
        blob: blobs.get(`${id}/${item.path}`) ?? null,
        ...(info.width ? { width: info.width, height: info.height } : {}),
        ...(info.duration ? { duration: info.duration } : {}),
      });
    }
    return result;
  }
  libraryOf(dir, id) {
    if (!validId(id) || !fs.existsSync(path.join(dir, id))) throw notFound(`素材库「${id}」不存在`);
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
  /** Add or replace a file: from a stream (upload), a URL, a file on disk or text content. */
  async put(repo, id, relative, from, { source, license, replace = true } = {}) {
    const dir = await this.dir(repo);
    this.libraryOf(dir, id);
    if (!relative || relative === "README.md") throw problem(400, "无效的文件名");
    let target = `${id}/${relative}`;
    confined(dir, target);
    const existed = fs.existsSync(path.join(dir, target));
    if (existed && !replace) target = uniquePath(dir, target);
    const saved = await this.save(repo, [id], `素材库「${this.title(dir, id)}」：${existed && replace ? "更新" : "添加"} ${target.slice(id.length + 1)}`, async () => {
      if (from.url) {
        if (existed && replace) fs.rmSync(path.join(dir, target));
        target = await importFromUrl({ dir }, from.url, { name: path.basename(target), folder: path.dirname(target) });
      }
      else if (from.stream) await writeStream(dir, target, from.stream, { overwrite: true });
      else if (from.file) {
        fs.mkdirSync(path.dirname(path.join(dir, target)), { recursive: true });
        fs.copyFileSync(from.file, path.join(dir, target));
      } else writeText(dir, target, String(from.content ?? ""));
      this.credit(dir, id, target.slice(id.length + 1), { source, license });
      return target;
    });
    return { ref: saved, url: `materials/${saved}`, path: saved.slice(id.length + 1), kind: kindOf(saved) };
  }
  async move(repo, id, from, to, { toLibrary } = {}) {
    const dir = await this.dir(repo);
    this.libraryOf(dir, id);
    const target = toLibrary || id;
    this.libraryOf(dir, target);
    await this.save(repo, [id, target], `素材库：移动 ${id}/${from} → ${target}/${to}`, () => movePath(dir, `${id}/${from}`, `${target}/${to}`));
    return { ref: `${target}/${to}`, url: `materials/${target}/${to}` };
  }
  async delete(repo, id, relative) {
    const dir = await this.dir(repo);
    this.libraryOf(dir, id);
    if (relative === "README.md") throw problem(400, "README.md 记录素材的来源与许可，不能删除");
    await this.save(repo, [id], `素材库「${this.title(dir, id)}」：删除 ${relative}`, () => removePath(dir, `${id}/${relative}`));
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
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }
  writeLocks(work, locks) {
    const sorted = Object.fromEntries(Object.entries(locks).sort(([a], [b]) => a.localeCompare(b)));
    writeFileAtomic(path.join(work.dir, LOCK_FILE), JSON.stringify(sorted, null, 2) + "\n");
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
   * uses. `unresolved`: imports that lead to no library file.
   */
  async usage(work) {
    const refs = new Set();
    for (const file of this.sourceFiles(work))
      for (const match of fs.readFileSync(file, "utf8").matchAll(MATERIAL_REF)) if (!match[1].includes("${") && validRef(match[1])) refs.add(match[1]);
    const imports = this.imports(work);
    if (!imports.length) return { refs, unresolved: [] };
    const code = await this.follow(work.repo, this.readLocks(work.dir), imports);
    for (const ref of code.refs) refs.add(ref);
    return { refs, unresolved: code.unresolved };
  }
  async references(work) {
    return (await this.usage(work)).refs;
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
      const text = await this.text(repo, locks[ref] ?? head.get(ref)).catch(() => "");
      for (const match of text.matchAll(MATERIAL_REF)) if (!match[1].includes("${") && validRef(match[1])) refs.add(match[1]);
      for (const spec of importSpecs(text)) {
        if (spec.startsWith("@materials/")) visit(spec.slice(11), `materials/${ref}`);
        else if (/^\.\.?\//.test(spec)) {
          // Relative imports stay in the libraries; ../../src/engine/… leaves them (the engine).
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(ref), spec.split("?")[0]));
          if (!target.startsWith("../")) visit(target, `materials/${ref}`);
        }
      }
    }
    return { refs, unresolved };
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
    if (!this.blobs.has(blob)) {
      const text = await git(await this.dir(repo), ["cat-file", "blob", blob]);
      this.blobs.set(blob, text);
      if (this.blobs.size > 2000) this.blobs.delete(this.blobs.keys().next().value);
    }
    return this.blobs.get(blob);
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
    if (locked.length) {
      this.writeLocks(work, locks);
      await this.refreshCopies({ root: work.root, repo: work.repo, dir: work.dir });
      this.services.events.emit({ type: "work-materials", work: work.id, repo: work.repo });
      // Same addresses, other content: the preview reloads the media.
      this.services.preview?.assetsChanged?.(work, [path.join(work.dir, LOCK_FILE)]);
    }
    return { locked, missing };
  }
  /** Lock what the work uses and has not locked yet (after placing a material, before a version). */
  async lockReferenced(work) {
    if (this.services.works.published(work)) return { locked: [], missing: [] };
    const locks = this.readLocks(work.dir);
    return this.lock(
      work,
      [...(await this.references(work))].filter((ref) => !locks[ref]),
    );
  }

  // ---- .materials: the library code a work (or export snapshot) runs ---------------------

  /** The work or export snapshot a file belongs to: its root, repository and lock file folder. */
  rootOf(file) {
    const { works: worksDir, tmp } = this.services.config.dirs;
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
    if (!importer) return null;
    importer = importer.split("?")[0];
    const marker = `${path.sep}${MATERIALIZED}${path.sep}`;
    const bare = source.split("?")[0];
    const query = source.slice(bare.length);
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
  /** After the libraries changed: works running copies of their code follow (where not locked). */
  async refreshRepo(repo) {
    this.heads.delete(repo);
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
    const { refs: used, unresolved } = await this.usage(work);
    const files = [...new Set([...Object.keys(locks), ...used])].sort().map((ref) => ({
      ref,
      url: `materials/${ref}`,
      used: used.has(ref),
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
  // A version of a work (and its publication) records the material versions it uses.
  works.beforeSave.push((work) => materials.lockReferenced(work));
  // Library code: the preview resolves @materials/… to copies at the versions each work uses,
  // which follow the libraries (unlocked files) and the works' lock files (pull, revert, edits).
  services.preview?.importResolvers?.push((source, importer) => materials.resolveImport(source, importer));
  services.events.subscribe((event) => {
    if (event.type === "materials" && event.repo) void materials.refreshRepo(event.repo).catch(() => {});
    if (event.type === "work-files" && event.files?.some((file) => file.endsWith(LOCK_FILE))) {
      const place = materials.rootOf(path.join(services.config.dirs.works, event.repo, event.work, "projects"));
      if (place) void materials.refreshCopies(place).catch(() => {});
    }
  });
  const base = "/api/repos/:repo/materials";
  const scope = (params) => materials.scope(params.repo);

  router.get(`${base}/libraries`, ({ params }) => materials.libraries(params.repo));
  router.post(`${base}/libraries`, async ({ params, req }) => materials.create(params.repo, (await readJson(req)).name));
  router.delete(`${base}/libraries/:lib`, ({ params }) => materials.remove(params.repo, params.lib));
  router.get(`${base}/libraries/:lib/files`, ({ params }) => materials.files(params.repo, params.lib));
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
  const refArg = z.string().regex(/^[^/]+\/.+/).describe("<素材库>/<文件路径>，例如 通用素材/logo.svg");
  const libraryArg = z.string().min(1).max(60).describe("素材库名称");

  tools.add({
    name: "materials_list",
    title: "素材库",
    description:
      "列出作品库里的素材库，以及本作品引用了哪些（不传 library）；传 library 列出其中的文件：地址 materials/<库>/<文件>、类型、大小，和本作品锁定的版本是否落后。作品只能用它引用的素材库。",
    readOnly: true,
    input: { work: workArg, library: libraryArg.optional() },
    async run({ library }, ctx) {
      const work = await ctx.work();
      const status = await materials.status(work);
      if (!library) {
        const all = await materials.libraries(work.repo);
        const linked = new Set(status.libraries.map((item) => item.id));
        return asJson({
          libraries: all.map((item) => ({ ...item, referenced: linked.has(item.id) })),
          missing: status.missing,
          used: status.files,
        });
      }
      const locks = new Map(status.files.map((item) => [item.ref, item]));
      return asJson(
        (await materials.files(work.repo, library)).map((file) => ({
          ...file,
          locked: locks.get(file.ref)?.locked ? (locks.get(file.ref).outdated ? "旧版本（有更新）" : "已锁定") : null,
        })),
      );
    },
  });

  tools.add({
    name: "materials_link",
    published: true, // creating libraries is fine on a published work; changing its links is checked below
    title: "关联素材库",
    description:
      "增加或移除本作品关联（引用）的素材库（project.ts 的 materials，可以多个）。add 关联已有的素材库，create 新建空素材库并关联（同名的已存在时直接关联），remove 取消关联（素材库本身不受影响，已经锁定、正在使用的文件照常可用）。用户要求时使用；不确定时先问用户。",
    input: {
      work: workArg,
      add: z.array(libraryArg).max(20).default([]),
      remove: z.array(libraryArg).max(20).default([]),
      create: z.array(libraryArg).max(5).default([]),
    },
    async run({ add, remove, create }, ctx) {
      const work = await ctx.work();
      const published = Boolean(works.published(work));
      if (published && (add.length || remove.length))
        throw problem(423, "作品已发布，不能改变它关联的素材库。素材库本身可以照常整理（material_write / material_move / material_delete），也可以用 create 新建。要改关联，请用户先取消发布或创建副本。", "PUBLISHED");
      const all = await materials.libraries(work.repo);
      const find = (name) => all.find((item) => item.id === name.trim() || item.title === name.trim())?.id ?? null;
      const unknown = add.filter((name) => !find(name));
      if (unknown.length)
        throw problem(400, `素材库不存在：${unknown.join("、")}。现有的素材库：${all.map((item) => `「${item.id}」`).join("") || "（无）"}；新建用 create`);
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
      "在作品中使用素材库里的文件前调用：锁定这些文件当前的版本（之后素材库里的改动不会影响作品），返回用法：素材用地址 materials/<库>/<文件>（图层、音轨里直接写，代码里写 assetUrl(地址)）；素材库里的代码用 import … from \"@materials/<库>/<路径>\"（扩展名可省略），它导入的其他文件和用到的素材一并锁定。update: true 把已锁定的文件更新到最新版本。",
    input: { work: workArg, files: z.array(refArg).min(1).max(100), update: z.boolean().default(false) },
    async run({ files, update }, ctx) {
      const work = await ctx.work();
      const { libraries } = await materials.linked(work);
      const linked = new Set(libraries.map((item) => item.id));
      const outside = files.filter((ref) => !linked.has(ref.split("/")[0]));
      if (outside.length) throw problem(400, `作品没有引用这些素材库：${[...new Set(outside.map((ref) => ref.split("/")[0]))].join("、")}，先用 materials_link 引用`);
      const result = await materials.lock(work, files, { update });
      if (result.missing.length) throw problem(404, `素材不存在：${result.missing.join("、")}`);
      const usage = files.map((ref) =>
        SCRIPT.test(ref) || !/\.[^/]+$/.test(ref) ? { ref, import: `@materials/${ref.replace(/\.(m?[jt]sx?)$/, "")}` } : { ref, url: `materials/${ref}` },
      );
      return asJson(
        { files: usage, locked: result.locked },
        `可以使用：${usage.map((item) => (item.import ? `import … from "${item.import}"` : item.url)).join("、")}${result.locked.length ? `（已锁定 ${result.locked.length} 个文件的当前版本：${result.locked.join("、")}）` : ""}`,
      );
    },
  });

  tools.add({
    name: "material_write",
    published: true, // the libraries are not the work: allowed on a published one
    title: "写入素材库",
    description:
      "把文件放进素材库（每次修改都会保存为素材库的一个版本）：从网址下载（url）、从本作品的文件复制（work_file，例如 public/logo.png）或写入文本内容（content，例如 SVG、JSON）。同名文件会被替换为新版本；已锁定旧版本的作品不受影响。第三方素材在 source / license 中写清来源与许可。",
    destructive: true,
    input: {
      work: workArg,
      library: libraryArg,
      path: z.string().min(1).max(300).describe("素材库内的路径，例如 logos/brand.svg"),
      url: z.string().url().optional(),
      work_file: z.string().optional().describe("本作品中的文件，相对 projects/<名称>/"),
      content: z.string().max(4 * 1024 * 1024).optional(),
      source: z.string().max(300).optional(),
      license: z.string().max(300).optional(),
    },
    async run({ library, path: relative, url, work_file, content, source, license }, ctx) {
      const work = await ctx.work();
      if ([url, work_file, content].filter((value) => value !== undefined).length !== 1) throw problem(400, "url、work_file、content 必须且只能提供一个");
      const from = url ? { url } : work_file ? { file: confined(work.dir, work_file) } : { content };
      const saved = await materials.put(work.repo, library, relative, from, { source: source || url, license });
      const info = await probe(await materials.file(work.repo, {}, saved.ref)).catch(() => ({}));
      return asJson({ ...saved, ...info }, `已保存到素材库：materials/${saved.ref}`);
    },
  });

  tools.add({
    name: "material_read",
    readOnly: true,
    title: "阅读素材库文件",
    description:
      "读取素材库里的文本文件（代码、JSON、SVG、说明等）。默认是素材库现在的版本；locked: true 读本作品锁定的版本（作品实际运行的那个）。媒体文件只返回信息。",
    input: { work: workArg, library: libraryArg, path: z.string().min(1).max(300), locked: z.boolean().default(false) },
    async run({ library, path: relative, locked }, ctx) {
      const work = await ctx.work();
      const ref = `${library}/${relative}`;
      if (!validRef(ref)) throw problem(400, "无效的路径");
      const versions = locked ? materials.readLocks(work.dir) : {};
      if (locked && !versions[ref]) throw problem(404, `本作品没有锁定 materials/${ref}`);
      if (!IMPORTABLE.test(ref)) {
        const info = await probe(await materials.file(work.repo, versions, ref)).catch(() => null);
        if (!info) throw notFound(`素材不存在：materials/${ref}`);
        return asJson({ ref, ...info }, `materials/${ref} 是媒体文件，不能作为文本读取`);
      }
      let text;
      if (versions[ref]) text = await materials.text(work.repo, versions[ref]);
      else {
        const file = confined(await materials.dir(work.repo), ref);
        if (!fs.existsSync(file)) throw notFound(`素材不存在：materials/${ref}`);
        if (fs.statSync(file).size > TEXT_LIMIT) throw problem(413, "文件太大，不能作为文本读取");
        text = fs.readFileSync(file, "utf8");
      }
      return { data: { ref, version: locked ? "locked" : "current", sha256: sha256(text) }, text };
    },
  });

  tools.add({
    name: "material_edit",
    published: true, // the libraries are not the work: allowed on a published one
    title: "修改素材库文件",
    description:
      "在素材库的文本文件（代码、JSON、SVG 等）中做精确替换，保存为素材库的一个新版本（按顺序执行，全部成功才写入）。每个 oldText 必须与文件内容逐字一致且恰好出现一次，否则设置 replaceAll。锁定了旧版本的作品不受影响，要用新版本时 materials_use update: true。",
    destructive: true,
    input: {
      work: workArg,
      library: libraryArg,
      path: z.string().min(1).max(300),
      edits: z
        .array(z.strictObject({ oldText: z.string().min(1), newText: z.string(), replaceAll: z.boolean().default(false) }))
        .min(1)
        .max(50),
    },
    async run({ library, path: relative, edits }, ctx) {
      const work = await ctx.work();
      const ref = `${library}/${relative}`;
      if (!validRef(ref) || !IMPORTABLE.test(ref)) throw problem(400, "只能修改素材库里的文本文件（代码、JSON、SVG 等）");
      const file = confined(await materials.dir(work.repo), ref);
      if (!fs.existsSync(file)) throw notFound(`素材不存在：materials/${ref}`);
      let content = fs.readFileSync(file, "utf8");
      for (const [index, edit] of edits.entries()) {
        const count = content.split(edit.oldText).length - 1;
        if (count === 0) throw problem(400, `第 ${index + 1} 处替换：找不到 oldText。${nearMiss(content, edit.oldText, "material_read")}`);
        if (count > 1 && !edit.replaceAll) throw problem(400, `第 ${index + 1} 处替换：oldText 出现了 ${count} 次，请提供更多上下文或设置 replaceAll`);
        content = edit.replaceAll ? content.split(edit.oldText).join(edit.newText) : content.replace(edit.oldText, () => edit.newText);
      }
      const saved = await materials.put(work.repo, library, relative, { content }, { replace: true });
      return asJson({ ...saved, sha256: sha256(content) }, `已修改素材库文件 materials/${saved.ref}（${edits.length} 处），保存为新版本`);
    },
  });

  tools.add({
    name: "material_move",
    published: true,
    title: "移动素材",
    description: "在素材库内（或到另一个素材库）移动、重命名文件。已锁定这个文件的作品仍使用锁定的版本；在用新地址前更新它们的引用。",
    destructive: true,
    input: { work: workArg, library: libraryArg, from: z.string().min(1), to: z.string().min(1), to_library: libraryArg.optional() },
    async run({ library, from, to, to_library }, ctx) {
      const work = await ctx.work();
      const moved = await materials.move(work.repo, library, from, to, { toLibrary: to_library });
      return asJson(moved, `已移动到 materials/${moved.ref}`);
    },
  });

  tools.add({
    name: "material_delete",
    published: true,
    title: "删除素材",
    description: "从素材库删除一个文件（保存为一个版本，可以从历史恢复）。已锁定它的作品仍能使用锁定的版本。",
    destructive: true,
    input: { work: workArg, library: libraryArg, path: z.string().min(1) },
    async run({ library, path: relative }, ctx) {
      const work = await ctx.work();
      await materials.delete(work.repo, library, relative);
      return asJson({ deleted: `${library}/${relative}` }, `已从素材库「${library}」删除 ${relative}`);
    },
  });
}
