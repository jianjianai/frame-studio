import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Zip, ZipPassThrough } from "fflate";
import { confined, problem, writeFileAtomic, mediaKind, sha256, inside } from "./util.mjs";

const HIDDEN = new Set([".git", ".gitattributes", "node_modules", ".cache", "exports", ".DS_Store"]);
const versions = new Map(); // file -> { size, mtimeMs, ino, version }

/**
 * Content version of a file (sha256 prefix), remembered until its size, mtime or
 * inode change. Equal content gives equal versions, also across works, so the
 * browser precache never downloads the same bytes twice.
 */
export async function contentVersion(file, stat = fs.statSync(file)) {
  const known = versions.get(file);
  if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs && known.ino === stat.ino) return known.version;
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const version = hash.digest("hex").slice(0, 32);
  versions.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, version });
  return version;
}

export const TEXT_LIMIT = 2 * 1024 * 1024;
const textExtensions = /\.(ts|tsx|js|mjs|cjs|jsx|json|md|txt|css|html|svg|glsl|frag|vert|srt|vtt|csv|yaml|yml|toml)$/i;
export const isText = (file) => textExtensions.test(file);

const scenes = new Map(); // file -> { size, mtimeMs, info }
const sceneCode = /\.(ts|tsx|js|mjs)$/i;
const exportsCreateScene = /export\s+(?:async\s+)?function\s+createScene\b|export\s+(?:const|let)\s+createScene\b|export\s*\{[^}]*\bcreateScene\b/;
const exportsSample = /export\s+const\s+sample\b(?:\s*:[^=]+)?\s*=\s*(\{[^}]*\})?/;
/**
 * A module that can play on its own: "sample" when it declares itself one (`export const
 * sample`, with its literal duration when it has one), "module" when it only exports
 * createScene. Read without running it; remembered until the file changes.
 */
export function sceneInfo(file, stat = fs.statSync(file)) {
  const known = scenes.get(file);
  if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.info;
  let info = null;
  if (stat.size <= 512 * 1024) {
    const code = fs.readFileSync(file, "utf8");
    if (exportsCreateScene.test(code)) {
      const sample = exportsSample.exec(code);
      const duration = sample?.[1] && /\bduration\s*:\s*(\d+(?:\.\d+)?)\b/.exec(sample[1]);
      info = sample ? { scene: "sample", ...(duration ? { duration: Number(duration[1]) } : {}) } : { scene: "module" };
    }
  }
  scenes.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, info });
  return info;
}

/** A module of the work drawn on its own: a path inside the work's folder (or from the repo root). */
export function sceneModule(work, scene) {
  let relative = path.posix.normalize(scene.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (relative.startsWith(`projects/${work.slug}/`)) relative = relative.slice(`projects/${work.slug}/`.length);
  const file = path.join(work.dir, relative);
  if (relative.startsWith("../") || path.isAbsolute(relative) || !inside(work.dir, file)) throw problem(400, "scene 是作品文件夹里的文件，例如 sheets/人物.ts");
  if (!/\.(ts|tsx|js|mjs)$/.test(relative)) throw problem(400, "scene 要是导出 createScene(options) 的 .ts 或 .js 文件");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw problem(404, `作品里没有 ${relative}`, "NOT_FOUND");
  return relative;
}

/** File tree of a work directory, relative paths with "/" separators. */
export function tree(dir, { maxEntries = 5000 } = {}) {
  const entries = [];
  const walk = (current, prefix) => {
    let names;
    try {
      names = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    names.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const entry of names) {
      if (HIDDEN.has(entry.name) || entries.length >= maxEntries) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        entries.push({ path: relative, type: "dir" });
        walk(full, relative);
      } else if (entry.isFile()) {
        const stat = fs.statSync(full);
        // The work's own composition (scene.ts) is the film, not something to play apart.
        const scene = sceneCode.test(entry.name) && relative !== "scene.ts" && relative !== "project.ts" ? sceneInfo(full, stat) : null;
        entries.push({ path: relative, type: "file", size: stat.size, mtime: stat.mtimeMs, kind: isText(entry.name) ? "text" : mediaKind(entry.name), ...scene });
      }
    }
  };
  walk(dir, "");
  return entries;
}

export function readText(dir, relative) {
  const file = confined(dir, relative);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw problem(404, `文件不存在：${relative}`, "NOT_FOUND");
  if (stat.size > TEXT_LIMIT) throw problem(413, `文件超过 ${TEXT_LIMIT / 1048576} MiB，不能作为文本读取`);
  const content = fs.readFileSync(file, "utf8");
  return { path: relative, content, hash: sha256(content), size: stat.size };
}

