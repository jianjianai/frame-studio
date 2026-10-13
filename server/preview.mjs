import fs from "node:fs";
import path from "node:path";
import { createServer, parseAstAsync } from "vite";
import react from "@vitejs/plugin-react";
import { appRoot } from "./config.mjs";
import { inside, Lru } from "./util.mjs";

/** A module request as Vite's transform middleware sees it: no timestamp, no ?import. */
const requestOf = (url) =>
  decodeURI(url)
    .replace(/(\?|&)t=\d{13}(?:&|$)/, "$1")
    .replace(/[?&]$/, "")
    .replace(/(\?|&)import=?(?:&|$)/, "$1")
    .replace(/[?&]$/, "");

/** The import specifiers of compiled module code, as [url, dynamic]. */
async function importsOf(code) {
  const program = await parseAstAsync(code);
  const found = [];
  for (const node of program.body)
    if (["ImportDeclaration", "ExportAllDeclaration", "ExportNamedDeclaration"].includes(node.type) && typeof node.source?.value === "string")
      found.push([node.source.value, false]);
  if (!code.includes("import(")) return found;
  const stack = [program];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === "ImportExpression") {
      const source = node.source;
      if (source.type === "Literal" && typeof source.value === "string") found.push([source.value, true]);
      else if (source.type === "TemplateLiteral" && !source.expressions.length) found.push([source.quasis[0].value.cooked, true]);
    }
    for (const key in node) {
      const value = node[key];
      if (Array.isArray(value)) for (const item of value) typeof item?.type === "string" && stack.push(item);
      else if (typeof value?.type === "string") stack.push(value);
    }
  }
  return found;
}

/** Whether to follow a dynamic import (an address that cannot be decoded is not followed). */
const followed = (follow, url) => {
  try {
    return follow(url);
  } catch {
    return false;
  }
};

const escapeAttribute = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * One Vite dev server compiles the studio UI (in dev) and every opened work.
 * Works are imported by absolute path (/@fs/...). When a work file changes,
 * Vite's full reload is suppressed: the changed modules are invalidated with a
 * fresh timestamp and a `preview-update` event lets the stage re-import the
 * project and swap it into the running player without losing the playhead.
 */
