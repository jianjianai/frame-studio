import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { remotionProjectAssets } from "./remotion-project-assets.mjs";
import { bindLiveProjectWorkers, previewWorkerRuntime } from "./live-preview-project-workers.mjs";
import { assertLiveBundleBudget } from "./live-preview-budget.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const inside = (base, file) => {
  const rel = path.relative(base, file);
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + path.sep);
};
const clean = id => id.split("?")[0];
const ignored = new Set([".git", "node_modules", ".cache", ".history", "exports", "records", "production", "tests"]);
const audioFile = file => /(?:^|\/)(?:audio[^/]*|music|sound[^/]*)(?:\/|\.|$)/i.test(file) || /\.(?:wav|mp3|ogg|opus|flac|m4a|aac|aiff?|sf2|mid)$/i.test(file);
const assetHashes = new Map(), imageKinds = new Map();
async function previewKind(asset) {
  if (/\.(?:mp4|webm|mov|mkv|m4v)$/i.test(asset.file)) return "video";
  if (asset.bytes < 256 * 1024 || !/\.(?:png|jpe?g|webp|avif)$/i.test(asset.file)) return null;
  if (imageKinds.has(asset.revision)) return imageKinds.get(asset.revision);
  const { default: sharp } = await import("sharp");
  let kind = null;
  try { const metadata = await sharp(asset.file, { animated: true }).metadata(); if ((metadata.pages || 1) === 1) kind = "image"; } catch {}
  imageKinds.set(asset.revision, kind);
  if (imageKinds.size > 20000) imageKinds.delete(imageKinds.keys().next().value);
  return kind;
}
async function assetHash(file, signature) {
  const cached = assetHashes.get(file);
  if (cached?.signature === signature) return cached.revision;
  const hash = createHash("sha256");
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); }
  } finally { await handle.close(); }
  const stat = await fsp.lstat(file);
  if (digest(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])) !== signature)
    throw Error("Media changed while indexing live preview");
  const revision = hash.digest("hex"); assetHashes.set(file, { signature, revision });
  if (assetHashes.size > 20000) assetHashes.delete(assetHashes.keys().next().value);
  return revision;
}

/** Media revisions are content SHA-256, memoized by filesystem identity/mtime between edits.
 * Source files are never executed in Node; the resulting project is evaluated in an opaque iframe.
 */
export async function liveSourceInventory(projectDir, id, { dependencies = [], assetsOnly = false } = {}) {
  const source = [], visual = [], audio = [], metadata = [], assets = {}, sourceFiles = [], fileRevisions = {};
  const files = new Map();
  const walk = async (dir, rel = "") => {
    let names;
    try { names = (await fsp.readdir(dir)).sort(); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const name of names) {
      if (ignored.has(name) || name.startsWith(".env") || name.startsWith(".")) continue;
      const relative = rel ? rel + "/" + name : name;
      const file = path.join(dir, name), stat = await fsp.lstat(file);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1) || (!stat.isFile() && !stat.isDirectory()))
        throw Error("Live preview rejects project links and special files");
      if (stat.isDirectory()) await walk(file, relative);
      else files.set(relative, { file, stat });
    }
  };
  if (assetsOnly) await walk(path.join(projectDir, "public"), "public");
  else await walk(projectDir);
  // Normally ignored output/test directories may contain authored runtime modules.
  // Include only the actual imported graph, avoiding scans of unrelated render output.
  for (const dependency of dependencies) {
    const file = path.resolve(clean(dependency));
    if (!inside(projectDir, file)) continue;
    validateRegularWithin(projectDir, file);
    const relative = path.relative(projectDir, file).split(path.sep).join("/");
    if (relative.split("/").some(part => part === ".git" || part === "node_modules" || part.startsWith(".env")))
      throw Error("Live projects cannot import private environment or dependency store files");
    const stat = await fsp.lstat(file);
    if (stat.isFile()) files.set(relative, { file, stat });
  }
  let sourceBytes = 0;
  for (const [relative, { file, stat }] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const isAsset = relative.startsWith("public/");
    const signature = digest(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
    let content;
    if (!isAsset) {
      sourceBytes += stat.size;
      if (sourceBytes > 32 * 1024 * 1024) throw Error("Live project source exceeds the 32 MiB revision snapshot budget");
      content = await fsp.readFile(file);
      sourceFiles.push({ path: relative, content: content.toString("base64") });
    }
    const revision = isAsset ? await assetHash(file, signature) : digest(content);
    const entry = [relative, revision]; source.push(entry); fileRevisions[relative] = revision;
    if (isAsset) assets["films/" + id + "/" + relative.slice(7)] = { revision, signature, file, bytes: stat.size };
    if (relative === "project.ts") {
      metadata.push(entry); audio.push(entry); visual.push(entry);
    } else if (audioFile(relative)) audio.push(entry);
    else visual.push(entry);
  }
  return { sourceRevision: digest(JSON.stringify(source)), assets, sourceFiles, fileRevisions,
    fingerprints: { visual: digest(JSON.stringify(visual)), audio: digest(JSON.stringify(audio)), metadata: digest(JSON.stringify(metadata)) } };
}