/** Write text; when `expectedHash` is given the write fails if someone else changed the file. */
export function writeText(dir, relative, content, { expectedHash } = {}) {
  const file = confined(dir, relative);
  if (expectedHash !== undefined) {
    const current = fs.existsSync(file) ? sha256(fs.readFileSync(file, "utf8")) : null;
    if (current !== (expectedHash || null)) throw problem(409, `${relative} 已被其他人修改，请重新读取后再保存`, "CONFLICT", { currentHash: current });
  }
  writeFileAtomic(file, content);
  return { path: relative, hash: sha256(content) };
}

export function removePath(dir, relative) {
  if (!relative || relative === "." || relative === "project.ts") throw problem(400, "不能删除这个文件");
  const file = confined(dir, relative);
  if (!fs.existsSync(file)) throw problem(404, `文件不存在：${relative}`, "NOT_FOUND");
  fs.rmSync(file, { recursive: true });
}

export function movePath(dir, from, to) {
  const source = confined(dir, from),
    target = confined(dir, to);
  if (!fs.existsSync(source)) throw problem(404, `文件不存在：${from}`, "NOT_FOUND");
  if (fs.existsSync(target)) throw problem(409, `目标已存在：${to}`, "CONFLICT");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
}

/** Stream a request body to a file in the work, refusing to overwrite unless asked. */
export async function writeStream(dir, relative, stream, { overwrite = false, limit = 2 * 1024 * 1024 * 1024 } = {}) {
  const file = confined(dir, relative);
  if (!overwrite && fs.existsSync(file)) throw problem(409, `文件已存在：${relative}`, "CONFLICT");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".upload-" + process.pid + "-" + Date.now();
  let size = 0;
  try {
    const out = fs.createWriteStream(temp);
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > limit) throw problem(413, "文件过大");
      if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return { path: relative, size };
}

/** Pick an unused name like "voice-2.wav" next to `relative`. */
export function uniquePath(dir, relative) {
  const ext = path.extname(relative);
  const stem = relative.slice(0, relative.length - ext.length);
  let candidate = relative;
  for (let index = 2; fs.existsSync(confined(dir, candidate)); index++) candidate = `${stem}-${index}${ext}`;
  return candidate;
}

/**
 * What a download of picked paths holds. One file goes as it is (`file`); more, or a folder, go
 * as a zip of `entries`, named from the folder the picks share: files picked in one folder unpack
 * without it, a picked folder keeps its name. What a picked folder holds is picked with it.
 */
export function downloadPlan(dir, paths, fallbackName) {
  const picked = [...new Set((Array.isArray(paths) ? paths : []).map((item) => String(item).replace(/^\/+|\/+$/g, "")))].filter(Boolean);
  if (!picked.length) throw problem(400, "没有选中要导出的文件");
  const roots = picked.filter((item) => !picked.some((other) => item.startsWith(other + "/")));
  const found = roots.map((relative) => {
    const file = confined(dir, relative);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat || !(stat.isFile() || stat.isDirectory()) || relative.split("/").some((part) => HIDDEN.has(part)))
      throw problem(404, `文件不存在：${relative}`, "NOT_FOUND");
    return { relative, file, stat };
  });
  if (found.length === 1 && found[0].stat.isFile()) return { file: found[0].file, name: path.basename(found[0].file), size: found[0].stat.size, count: 1 };
  const shared = found
    .map((item) => item.relative.split("/").slice(0, -1))
    .reduce((common, parts) => common.slice(0, [...common, null].findIndex((part, index) => part !== parts[index])));
  const cut = shared.length ? shared.join("/").length + 1 : 0;
  const entries = [];
  for (const { relative, file, stat } of found) {
    const name = relative.slice(cut);
    if (stat.isFile()) {
      entries.push({ name, file, type: "file", size: stat.size, mtime: stat.mtimeMs });
      continue;
    }
    entries.push({ name, file, type: "dir", size: 0, mtime: stat.mtimeMs });
    for (const entry of tree(file, { maxEntries: Infinity })) {
      const inner = path.join(file, entry.path);
      if (entry.type === "file") entries.push({ name: `${name}/${entry.path}`, file: inner, type: "file", size: entry.size, mtime: entry.mtime });
      else entries.push({ name: `${name}/${entry.path}`, file: inner, type: "dir", size: 0, mtime: fs.statSync(inner).mtimeMs });
    }
  }
  const title = found.length === 1 ? path.basename(found[0].file) : shared.at(-1) || fallbackName;
  return { entries, name: `${title}.zip`, size: entries.reduce((sum, entry) => sum + entry.size, 0), count: entries.filter((entry) => entry.type === "file").length };
}

