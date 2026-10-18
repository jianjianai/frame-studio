import fs from "node:fs";
import path from "node:path";
import { contentVersion } from "./files.mjs";
import { ownAddresses, playedFiles } from "./playback.mjs";
import { problem, confined, mimeType } from "./util.mjs";

/**
 * What the browser keeps of a work (public/frame-sw.js): the files of its public/ folder and
 * the library files it plays, under the work's asset base (`films/<slug>/…`,
 * `materials/<library>/…`), each with a content version. Files its playback does not name
 * (playback.mjs) are `lazy`: kept the first time they are asked for, not when the work opens.
 * `at` orders lists from different requests: the browser keeps the newest.
 */
export async function precacheManifest(services, work) {
  const at = Date.now();
  const { root, found, played } = ownFiles(work);
  const files = [];
  for (let index = 0; index < found.length; index += 4)
    files.push(
      ...(await Promise.all(
        found.slice(index, index + 4).map(async (relative) => {
          const full = path.join(root, relative);
          const stat = fs.statSync(full);
          return {
            path: `films/${work.slug}/${relative}`,
            size: stat.size,
            version: await contentVersion(full, stat),
            ...(played.has(relative) ? {} : { lazy: true }),
          };
        }),
      )),
    );
  for (const item of (await services.materials?.playback(work).catch(() => [])) ?? [])
    files.push({ path: `materials/${item.ref}`, size: item.size, version: item.version, ...(item.lazy ? { lazy: true } : {}) });
  return { key: `${work.repo}/${work.id}`, base: `/files/${work.repo}/${work.id}/`, at, files };
}

/** The work's public/ files (paths under it) and those its playback names. */
function ownFiles(work) {
  const root = path.join(work.dir, "public");
  const found = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  const { exact, prefixes } = ownAddresses(work);
  return { root, found, played: playedFiles(found, exact, prefixes) };
}

/** A path of the manifest: the file served for it and its version. */
async function precacheFile(services, work, relative) {
  const material = /^materials\/(.+)$/.exec(relative);
  if (material && services.materials) {
    const locks = services.materials.readLocks(work.dir);
    const file = await services.materials.file(work.repo, locks, material[1]);
    return { file, version: locks[material[1]] ? "git-" + locks[material[1]] : null };
  }
  const film = /^films\/([^/]+)\/(.+)$/.exec(relative);
  if (!film || film[1] !== work.slug) throw problem(404, "文件不存在：" + relative, "NOT_FOUND");
  return { file: confined(path.join(work.dir, "public"), film[2]), version: null };
}

/**
 * Many small files in one response, so high-latency links pay one round trip instead of
 * one per file. Framing per file: u32 header length, JSON header { path, size, version,
 * type }, then exactly `size` bytes.
 */
export async function sendBundle(services, work, paths, res) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 1000) throw problem(400, "paths 必须是 1–1000 个文件");
  const files = [];
  for (const relative of paths.map(String)) {
    const { file, version } = await precacheFile(services, work, relative);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw problem(404, "文件不存在：" + relative, "NOT_FOUND");
    files.push({ relative, file, stat, version });
  }
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
  const write = (chunk) => (res.write(chunk) ? undefined : new Promise((resolve) => res.once("drain", resolve)));
  for (const { relative, file, stat, version } of files) {
    const header = Buffer.from(
      JSON.stringify({ path: relative, size: stat.size, version: version ?? (await contentVersion(file, stat)), type: mimeType(file) }),
    );
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    await write(Buffer.concat([length, header]));
    let sent = 0;
    for await (const chunk of fs.createReadStream(file, { start: 0, end: Math.max(0, stat.size - 1) })) {
      if (!stat.size) break;
      // The header promised stat.size bytes; a file growing meanwhile must not break the framing.
      const part = chunk.subarray(0, stat.size - sent);
      sent += part.length;
      await write(part);
      if (sent >= stat.size) break;
    }
    if (sent < stat.size) await write(Buffer.alloc(stat.size - sent));
  }
  res.end();
}