export async function createPreview({ config, httpServer, events }) {
  const roots = [config.dirs.works, config.dirs.tmp];
  const library = path.join(config.dirs.tmp, "library"); // library code run outside works (resource previews)
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
    // Before Vite's own resolver: pages request library code copies that may not exist yet.
    enforce: "pre",
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
      // No stage runs library code outside works: its pages reload on the materials event.
      if (!inside(library, file)) queue(work, file, timestamp);
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
    resolve: {
      preserveSymlinks: false,
      // Works and library code import the engine the same way from any folder.
      alias: [{ find: /^@frame\/engine\//, replacement: path.join(appRoot, "src", "engine") + "/" }],
    },
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
      entries: ["src/preview/stage.ts", "src/preview/render.ts", "src/preview/resource.ts", "src/preview/asset.ts", ...(config.dev ? ["web/main.tsx"] : [])],
      // What works and library code import through the engine, bundled before the first page needs
      // it (a dependency found later makes Vite reload every page).
      include: [
        "tone",
        "react",
        "react-dom",
        "react-dom/client",
        "zod",
        "pixi.js",
        "pixi.js/unsafe-eval",
        "lottie-web/build/player/lottie_light_canvas",
        ...["gsap", "gsap/CustomBounce", "gsap/CustomEase", "gsap/CustomWiggle", "gsap/MorphSVGPlugin", "gsap/MotionPathPlugin", "gsap/Physics2DPlugin"],
        "three",
        ...[
          "loaders/GLTFLoader.js",
          "loaders/DRACOLoader.js",
          "loaders/KTX2Loader.js",
          "loaders/FBXLoader.js",
          "loaders/OBJLoader.js",
          "loaders/MTLLoader.js",
          "loaders/HDRLoader.js",
          "loaders/EXRLoader.js",
          "libs/meshopt_decoder.module.js",
          "environments/RoomEnvironment.js",
          "postprocessing/EffectComposer.js",
          "postprocessing/RenderPass.js",
          "postprocessing/UnrealBloomPass.js",
          "postprocessing/OutputPass.js",
        ].map((addon) => `three/addons/${addon}`),
      ],
    },
    worker: { format: "es" },
    build: { target: "es2022" },
  });

  /**
   * The modules that importing `entries` brings in, as the URLs the browser requests (Vite's
   * rewritten imports), each with the etag of its compiled code. Static imports are followed
   * everywhere, dynamic ones only where `follow` allows: a work's own scene modules, not
   * optional engine parts such as three or Pixi, which load when a work uses them. Stops
   * after `budget` ms, so a server that still has to compile everything does not hold the
   * page up (the compiling goes on regardless).
   */
  const importLists = new Lru(5000); // etag of compiled code → its imports
  async function moduleGraph(entries, { follow = () => false, budget = 2500 } = {}) {
    const environment = vite.environments.client;
    const deadline = Date.now() + budget;
    const modules = new Map(entries.map((url) => [url, null]));
    let level = [...modules.keys()];
    while (level.length && Date.now() < deadline) {
      const next = [];
      const visit = async (url) => {
        const result = await Promise.resolve()
          .then(() => environment.transformRequest(requestOf(url)))
          .catch(() => null);
        if (!result?.code) return;
        modules.set(url, result.etag ?? null);
        // Compiled code only changes with its etag; big dependencies take long to parse.
        let imports = result.etag && importLists.get(result.etag);
        if (!imports) {
          imports = await importsOf(result.code).catch(() => []);
          if (result.etag) importLists.set(result.etag, imports);
        }
        for (const [specifier, dynamic] of imports) {
          if (!specifier.startsWith("/") || modules.has(specifier) || (dynamic && !followed(follow, specifier))) continue;
          modules.set(specifier, null);
          next.push(specifier);
        }
      };
      let timer;
      const late = new Promise((resolve) => (timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))));
      await Promise.race([Promise.all(level.map(visit)), late]);
      clearTimeout(timer);
      level = next;
    }
    return modules;
  }

  /**
   * The project module a stage plays (`module` of its address) and the library sound modules
   * its audio.json names, as the page imports them: by address, so the browser adds ?import
   * (Vite's injectQuery); dynamic imports are followed inside the work's folder.
   */
  function workModules(module) {
    const address = module?.split("?")[0];
    if (!address?.startsWith("/@fs/")) return null;
    let file = address.slice("/@fs".length);
    if (/^\/[A-Za-z]:\//.test(file)) file = file.slice(1);
    if (!/\/projects\/[^/]+\/project\.tsx?$/.test(file) || !roots.some((base) => inside(base, path.resolve(file)))) return null;
    const root = address.slice(0, address.lastIndexOf("/projects/") + 1);
    const entries = [address + "?import"];
    try {
      const audio = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "audio.json"), "utf8"));
      for (const source of audio.sources ?? [])
        if (source.kind === "generated" && /^materials\/[^/]+\/[^?#]+\.(?:m?[jt]sx?)$/.test(String(source.module)))
          entries.push(root + ".materials/" + source.module.slice("materials/".length).split("/").map(encodeURIComponent).join("/") + "?import");
    } catch {}
    let base;
    try {
      base = requestOf(root);
    } catch {
      return null;
    }
    return { entries, follow: (url) => requestOf(url).startsWith(base) };
  }

  /**
   * Serve an HTML entry through Vite so it gets the module graph and HMR client. A preview
   * page also lists every module it will import (for the stage, the work's too):
   * - as modulepreload links, so the whole graph is fetched, or revalidated, at once instead
   *   of one round trip per level of imports;
   * - with the etag of each, in the page's `frame-cache` data, together with `cache` (the
   *   stage's asset list): the browser's service worker answers unchanged modules from its
   *   own cache without asking the server at all (public/frame-sw.js).
   */
  async function html(url, file, { preload = false, cache = {} } = {}) {
    const source = await fs.promises.readFile(path.join(appRoot, file), "utf8");
    const page = await vite.transformIndexHtml(url, source);
    if (!preload) return page;
    const scripts = [...page.matchAll(/<script type="module"[^>]*\ssrc="(\/[^"]+)"|\bfrom\s*"(\/[^"]+)"/g)].map((match) => match[1] ?? match[2]);
    const work = workModules(new URL(url, "http://local").searchParams.get("module"));
    const graph = await moduleGraph([...scripts, ...(work?.entries ?? [])], { follow: work?.follow });
    const modules = Object.fromEntries([...graph].filter(([, etag]) => etag));
    const data = JSON.stringify({ modules, ...cache }).replace(/</g, "\\u003c");
    const links = [...graph.keys()].filter((href) => !scripts.includes(href)).map((href) => `<link rel="modulepreload" href="${escapeAttribute(href)}" />`);
    return page.replace("</head>", `  <script type="application/json" id="frame-cache">${data}</script>\n    ${links.join("\n    ")}\n  </head>`);
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
    /** A file was rewritten under a page that may load it next: drop its compiled module now, not when the watcher notices. */
    invalidateFile(file) {
      const timestamp = Date.now();
      for (const environment of Object.values(vite.environments)) {
        const seen = new Set();
        for (const mod of environment.moduleGraph.getModulesByFile(file) ?? []) environment.moduleGraph.invalidateModule(mod, seen, timestamp, true);
      }
    },
    /** Asset changes are not in the module graph; the work watcher reports them here. */
    assetsChanged(work, files) {
      for (const file of files) queue({ key: `${work.repo}/${work.id}`, repo: work.repo, id: work.id }, file, Date.now());
    },
    close: () => vite.close(),
  };
}