/** The exact length of a stored (uncompressed) zip of `entries`, as fflate writes it. */
function zipLength(entries) {
  let length = 22;
  for (const entry of entries) {
    const name = Buffer.byteLength(entry.name) + (entry.type === "dir" ? 1 : 0);
    length += 30 + name + entry.size + 16 + 46 + name;
  }
  return length;
}

/** Refuse what a zip without its 64-bit extension cannot hold. */
export function assertZippable(entries) {
  if (entries.length > 65535) throw problem(413, `选中的内容有 ${entries.length} 个文件和文件夹，超过 zip 的 65535 个上限，请分几次导出`);
  const length = zipLength(entries);
  if (length > 2 ** 32 - 1) throw problem(413, `选中的内容共 ${(length / 2 ** 30).toFixed(1)} GB，超过 zip 的 4 GB 上限，请分几次导出`);
}

/**
 * Stream `entries` as a zip download. Stored, not compressed: media is compressed already, and
 * the exact length lets the browser show progress. Read as the network takes it, never whole.
 */
export async function sendZip(req, res, entries, name) {
  assertZippable(entries);
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Length": zipLength(entries),
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") return res.end();
  const drained = () =>
    new Promise((resolve) => {
      const done = () => (res.off("drain", done), res.off("close", done), resolve());
      res.on("drain", done);
      res.on("close", done);
    });
  const zip = new Zip((error, chunk) => (error ? res.destroy(error) : res.write(chunk)));
  for (const entry of entries) {
    const item = new ZipPassThrough(entry.type === "dir" ? entry.name + "/" : entry.name);
    // Zip times start in 1980; files dated before (a clock at zero) would stop the archive.
    item.mtime = Math.max(entry.mtime, Date.UTC(1980, 0, 2));
    zip.add(item);
    let read = 0;
    if (entry.size)
      for await (const chunk of fs.createReadStream(entry.file, { end: entry.size - 1 })) {
        if (res.destroyed) return;
        read += chunk.length;
        item.push(chunk);
        if (res.writableNeedDrain) await drained();
      }
    // A file that shrank after it was measured would break the announced length: fail, not a bad zip.
    if (read !== entry.size) return res.destroy(new Error(`${entry.name} changed during the download`));
    item.push(new Uint8Array(0), true);
  }
  zip.end();
  res.end();
}

/**
 * Watch opened works: emits `work-files` for explorers and reports public/ asset
 * changes to the preview (module changes are reported by Vite itself).
 */
export class WorkWatcher {
  constructor({ events, preview }) {
    this.events = events;
    this.preview = preview;
    this.watchers = new Map();
  }
  watch(work) {
    const key = `${work.repo}/${work.id}`;
    if (this.watchers.has(key)) return;
    let timer,
      changed = new Set();
    let watcher;
    try {
      watcher = fs.watch(work.root, { recursive: true }, (_, name) => {
        if (!name) return;
        const relative = String(name).split(path.sep).join("/");
        // .materials holds generated copies of library code; the preview's own watcher follows them.
        if (/(^|\/)(\.git|node_modules|exports|\.cache|\.materials)(\/|$)/.test(relative) || relative.endsWith(".tmp")) return;
        changed.add(relative);
        clearTimeout(timer);
        timer = setTimeout(() => {
          const files = [...changed];
          changed = new Set();
          this.events.emit({ type: "work-files", work: work.id, repo: work.repo, files });
          const assets = files.filter((file) => /^projects\/[^/]+\/public\//.test(file));
          if (assets.length) this.preview.assetsChanged(work, assets);
        }, 150);
      });
    } catch (error) {
      console.warn("cannot watch work", work.root, error.message);
      return;
    }
    watcher.on("error", () => this.unwatch(work));
    this.watchers.set(key, watcher);
  }
  unwatch(work) {
    const key = `${work.repo}/${work.id}`;
    this.watchers.get(key)?.close();
    this.watchers.delete(key);
  }
  /** Every work of a repository (being removed). */
  unwatchRepo(repo) {
    for (const key of this.watchers.keys()) if (key.startsWith(repo + "/")) this.unwatch({ repo, id: key.slice(repo.length + 1) });
  }
  close() {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}
