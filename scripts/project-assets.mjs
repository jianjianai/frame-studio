import fs from "node:fs";
import path from "node:path";
import { assetPath } from "./project-paths.mjs";
import { readProjectCatalog } from "./project-metadata.mjs";

export function assetCatalog(root) {
  return readProjectCatalog(root).flatMap(({ directory }) => {
    const file = path.join(root, "projects", directory, "public/assets.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  });
}

/** Project public files are served/copied directly; no generated source-tree mirror. */
export function projectAssets() {
  let root;
  return {
    name: "frame-project-assets",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0];
        if (url === "/assets.json") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(assetCatalog(root)));
          return;
        }
        if (!url?.startsWith("/films/")) return next();
        try {
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
          };
          res.setHeader(
            "Content-Type",
            types[path.extname(file)] || "application/octet-stream",
          );
          res.setHeader("Content-Length", fs.statSync(file).size);
          fs.createReadStream(file).pipe(res);
        } catch {
          res.statusCode = 403;
          res.end("Invalid project asset");
        }
      });
    },
    generateBundle() {
      const walk = (dir, prefix) => {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isSymbolicLink())
            throw new Error("Project assets cannot be symlinks");
          const file = path.join(dir, entry.name),
            name = prefix + "/" + entry.name;
          if (entry.isDirectory()) walk(file, name);
          else
            this.emitFile({
              type: "asset",
              fileName: name,
              source: fs.readFileSync(file),
            });
        }
      };
      for (const { directory } of readProjectCatalog(root))
        walk(
          path.join(root, "projects", directory, "public"),
          "films/" + directory,
        );
      this.emitFile({
        type: "asset",
        fileName: "assets.json",
        source: JSON.stringify(assetCatalog(root)),
      });
    },
  };
}
