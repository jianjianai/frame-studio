import fs from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { appRoot } from "./config.mjs";
import { inside } from "./util.mjs";

/**
 * One Vite dev server compiles the studio UI (in dev) and every opened work.
 * Works are imported by absolute path (/@fs/...). When a work file changes,
 * Vite's full reload is suppressed: the changed modules are invalidated with a
 * fresh timestamp and a `preview-update` event lets the stage re-import the
 * project and swap it into the running player without losing the playhead.
 */
export async function createPreview({ config, httpServer, events }) {
  const roots = [config.dirs.works, config.dirs.tmp];
  const pending = new Map();
  const workOf = (file) => {
    for (const base of roots) {
      if (!inside(base, file)) continue;
      const [repo, id] = path.relative(base, file).split(path.sep);
      if (repo && id) return { key: base === config.dirs.tmp ? `snapshot:${repo}/${id}` : `${repo}/${id}`, repo, id };
    }
    return null;
  };
  const flush = (key) => {
    const entry = pending.get(key);
    pending.delete(key);
    events.emit({ type: "preview-update", work: entry.work.id, repo: entry.work.repo, timestamp: entry.timestamp, files: [...entry.files] });
  };
  const queue = (work, file, timestamp) => {
    let entry = pending.get(work.key);
    if (!entry) {
      entry = { work, files: new Set(), timestamp, timer: null };
      pending.set(work.key, entry);
    }
    entry.files.add(file);
    entry.timestamp = Math.max(entry.timestamp, timestamp);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flush(work.key), 120);
  };

  // Plugins add module resolution for works here (material library code: @materials/…).
  const importResolvers = [];
  const worksPlugin = {
    name: "frame-works",
    async resolveId(source, importer) {
      for (const resolve of importResolvers) {
        const found = await resolve(source, importer);
        if (found) return found;
      }
      return null;
    },
    hotUpdate({ file, modules, timestamp }) {
      const work = workOf(file);
      if (!work) return;
      const seen = new Set();
      for (const mod of modules) this.environment.moduleGraph.invalidateModule(mod, seen, timestamp, true);
      queue(work, file, timestamp);
      return [];
    },
  };

  const vite = await createServer({
    root: appRoot,
    configFile: false,
    appType: "custom",
    logLevel: config.dev ? "info" : "warn",
    clearScreen: false,
    plugins: [react(), worksPlugin],
    cacheDir: path.join(config.home, "tmp", "vite-cache"),
    resolve: { preserveSymlinks: false },
    server: {
      middlewareMode: true,
      // Any domain may reach the studio (reverse proxies, tunnels); our own guard in http.mjs
      // still rejects foreign Host headers when the studio runs on loopback without a password.
      allowedHosts: true,
      hmr: { server: httpServer },
      fs: { strict: true, allow: [appRoot, ...roots] },
      watch: {
        ignored: ["**/.git/**", "**/exports/**", "**/.cache/**", "**/test-results/**", path.join(config.home, "tmp", "vite-cache") + "/**"],
      },
    },
    optimizeDeps: {
      entries: ["src/preview/stage.ts", "src/preview/render.ts", ...(config.dev ? ["web/main.tsx"] : [])],
      include: ["tone", "react", "react-dom", "react-dom/client", "three", "pixi.js", "gsap", "zod"],
    },
    worker: { format: "es" },
    build: { target: "es2022" },
  });

  /** Serve an HTML entry through Vite so it gets the module graph and HMR client. */
  async function html(url, file) {
    const source = await fs.promises.readFile(path.join(appRoot, file), "utf8");
    return vite.transformIndexHtml(url, source);
  }

  /** Path that the stage imports to load a work's project.ts. */
  const moduleUrl = (file) => "/@fs" + (file.startsWith("/") ? "" : "/") + file.split(path.sep).join("/");

  return {
    vite,
    middleware: vite.middlewares,
    html,
    moduleUrl,
    importResolvers,
    /** Drop compiled modules of a work now, without waiting for the file watcher (used after batch rewrites). */
    invalidateWork(work) {
      const timestamp = Date.now();
      for (const environment of Object.values(vite.environments)) {
        const seen = new Set();
        for (const mod of environment.moduleGraph.idToModuleMap.values())
          if (mod.file && inside(work.root, mod.file)) environment.moduleGraph.invalidateModule(mod, seen, timestamp, true);
      }
    },
    /** Asset changes are not in the module graph; the work watcher reports them here. */
    assetsChanged(work, files) {
      for (const file of files) queue({ key: `${work.repo}/${work.id}`, repo: work.repo, id: work.id }, file, Date.now());
    },
    close: () => vite.close(),
  };
}
