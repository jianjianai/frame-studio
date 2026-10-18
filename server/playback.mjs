import fs from "node:fs";
import path from "node:path";

/**
 * Which files a work's playback uses, as far as its code and documents tell: what the
 * browser keeps as soon as the work opens (precache.mjs); its other files are kept the first
 * time they are asked for.
 */

/** The work's own source files (not its media, exports or notes). */
export function sourceFiles(work) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || ["node_modules", "exports", "public", "production"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs|json)$/.test(entry.name) && entry.name !== "materials.lock.json") files.push(full);
    }
  };
  walk(work.dir);
  return files;
}

/** An address built at run time (`…/voice/${id}.mp3`, "…/voice/" + id): the part known in advance; null for a plain address. */
export const prefixOf = (address) => (address.includes("${") ? address.slice(0, address.indexOf("${")) : address.endsWith("/") ? address : null);

/**
 * The work's own files (paths under public/) its code and documents name as
 * films/<slug>/…: `exact` addresses and the `prefixes` of addresses built at run time.
 */
export function ownAddresses(work) {
  // Slugs are plain (validSlug): nothing to escape.
  const pattern = new RegExp(`films/${work.slug}/([^"'\`\\s)\\\\]+)`, "g");
  const exact = new Set();
  const prefixes = new Set();
  for (const file of sourceFiles(work))
    for (const match of fs.readFileSync(file, "utf8").matchAll(pattern)) {
      const prefix = prefixOf(match[1]);
      if (prefix !== null) prefixes.add(decoded(prefix));
      else exact.add(decoded(match[1].replace(/[?#].*$/, "")));
    }
  return { exact, prefixes };
}
const decoded = (address) => {
  try {
    return decodeURIComponent(address);
  } catch {
    return address;
  }
};

const MODEL_WITH_FILES = /\.(gltf|obj|fbx)$/i;
/**
 * The `candidates` (file paths) that playback naming `exact` addresses and the `prefixes` of
 * run-time addresses uses: those, every file under a prefix, under a folder named like a
 * file (`const DIR = "films/<slug>/models"`, then `${DIR}/${name}`), a soundfont's split parts
 * (<bank>.parts/, soundfont-audio.ts), and the folder of a glTF/OBJ/FBX model, where its
 * external files are (docs/guide/three.md) — unless that folder is the top (`top` path parts
 * deep: a work's public/ or a library), which would be every file.
 */
export function playedFiles(candidates, exact, prefixes, top = 0) {
  const under = [...prefixes];
  for (const address of exact) {
    under.push(address + "/", address + ".parts/");
    const folder = address.slice(0, address.lastIndexOf("/") + 1);
    if (MODEL_WITH_FILES.test(address) && folder.split("/").length - 1 > top) under.push(folder);
  }
  return new Set(candidates.filter((file) => exact.has(file) || under.some((prefix) => file.startsWith(prefix))));
}