function validateRegularWithin(base, file) {
  let relative = path.relative(base, file), current = base;
  if (!inside(base, file)) throw Error("Project import escapes its allowed directory");
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1) || (!stat.isDirectory() && !stat.isFile()))
      throw Error("Live project imports cannot follow links or special files");
  }
}

/** Persistent Rolldown graph, a bounded set of hashed chunks, no audio baking or type-check gate.
 * It publishes only after every output file was written. Old outputs remain usable until session disposal.
 */
export async function createLivePreviewBundle({ root, projectDir, id, outDir, onBundle, onError, onState, maxBundleBytes = 512 * 1024 * 1024 }) {
  root = path.resolve(root); projectDir = path.resolve(projectDir); outDir = path.resolve(outDir);
  validateRegularWithin(path.dirname(projectDir), projectDir);
  const sourceRoot = path.resolve(projectDir, "../.."), engineRoot = path.join(root, "src", "engine");
  const dependencies = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8"));
  const allowedPackages = new Set(Object.keys(dependencies.dependencies || {}));
  const virtual = "\0frame-live-project";
  const virtualAssets = "\0frame-live-assets", marker = path.join(outDir, "live-assets.watch.json");
  const typesFile = path.join(engineRoot, "types.ts");
  let started = performance.now(), watcher, closed = false, latest, assetWatcher, assetTimer, assetPoll, sourceBefore, publishQueue = Promise.resolve();
  let runtimeDependencies = [];
  const loadedSources = new Map(), workerDependencies = new Set();
  await fsp.mkdir(outDir, { recursive: true });
  const writeAssets = async () => {
    const inventory = await liveSourceInventory(projectDir, id, { assetsOnly: true });
    const kinds = {};
    const entries = Object.entries(inventory.assets);
    for (let index = 0; index < entries.length; index += 4)
      for (const [src, kind] of await Promise.all(entries.slice(index, index + 4).map(async ([src, value]) => [src, await previewKind(value)]))) kinds[src] = kind;
    const contents = JSON.stringify({
      revisions: Object.fromEntries(Object.entries(inventory.assets).map(([src, value]) => [src, value.revision])),
      sizes: Object.fromEntries(Object.entries(inventory.assets).map(([src, value]) => [src, value.bytes])),
      kinds,
    });
    let previous; try { previous = await fsp.readFile(marker, "utf8"); } catch {}
    if (contents !== previous) await fsp.writeFile(marker, contents);
  };
  await writeAssets();
  const publish = async (bundle, audioGeneratorRevision, projectModules, loadRoots) => {
    const inventory = await liveSourceInventory(projectDir, id, { dependencies: projectModules });
    if (closed) return;
    // Compare every previously inventoried file and newly loaded graph module to the captured version.
    // A first import from an otherwise ignored folder is allowed in this same successful build.
    for (const [relative, revision] of Object.entries(sourceBefore?.fileRevisions || {}))
      if (inventory.fileRevisions[relative] !== revision) return;
    for (const file of projectModules)
      if (loadedSources.has(clean(file)) && loadedSources.get(clean(file)) !== inventory.fileRevisions[path.relative(projectDir, clean(file)).split(path.sep).join("/")]) return;
    runtimeDependencies = projectModules;
    const chunks = Object.values(bundle).filter(file => file.type === "chunk");
    const project = chunks.find(file => file.isEntry && file.name === "project");
    const player = chunks.find(file => file.isEntry && file.name === "player");
    if (!project || !player) throw Error("Live bundle must contain player and project entries");
    inventory.fingerprints.audio = digest(inventory.fingerprints.audio + audioGeneratorRevision);
    const moduleGraph = Object.fromEntries(chunks.map(chunk => [chunk.fileName, { imports: chunk.imports, dynamicImports: chunk.dynamicImports }]));
    const preloads = new Set();
    const visitStatic = file => { if (preloads.has(file) || !moduleGraph[file]) return; preloads.add(file); moduleGraph[file].imports.forEach(visitStatic); };
    visitStatic(project.fileName);
    // Metadata declares scene/audio/document loaders. Following dynamics from shared engine
    // chunks would eagerly fetch every optional renderer, synth and export implementation.
    for (const chunk of chunks)
      if (Object.keys(chunk.modules).some(moduleId => loadRoots.has(clean(moduleId)))) visitStatic(chunk.fileName);
    delete inventory.fileRevisions;
    const candidate = { ...inventory, preloads: [...preloads], moduleGraph, audioGeneratorRevision, projectUrl: project.fileName, playerUrl: player.fileName,
      styles: Object.values(bundle).filter(file => file.type === "asset" && file.fileName.endsWith(".css")).map(file => file.fileName),
      files: Object.keys(bundle), buildMs: Math.round(performance.now() - started) };
    latest = candidate;
    await onBundle(candidate);
  };
  const queuePublish = (bundle, audioGeneratorRevision, projectModules, loadRoots) => {
    publishQueue = publishQueue.then(() => publish(bundle, audioGeneratorRevision, projectModules, loadRoots)).catch(error => onError?.(error));
    return publishQueue;
  };
  const restricted = {
    name: "frame-live-project",
    enforce: "pre",
    resolveId: async function (source, importer) {
      if (source === "frame-live-project" || source === virtual) return virtual;
      if (source === "frame-live-assets" || source === virtualAssets) return virtualAssets;
      if (source.startsWith("\0vite")) return; // Vite's injected preload/runtime helpers contain no project file access.
      const importerPath = importer && clean(importer);
      if (importerPath && importerPath !== virtualAssets && (source.startsWith(".") || source.startsWith("/"))) {
        let typeTarget = path.resolve(path.dirname(importerPath), clean(source));
        const fromSource = path.relative(sourceRoot, typeTarget);
        if (fromSource.startsWith("src" + path.sep + "engine" + path.sep)) typeTarget = path.join(root, fromSource);
        if (typeTarget === typesFile || typeTarget + ".ts" === typesFile) return virtualAssets;
      }
      if (!importerPath || !inside(projectDir, importerPath)) return;
      if (/^(?:node:|https?:|data:|file:)/i.test(source)) throw Error("Live projects may only import local modules and installed browser packages");
      if (!source.startsWith(".") && !source.startsWith("/")) {
        const packageName = source.startsWith("@") ? source.split("/").slice(0, 2).join("/") : source.split("/")[0];
        if (!allowedPackages.has(packageName)) throw Error("Live project dependency is not an installed public browser package: " + packageName);
        return this.resolve(source, path.join(root, "src", "engine", "__live_resolve__.ts"), { skipSelf: true });
      }
      const candidate = path.resolve(path.dirname(importerPath), clean(source));
      const fromSource = path.relative(sourceRoot, candidate);
      const mapped = fromSource.startsWith("src" + path.sep + "engine" + path.sep)
        ? path.join(root, fromSource) : candidate;
      if (!inside(projectDir, mapped) && !inside(engineRoot, mapped))
        throw Error("Live projects may only import their own source and public engine interfaces");
      const privatePath = file => path.relative(inside(projectDir, file) ? projectDir : engineRoot, file)
        .split(path.sep).some(part => part === ".git" || part === "node_modules" || part.startsWith(".env"));
      if (privatePath(mapped)) throw Error("Live projects cannot import private environment or dependency store files");
      validateRegularWithin(inside(projectDir, mapped) ? projectDir : engineRoot, mapped);
      const resolved = await this.resolve(mapped + source.slice(clean(source).length), importer, { skipSelf: true });
      if (resolved) {
        const resolvedPath = clean(resolved.id);
        if ((!inside(projectDir, resolvedPath) && !inside(engineRoot, resolvedPath)) || privatePath(resolvedPath))
          throw Error("Resolved live project import escapes its allowed source directory");
        validateRegularWithin(inside(projectDir, resolvedPath) ? projectDir : engineRoot, resolvedPath);
      }
      return resolved;
    },
    async load(moduleId) {
      if (moduleId === virtualAssets) {
        this.addWatchFile(marker);
        const { revisions, sizes, kinds } = JSON.parse(fs.readFileSync(marker, "utf8"));
        return "export * from " + JSON.stringify(typesFile) + ";" + previewWorkerRuntime +
          "const revisions=" + JSON.stringify(revisions) + ",sizes=" + JSON.stringify(sizes) + ",kinds=" + JSON.stringify(kinds) + ";" +
          "const base=typeof document==='undefined'?(self.__FRAME_LIVE_ASSET_BASE__||new URL('../',self.location.href).href):new URL('../',import.meta.url).href;" +
          "const parse=(relative)=>{const value=String(relative),match=value.match(/(?:^|\\/)(films\\/" + id + "\\/[^?#]+)(?:\\?([^#]*))?/);let key=match?decodeURIComponent(match[1]):value.replace(/^\\.\\//,'').replace(/^\\//,'');const explicit=match?new URLSearchParams(match[2]||'').get('v'):null;return {key,revision:/^[a-f0-9]{64}$/.test(explicit||'')?explicit:revisions[key]};};" +
          "export const assetUrl=(relative)=>{const {key,revision}=parse(relative);return base+key+(revision?'?v='+revision:'');};" +
          "export const previewAssetUrl=(relative,quality='standard')=>{const {key,revision}=parse(relative);const kind=kinds[key];return revision&&quality!=='high'&&kind?base+kind+'/'+revision+'/'+(quality==='draft'?'economy':'preview'):assetUrl(relative);};";
      }
      if (moduleId !== virtual) {
        const file = clean(moduleId);
        if (inside(projectDir, file) && fs.existsSync(file) && fs.statSync(file).isFile())
          loadedSources.set(file, digest(await fsp.readFile(file)));
        return;
      }
      return "import original from " + JSON.stringify(path.join(projectDir, "project.ts")) + ";" +
        "import {projectSchema} from " + JSON.stringify(path.join(root, "src/engine/types.ts")) + ";" +
        "import {resolveProject} from " + JSON.stringify(path.join(root, "src/engine/resolve-project.ts")) + ";" +
        "const meta=projectSchema.parse(original);" +
        "export default await resolveProject({...meta,load:original.load,loadAudio:original.loadAudio,loadVisual:original.loadVisual,loadAudioDocument:original.loadAudioDocument,loadRemotion:original.loadRemotion});";
    },
    transform(code, file) {
      const filePath = clean(file);
      if (inside(projectDir, filePath)) {
        validateRegularWithin(projectDir, filePath);
        const workerBinding = bindLiveProjectWorkers(code);
        const transformed = remotionProjectAssets(workerBinding?.code || code, path.join(root, "projects", id, path.relative(projectDir, filePath)), root);
        if (transformed) {
          transformed.code = "import {assetUrl as __frameLiveAssetUrl} from 'frame-live-assets';" +
            transformed.code.replace(/return import\.meta\.env\.BASE_URL\+("films\/[^"]+"\+file\.replace[\s\S]*?\.join\("\/"\));/g, "return __frameLiveAssetUrl($1);");
          return transformed;
        }
        return workerBinding;
      }
    },
    async buildStart() { started = performance.now(); onState?.("building"); sourceBefore = await liveSourceInventory(projectDir, id, { dependencies: runtimeDependencies.filter(file => fs.existsSync(clean(file))) }); },
    async writeBundle(_options, bundle) {
      const metadata = await fsp.readFile(path.join(projectDir, "project.ts"), "utf8");
      const declaration = /loadAudio\s*:\s*(?:async\s*)?\(\s*\)\s*=>\s*import\(\s*["']([^"']+)["']\s*\)/.exec(metadata);
      const projectModules = [...new Set([...this.getModuleIds(), ...workerDependencies])].filter(file => inside(projectDir, clean(file)) && fs.existsSync(clean(file)) && fs.statSync(clean(file)).isFile());
      projectModules.forEach(file => this.addWatchFile(clean(file)));
      const roots = declaration ? projectModules.filter(file => {
        const wanted = path.resolve(projectDir, declaration[1]);
        return clean(file) === wanted || [".ts", ".tsx", ".js", ".mjs"].some(extension => clean(file) === wanted + extension);
      }) : projectModules.filter(file => audioFile(path.relative(projectDir, clean(file))) && !clean(file).endsWith("audio.json"));
      const visited = new Set();
      const traverse = file => {
        if (visited.has(file)) return;
        visited.add(file);
        const info = this.getModuleInfo(file);
        for (const imported of [...(info?.importedIds || []), ...(info?.dynamicallyImportedIds || [])])
          if (inside(projectDir, clean(imported))) traverse(imported);
      };
      roots.forEach(traverse);
      // Workers may host audio generators; conservatively version their local dependency graph.
      workerDependencies.forEach(file => visited.add(file));
      const generators = [];
      for (const file of [...visited].sort()) {
        const source = clean(file);
        if (fs.existsSync(source) && fs.statSync(source).isFile()) generators.push([path.relative(projectDir, source), digest(await fsp.readFile(source))]);
      }
      const metadataGraph = this.getModuleInfo(path.join(projectDir, "project.ts"));
      const loadRoots = new Set((metadataGraph?.dynamicallyImportedIds || []).map(clean));
      await queuePublish(bundle, digest(JSON.stringify([declaration?.[1] || null, generators])), projectModules, loadRoots);
    },
    buildEnd(error) { if (error) onError?.(error); },
  };
  const outputBudget = () => ({
    name: "frame-live-output-budget",
    generateBundle: { order: "post", handler(_options, bundle) { return assertLiveBundleBudget(outDir, bundle, maxBundleBytes); } },
  });
  watcher = await build({
    root, configFile: false, envFile: false, publicDir: false, base: "./", logLevel: "silent", cacheDir: path.join(outDir, ".vite"),
    plugins: [restricted, react(), outputBudget()],
    define: { "import.meta.env.VITE_FRAME_PREVIEW_AUDIO": JSON.stringify("0") },
    worker: { format: "iife", plugins: () => [{
      name: "frame-live-worker-scope", enforce: "pre",
      resolveId: restricted.resolveId, transform: restricted.transform,
      async load(moduleId) {
        const result = await restricted.load.call(this, moduleId);
        const file = clean(moduleId);
        if (inside(projectDir, file) && fs.existsSync(file) && fs.statSync(file).isFile()) workerDependencies.add(file);
        return result;
      },
    }, outputBudget()] },
    build: {
      target: "es2022", outDir, emptyOutDir: false, copyPublicDir: false, sourcemap: false,
      minify: "oxc", cssCodeSplit: false, reportCompressedSize: false,
      watch: {
        include: [path.join(projectDir, "**"), marker],
        exclude: [path.join(outDir, ".vite", "**")],
        buildDelay: 80,
        // Vite 8.3 translates this public compatibility field into Rolldown's watcher.
        // Only project modules are polled; runtime/dependencies are immutable for this worker.
        chokidar: { usePolling: process.env.FRAME_LIVE_PREVIEW_POLLING === "1", interval: 250 },
      },
      rolldownOptions: {
        input: { player: path.join(root, "src/live-preview.tsx"), project: "frame-live-project" },
        preserveEntrySignatures: "allow-extension",
        output: {
          format: "es", entryFileNames: "assets/[name]-[hash].js", chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]", strictExecutionOrder: true,
          codeSplitting: { includeDependenciesRecursively: false, groups: [
            // Vite's shared preload helper must not be absorbed by the first optional vendor group.
            { name: "runtime-vite", test: /\0vite[\\/]/, priority: 50 },
            { name: "vendor-zod", test: /node_modules[\\/]zod[\\/]/, priority: 30 },
            { name: "vendor-react", test: /node_modules[\\/](?:react|react-dom|scheduler)(?:[\\/]|$)/, priority: 30 },
            { name: "vendor-three", test: /node_modules[\\/]three[\\/]/, priority: 30 },
            { name: "vendor-remotion", test: /node_modules[\\/](?:@remotion|remotion)[\\/]/, priority: 30 },
            { name: "vendor-babylon", test: /node_modules[\\/]@babylonjs[\\/]/, priority: 30 },
            { name: "vendor-pixi", test: /node_modules[\\/](?:pixi\.js|@pixi)[\\/]/, priority: 30 },
            { name: "vendor-lottie", test: /node_modules[\\/]lottie-web[\\/]/, priority: 30 },
            { name: "vendor-tone", test: /node_modules[\\/](?:tone|standardized-audio-context|automation-events)[\\/]/, priority: 30 },
            { name: "vendor-mediabunny", test: /node_modules[\\/]mediabunny[\\/]/, priority: 30 },
            { name: "vendor-spessasynth", test: /node_modules[\\/]spessasynth_core[\\/]/, priority: 30 },
            { name: "vendor", test: /node_modules[\\/]/, priority: 10, minSize: 20000 },
          ] },
        },
      },
    },
  });
  watcher.on("event", event => { if (event.code === "ERROR") onError?.(event.error); });
  // Binary assets stay outside JS output. Identity changes invalidate a tiny pinned URL module;
  // every old scene/export retains its own map rather than reading a mutable global.
  const watchAssets = () => {
    try {
      assetWatcher = fs.watch(projectDir, { recursive: true }, (_event, name) => {
        if (!name || !String(name).replaceAll("\\", "/").startsWith("public/")) return;
        clearTimeout(assetTimer);
        assetTimer = setTimeout(() => {
          if (closed) return;
          void writeAssets().catch(error => onError?.(error));
        }, 120);
        assetTimer.unref?.();
      });
    } catch (error) { onError?.(error); }
  };
  watchAssets();
  assetPoll = setInterval(() => { if (!closed) void writeAssets().catch(error => onError?.(error)); }, 1500);
  assetPoll.unref();
  return {
    async close() {
      if (closed) return;
      closed = true; clearTimeout(assetTimer); clearInterval(assetPoll); assetWatcher?.close();
      await watcher.close(); await publishQueue;
    },
  };
}
