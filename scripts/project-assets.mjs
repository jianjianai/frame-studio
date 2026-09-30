import fs from "node:fs";
import path from "node:path";
import { assetPath, projectPath } from "./project-paths.mjs";
import { readProjectCatalog, validProjectId } from "./project-metadata.mjs";

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
  let root;
  return {
    name: "frame-project-assets",
    enforce: "pre",
    transform(code, id) {
      if (
        project &&
        id.replaceAll("\\", "/").endsWith("/src/projects/index.ts")
      )
        return code.replace(
          /const modules = import\.meta\.glob[\s\S]*?\);/,
          `import selected from '../../projects/${project}/project';\nconst modules = { selected: { default: selected } };`,
        );
    },
    configResolved(config) {
      root = config.root;
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
            ".flac":"audio/flac", ".opus":"audio/ogg", ".aac":"audio/aac",
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
    async generateBundle() {
      const banks = [];
      const walk = (dir, prefix) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isSymbolicLink())
            throw new Error("Project assets cannot be symlinks");
          const file = path.join(dir, entry.name),
            name = prefix + "/" + entry.name;
          if (entry.isDirectory()) walk(file, name);
          else {
            this.emitFile({
              type: "asset",
              fileName: name,
              source: fs.readFileSync(file),
            });
            if (/\.sf2$/i.test(name) && fs.statSync(file).size > 1024 * 1024)
              banks.push({ file, name });
          }
        }
      };
      for (const directory of ids ??
        readProjectCatalog(root).map((p) => p.directory))
        walk(
          path.join(root, "projects", directory, "public"),
          "films/" + directory,
        );
      if (banks.length) {
        const { splitSoundfont } = await import("./soundfont-parts.mjs");
        for (const { file, name } of banks) {
          const split = splitSoundfont(fs.readFileSync(file));
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
  };
}
