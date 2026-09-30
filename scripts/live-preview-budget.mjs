import fsp from "node:fs/promises";
import path from "node:path";

/** Reserve originals plus compressed variants, including outputs skipped by IPC coalescing. */
export async function assertLiveBundleBudget(outDir, bundle, maxBytes) {
  const existing = new Map();
  const walk = async (dir, prefix = "") => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (!prefix && (entry.name === ".vite" || entry.name === "source-snapshots" || entry.name === "live-assets.watch.json")) continue;
      const relative = prefix + entry.name, file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, relative + "/");
      else if (entry.isSymbolicLink()) throw Error("Live preview output cannot contain links");
      else if (entry.isFile()) {
        try { existing.set(relative, (await fsp.stat(file)).size); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
  };
  await walk(outDir);
  const reserved = new Map();
  for (const [file, bytes] of existing) {
    const original = /\.(?:br|gz)$/.test(file) ? file.replace(/\.(?:br|gz)$/, "") : null;
    if (original && existing.has(original)) continue;
    reserved.set(file, original ? bytes : bytes * 3);
  }
  for (const [file, output] of Object.entries(bundle)) {
    const source = output.type === "chunk" ? output.code : output.source;
    reserved.set(file, Buffer.byteLength(source) * 3);
  }
  const bytes = [...reserved.values()].reduce((sum, size) => sum + size, 0);
  if (bytes > maxBytes) throw Error("Live preview revision cache is full; reopen the preview to release old code");
  return bytes;
}
