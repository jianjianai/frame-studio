import fs from "node:fs";
import { remotionProjectAssets } from "./remotion-project-assets.mjs";
import path from "node:path";
import { assetPath, projectPath } from "./project-paths.mjs";
import { readProjectCatalog, validProjectId } from "./project-metadata.mjs";
import {
  copyProjectAsset,
  readProjectAsset,
  scanProjectAssets,
  writeSoundfontParts,
} from "./project-asset-output.mjs";

export function assetCatalog(root, ids) {
  const selected =
    ids ?? readProjectCatalog(root).map(({ directory }) => directory);
  return selected.flatMap((id) => {
    const file = projectPath(root, id, "public/assets.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  });
}

/** Project public files are served/copied directly; no generated source-tree mirror. */
export function projectAssets({ project } = {}) {
  if (project && !validProjectId(project))
    throw new Error("Invalid FRAME_PROJECT");
  const ids = project ? [project] : undefined;
  let root,
    config,
    files = [],
    inMemory = false;
  return {
    name: "frame-project-assets",
    enforce: "pre",
    transform(code, id) {
      const remotion = remotionProjectAssets(code, id, root);
      if (remotion) return remotion;
      if (
        project &&
        id.replaceAll("\\", "/").endsWith("/src/projects/index.ts")
      )
        return code.replace(
          /const modules = import\.meta\.glob[\s\S]*?\);/,
          `import selected from '../../projects/${project}/project';\nconst modules = { selected: { default: selected } };`,
        );
    },
    configResolved(resolved) {
      config = resolved;
      root = resolved.root;
      inMemory = resolved.build?.write === false;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0];
        if (url === "/assets.json") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(assetCatalog(root, ids)));
          return;
        }
        if (!url?.startsWith("/films/")) return next();
        try {
          if (
            project &&
            !decodeURIComponent(url).startsWith("/films/" + project + "/")
          )
            throw new Error("Asset belongs to another project");
          const file = assetPath(root, decodeURIComponent(url.slice(1)));
          if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.statusCode = 404;
            res.end();
            return;
          }
          const types = {
            ".svg": "image/svg+xml",
            ".json": "application/json",
            ".wav": "audio/wav",
            ".mp3": "audio/mpeg",
            ".webp": "image/webp",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".mp4": "video/mp4",
            ".webm": "video/webm",
            ".ogg": "audio/ogg",
            ".m4a": "audio/mp4",
            ".flac": "audio/flac",
            ".opus": "audio/ogg",
            ".aac": "audio/aac",
          };
          res.setHeader(
            "Content-Type",
            types[path.extname(file)] || "application/octet-stream",
          );
          const size = fs.statSync(file).size;
          res.setHeader("Accept-Ranges", "bytes");
          let start = 0,
            end = size - 1;
          if (req.headers.range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            if (match?.[1]) {
              start = Number(match[1]);
              end = Math.min(match[2] ? Number(match[2]) : end, end);
            } else if (match?.[2]) start = Math.max(0, size - Number(match[2]));
            else start = NaN;
            if (
              !Number.isSafeInteger(start) ||
              !Number.isSafeInteger(end) ||
              start < 0 ||
              start > end ||
              start >= size
            ) {
              res.statusCode = 416;
              res.setHeader("Content-Range", "bytes */" + size);
              res.end();
              return;
            }
            res.statusCode = 206;
            res.setHeader(
              "Content-Range",
              "bytes " + start + "-" + end + "/" + size,
            );
          }
          res.setHeader("Content-Length", size ? end - start + 1 : 0);
          if (req.method === "HEAD" || !size) {
            res.end();
            return;
          }
          const stream = fs.createReadStream(file, { start, end });
          res.once("close", () => stream.destroy());
          stream.on("error", () => res.destroy());
          stream.pipe(res);
        } catch {
          res.statusCode = 403;
          res.end("Invalid project asset");
        }
      });
    },
    async generateBundle(_options, bundle = {}) {
      files = await scanProjectAssets(
        root,
        ids ?? readProjectCatalog(root).map((p) => p.directory),
      );
      for (const asset of files)
        if (Object.hasOwn(bundle, asset.name))
          throw new Error(
            "Project asset conflicts with bundled output: " + asset.name,
          );
      // write:false explicitly asks Rollup for an in-memory bundle. Normal builds
      // keep binary bytes out of Rollup and publish bounded streams in writeBundle.
      if (inMemory) {
        for (const asset of files)
          this.emitFile({
            type: "asset",
            fileName: asset.name,
            source: await readProjectAsset(asset),
          });
        const { splitSoundfont } = await import("./soundfont-parts.mjs");
        for (const asset of files.filter(
          (f) => /\.sf2$/i.test(f.name) && f.size > 1024 * 1024,
        )) {
          const { name } = asset;
          const split = splitSoundfont(await readProjectAsset(asset));
          if (!split) continue;
          this.emitFile({
            type: "asset",
            fileName: name + ".parts/index.json",
            source: JSON.stringify(split.manifest),
          });
          const emitted = new Set();
          for (const part of split.parts)
            if (!emitted.has(part.file)) {
              emitted.add(part.file);
              this.emitFile({
                type: "asset",
                fileName: name + ".parts/" + part.file,
                source: part.bytes,
              });
            }
        }
      }
      this.emitFile({
        type: "asset",
        fileName: "assets.json",
        source: JSON.stringify(assetCatalog(root, ids)),
      });
    },
    async writeBundle(options, bundle) {
      if (inMemory) return;
      const output =
        options.dir || path.resolve(root, config?.build?.outDir || "dist");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (const asset of files) {
        if (Object.hasOwn(bundle, asset.name))
          throw new Error(
            "Project asset conflicts with bundled output: " + asset.name,
          );
        await copyProjectAsset(asset, output, { buffer });
      }
      for (const asset of files.filter(
        (f) => /\.sf2$/i.test(f.name) && f.size > 1024 * 1024,
      )) {
        const parts = asset.name + ".parts/";
        if (
          files.some((f) => f.name.startsWith(parts)) ||
          Object.keys(bundle).some((name) => name.startsWith(parts))
        )
          throw new Error(
            "Soundfont parts conflict with project assets: " + parts,
          );
        await writeSoundfontParts(
          path.join(output, asset.name),
          path.join(output, asset.name + ".parts"),
          { buffer },
        );
      }
    },
  };
}
