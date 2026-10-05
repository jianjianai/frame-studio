import fs from "node:fs";
import path from "node:path";
import { confined, problem, writeFileAtomic, mediaKind, sha256 } from "./util.mjs";

const HIDDEN = new Set([".git", "node_modules", ".cache", "exports", ".DS_Store"]);
export const TEXT_LIMIT = 2 * 1024 * 1024;
const textExtensions = /\.(ts|tsx|js|mjs|cjs|jsx|json|md|txt|css|html|svg|glsl|frag|vert|srt|vtt|csv|yaml|yml|toml)$/i;
export const isText = (file) => textExtensions.test(file);

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
        entries.push({ path: relative, type: "file", size: stat.size, mtime: stat.mtimeMs, kind: isText(entry.name) ? "text" : mediaKind(entry.name) });
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
        if (/(^|\/)(\.git|node_modules|exports|\.cache)(\/|$)/.test(relative) || relative.endsWith(".tmp")) return;
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
  close() {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}
