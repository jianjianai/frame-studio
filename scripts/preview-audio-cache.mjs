import fs from "node:fs/promises";
import {visualAudioTracks} from "../src/engine/visual-audio.mjs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parse } from "@babel/parser";
import { readProject, visitNodes } from "./project-metadata.mjs";
import { projectPath, assetPath, inside } from "./project-paths.mjs";
import { sharedRuntime } from "./shared-runtime.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const ignored = new Set(["exports", ".cache", ".history", "records", ".git", "node_modules", "test-results", "playwright-report"]);
async function stat(file) {
  try {
    const value = await fs.lstat(file);
    if (value.isSymbolicLink() || (value.isFile() && value.nlink > 1)) throw Error("Unsafe audio cache input");
    return value;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function sha(file) {
  const handle = await fs.open(file, "r");
  try {
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
    return hash.digest("hex");
  } finally { await handle.close(); }
}
async function inventory(root, files, file) {
  const value = await stat(file);
  if (!value) return;
  if (value.isDirectory()) {
    for (const name of (await fs.readdir(file)).sort()) if (!ignored.has(name)) await inventory(root, files, path.join(file, name));
  } else if (value.isFile()) files.set(path.relative(root, file).replaceAll("\\", "/"), await sha(file));
}
async function resolveModule(file) {
  for (const name of [file, ...[".ts", ".tsx", ".js", ".mjs", ".json"].flatMap(ext => [file + ext, path.join(file, "index" + ext)])])
    if ((await stat(name))?.isFile()) return name;
  return null;
}
/** Conservative dependency closure: dynamic/computed loads fall back to the whole work. */
export async function audioCacheKeys(root, id, runtime = {}) {
  root = path.resolve(root);
  const projectFile = projectPath(root, id, "project.ts"), record = readProject(projectFile);
  const tracks = [...(record.meta.audioTracks ?? (record.meta.audio ? [{ id: "main", kind: "file", src: record.meta.audio }] : [])), ...visualAudioTracks(record.meta.visual)];
  const common = new Map(), shared = sharedRuntime(root);
  const pinnedCommon = name => shared?.names.has(name.split("/")[0]);
  if (shared) common.set("runtimeFingerprint", shared.fingerprint);
  for (const name of ["src/engine", "src/contracts", "public", "package.json", "pnpm-lock.yaml", "scripts/preview-audio.mjs", "scripts/preview-audio-cache.mjs"]) {
    // Only verified top-level runtime links use the immutable runtime identity.
    // Authored files/media and ordinary CLI inputs still require their own bytes.
    if (pinnedCommon(name)) continue;
    await inventory(root, common, path.join(root, name));
  }
  const lockFile = path.join(pinnedCommon("pnpm-lock.yaml") ? shared.root : root, "pnpm-lock.yaml");
  const generated = new Map(), visited = new Set();
  let conservative = false;
  const visit = async file => {
    if (visited.has(file)) return;
    visited.add(file);
    if (!inside(root, file)) { conservative = true; return; }
    await inventory(root, generated, file);
    if (!/\.(ts|tsx|js|mjs)$/.test(file)) return;
    let ast;
    try { ast = parse(await fs.readFile(file, "utf8"), { sourceType: "module", plugins: ["typescript", "jsx"], createImportExpressions: true }); }
    catch { conservative = true; return; }
    const dependencies = [];
    visitNodes(ast, node => {
      if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) && node.importKind !== "type" && node.exportKind !== "type") {
        if (node.source?.value) dependencies.push(node.source.value);
      } else if (node.type === "ImportExpression") {
        if (node.source?.type === "StringLiteral") dependencies.push(node.source.value);
        else conservative = true;
      } else if (node.type === "CallExpression" && node.callee?.type === "Import") {
        if (node.arguments[0]?.type === "StringLiteral") dependencies.push(node.arguments[0].value);
        else conservative = true;
      } else if (node.type === "NewExpression" && node.callee?.name === "URL") {
        if (node.arguments[0]?.type === "StringLiteral") dependencies.push(node.arguments[0].value);
        else conservative = true;
      } else if (node.type === "CallExpression" && ["glob", "globEager", "require", "eval"].includes(node.callee?.property?.name || node.callee?.name)) conservative = true;
    });
    for (const dep of dependencies) {
      if (!dep.startsWith(".")) { if (dep.startsWith("/") || dep.includes(":") || !(await stat(lockFile))) conservative = true; continue; }
      const dependency = await resolveModule(path.resolve(path.dirname(file), dep.split(/[?#]/)[0]));
      if (dependency) await visit(dependency); else conservative = true;
    }
  };
  if (tracks.some(track => track.kind === "generated")) {
    const entry = record.audioLoadPath && await resolveModule(path.resolve(path.dirname(projectFile), record.audioLoadPath));
    if (entry) await visit(entry); else conservative = true;
    // A generator can fetch any owned asset at runtime; keep the dependency set conservative.
    await inventory(root, generated, projectPath(root, id, "public"));
    if (conservative) await inventory(root, generated, projectPath(root, id));
  }
  const sorted = map => [...map].sort(([a], [b]) => a.localeCompare(b));
  const result = {};
  for (const track of tracks) {
    const files = new Map(common);
    if (track.kind === "generated") for (const item of generated) files.set(...item);
    else await inventory(root, files, assetPath(root, track.src, id));
    const { gain, muted, name, ...timing } = track;
    result[track.id] = digest(JSON.stringify({ version: 1, runtime, duration: record.meta.duration, track: timing, files: sorted(files) }));
  }
  return result;
}
export async function restoreAudioTrack(source, output, id, key, duration) {
  if (!source || !key) return null;
  try {
    const file = path.join(source, "preview-audio.json");
    if (!((await stat(file))?.size < 4 * 1024 * 1024)) return null;
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    const track = manifest.tracks?.find(track => track.id === id && track.cacheKey === key);
    if (manifest.version !== 1 || manifest.duration !== duration || !track || track.chunks.length !== Math.ceil(duration / 2)) return null;
    let end = 0;
    for (const chunk of track.chunks) {
      if (chunk.start !== end || !(chunk.duration > 0 && chunk.duration <= 2) || !/^[a-f0-9]{64}$/.test(chunk.sha256) ||
          chunk.file !== "preview-audio/" + chunk.sha256 + ".mp3" || !(chunk.bytes > 0 && chunk.bytes < 262144)) return null;
      const input = path.join(source, chunk.file);
      if ((await stat(input))?.size !== chunk.bytes || await sha(input) !== chunk.sha256) return null;
      end += chunk.duration;
    }
    if (Math.abs(end - duration) > 0.000001) return null;
    await fs.mkdir(path.join(output, "preview-audio"), { recursive: true });
    for (const chunk of track.chunks) await fs.copyFile(path.join(source, chunk.file), path.join(output, chunk.file));
    return structuredClone(track);
  } catch { return null; } // Cache corruption is a miss, never a reason to publish wrong sound.
}
export async function saveAudioCache(output, cache, manifest) {
  const stage = cache + ".tmp-" + randomUUID();
  await fs.mkdir(path.join(stage, "preview-audio"), { recursive: true });
  try {
    for (const file of new Set(manifest.tracks.flatMap(track => track.chunks.map(chunk => chunk.file))))
      await fs.copyFile(path.join(output, file), path.join(stage, file));
    await fs.writeFile(path.join(stage, "preview-audio.json"), JSON.stringify(manifest));
    // A disposable optimization, never source material; an active build owns this project lock.
    await fs.rm(cache, { recursive: true, force: true });
    await fs.rename(stage, cache);
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
