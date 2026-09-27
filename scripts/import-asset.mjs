import { updateWaveforms } from "./waveforms.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { projectPath } from "./project-paths.mjs";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { optimize } from "svgo";
const args = process.argv.slice(2);
const [id, source] = args;
const publicDir = projectPath(process.cwd(), id, "public");
await fs.access(projectPath(process.cwd(), id, "project.ts"));
if (!source) {
  console.error(
    'Usage: pnpm assets:import <id> "path/to/asset" [--license "license and source"]',
  );
  process.exit(1);
}
const ext = path.extname(source).toLowerCase();
const images = [".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg", ".gif"],
  audio = [".wav", ".mp3", ".ogg", ".m4a"],
  videos = [".mp4", ".webm"],
  models = [".glb", ".gltf"];
const type = images.includes(ext)
  ? "image"
  : audio.includes(ext)
    ? "audio"
    : videos.includes(ext)
      ? "video"
      : models.includes(ext)
        ? "model"
        : null;
if (!type) throw new Error("Unsupported asset type: " + ext);
const stat = await fs.stat(source);
if (!stat.isFile()) throw new Error("Source must be a regular file");
let name =
  path
    .basename(source, ext)
    .replace(/[^\p{L}\p{N}_-]/gu, "-")
    .slice(0, 80) || "asset";
let outExt =
  images.includes(ext) && ![".svg", ".gif"].includes(ext) ? ".webp" : ext;
let target = projectPath(process.cwd(), id, "public/imports/" + name) + outExt;
await fs.mkdir(projectPath(process.cwd(), id, "public/imports"), {
  recursive: true,
});
try {
  await fs.access(target);
  target =
    projectPath(process.cwd(), id, "public/imports/" + name) +
    "-" +
    randomUUID() +
    outExt;
} catch {}
if (ext === ".gltf") {
  const data = JSON.parse(await fs.readFile(source, "utf8"));
  if (
    [...(data.buffers || []), ...(data.images || [])].some(
      (v) => v.uri && !v.uri.startsWith("data:"),
    )
  )
    throw new Error(
      "glTF has external resources. Export a self-contained GLB before importing.",
    );
}
if (outExt === ".webp")
  await sharp(source).rotate().webp({ quality: 92 }).toFile(target);
else if (ext === ".svg")
  await fs.writeFile(target, optimize(await fs.readFile(source, "utf8")).data);
else await fs.copyFile(source, target);
const indexPath = projectPath(process.cwd(), id, "public/assets.json");
let catalog = [];
try {
  catalog = JSON.parse(await fs.readFile(indexPath, "utf8"));
} catch {}
const li = args.indexOf("--license");
const license = li >= 0 ? args[li + 1] : "未确认授权；正式发布前请核实来源";
const item = {
  name: path.basename(target),
  url:
    "films/" +
    id +
    "/" +
    path.relative(publicDir, target).replaceAll(path.sep, "/"),
  type,
  bytes: (await fs.stat(target)).size,
  license,
};
catalog.push(item);
await fs.writeFile(indexPath, JSON.stringify(catalog, null, 2));
await updateWaveforms(id);
console.log("Imported without modifying source: " + target);
console.log("Use assetUrl(" + JSON.stringify(item.url) + ") in your scene.");
