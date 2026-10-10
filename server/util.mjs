import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

/** Errors with an HTTP status and a stable code; messages are shown to people and AI as-is. */
export function problem(status, message, code = "BAD_REQUEST", details) {
  return Object.assign(new Error(message), { status, code, details });
}
export const notFound = (message) => problem(404, message, "NOT_FOUND");
export const conflict = (message, details) => problem(409, message, "CONFLICT", details);

export const shortId = () => randomBytes(4).toString("hex");
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function inside(base, file) {
  const relative = path.relative(base, file);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep);
}

/** Resolve a user/AI supplied relative path inside base; rejects traversal and symlink escapes. */
export function confined(base, relative = "") {
  if (typeof relative !== "string" || relative.includes("\0")) throw problem(400, "Invalid path");
  const file = path.resolve(base, relative.replace(/^\/+/, ""));
  if (!inside(base, file)) throw problem(400, `Path escapes its directory: ${relative}`);
  let existing = file;
  while (!fs.existsSync(existing) && existing !== base) existing = path.dirname(existing);
  if (fs.existsSync(existing) && !inside(fs.realpathSync(base), fs.realpathSync(existing)))
    throw problem(400, `Path leaves its directory through a link: ${relative}`);
  return file;
}

export function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

/** A Map that forgets the least recently used entries beyond `limit` (which may be raised as the working set grows). */
export class Lru extends Map {
  constructor(limit) {
    super();
    this.limit = limit;
  }
  get(key) {
    if (!super.has(key)) return undefined;
    const value = super.get(key);
    super.delete(key);
    super.set(key, value);
    return value;
  }
  set(key, value) {
    super.delete(key);
    super.set(key, value);
    while (this.size > this.limit) super.delete(this.keys().next().value);
    return this;
  }
}

/** Serialize async work per key (one git/write operation per work at a time). */
export class Locks {
  constructor() {
    this.tails = new Map();
  }
  run(key, task) {
    const previous = this.tails.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => this.tails.get(key) === tail && this.tails.delete(key));
    return next;
  }
}

export class Events {
  constructor() {
    this.listeners = new Set();
  }
  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("event listener failed", error);
      }
    }
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".weba": "audio/webm",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".wasm": "application/wasm",
  ".sf2": "application/octet-stream",
  ".mid": "audio/midi",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export const mimeType = (file) => mimeTypes[path.extname(file).toLowerCase()] || "application/octet-stream";
export const mediaKind = (file) => {
  const type = mimeType(file);
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("font/")) return "font";
  if (type.startsWith("model/")) return "model";
  return "file";
};
