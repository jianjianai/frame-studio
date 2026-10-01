import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { confined, problem } from "./security.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const signature = stat => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
const types = {
  ".js": "application/javascript", ".mjs": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav",
  ".flac": "audio/flac", ".aac": "audio/aac", ".m4a": "audio/mp4", ".aif": "audio/aiff", ".aiff": "audio/aiff",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".avif": "image/avif", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mov": "video/quicktime", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".otf": "font/otf", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
};
export const liveResourceType = file => types[path.extname(file).toLowerCase()] || "application/octet-stream";

export function liveResource(session, relative, revision, bytes, kind) {
  const url = "/preview-live/" + session.secret + "/" + relative + "?v=" + revision;
  return { path: relative, url, originalUrl: url, revision, sha256: revision, bytes,
    type: liveResourceType(relative), kind };
}

/** Include every emitted dynamic chunk/worker/WASM, rather than only the eager preload graph. */
export async function bundleResources(session, files) {
  const resources = [];
  for (const relative of [...files].sort()) {
    const file = confined(session.outDir, relative);
    const stat = await fsp.lstat(file), identity = signature(stat);
    if (!stat.isFile() || stat.isSymbolicLink()) throw problem(409, "Invalid emitted runtime resource");
    const cached = session.resourceHashes.get(relative);
    if (cached?.signature === identity) { resources.push(cached.resource); continue; }
    const content = await fsp.readFile(file);
    if (signature(await fsp.lstat(file)) !== identity) throw problem(409, "Runtime module changed while preparing its preview");
    const resource = liveResource(session, relative, digest(content), content.length, "module");
    session.resourceHashes.set(relative, { signature: identity, resource });
    resources.push(resource);
  }
  return resources;
}

/** Freeze platform decoders/fonts as well: a content URL must never serve changed deployment bytes.
 * Never walk project outputs, dependency stores, or arbitrary server directories.
 */
export async function runtimeResources(session, root, maxBytes) {
  const resources = [];
  const walk = async (directory, relative) => {
    let names;
    try { names = await fsp.readdir(directory); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const name of names.sort()) {
      if (name.startsWith(".")) continue;
      const source = path.join(directory, name), item = relative + "/" + name;
      const stat = await fsp.lstat(source);
      if (stat.isSymbolicLink() || stat.nlink > 1 && stat.isFile() || !stat.isFile() && !stat.isDirectory())
        throw problem(409, "Runtime assets must be regular owned files");
      if (stat.isDirectory()) { await walk(source, item); continue; }
      if (stat.size > maxBytes) throw problem(413, "Runtime resource exceeds the live preview cache budget");
      const previous = session.runtimeSources.get(item), identity = signature(stat);
      if (previous?.signature === identity) { resources.push(previous.resource); continue; }
      // Only a small decoder/font tree is hashed; no media probing or conversion occurs here.
      const hash = createHash("sha256");
      const temporary = path.join(session.outDir, "runtime", "." + randomUUID() + ".tmp");
      await fsp.mkdir(path.dirname(temporary), { recursive: true });
      const hashing = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); } });
      try {
        await pipeline(fs.createReadStream(source, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) }),
          hashing, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal: session.abort?.signal });
        if (signature(await fsp.lstat(source)) !== signature(stat))
          throw problem(409, "Runtime asset changed while preparing its preview");
        const revision = hash.digest("hex"), key = item + ":" + revision;
        if (!session.runtimeFiles.has(key)) {
          if (session.runtimeBytes + stat.size > maxBytes)
            throw problem(413, "Runtime revision cache is full; reopen the preview");
          const file = path.join(session.outDir, "runtime", revision + path.extname(source));
          await fsp.rename(temporary, file);
          session.runtimeFiles.set(key, { file, revision, bytes: stat.size });
          session.runtimeBytes += stat.size;
        }
        const resource = liveResource(session, item, revision, stat.size, "runtime");
        session.runtimeSources.set(item, { signature: identity, resource });
        resources.push(resource);
      } finally { await fsp.rm(temporary, { force: true }); }
    }
  };
  for (const category of ["vendor", "fonts"]) {
    const directory = path.join(root, "public", category);
    try { const stat = await fsp.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw problem(409, "Invalid runtime resource directory"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    await walk(directory, category);
  }
  return resources;
}
