import fs from "node:fs/promises";
import path from "node:path";
import { command } from "./process.mjs";
import { fileURLToPath } from "node:url";
import { framePng } from "../scripts/render-session.mjs";
import { readProject } from "../scripts/project-metadata.mjs";
import { runtimeIdentity } from "../scripts/runtime-identity.mjs";
import { confinedAsync, treeHash } from "./project-files.mjs";
import { validateProject } from "./project-validation.mjs";

/** Compile in place and serve original media. Only disposable Vite caches are written. */
export async function createWorkspaceProbeSession({ root, width = 320, signal }) {
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const { projectAssets } = await import("../scripts/project-assets.mjs");
  const { launchBrowser } = await import("../scripts/browser.mjs");
  const core = fileURLToPath(new URL("../", import.meta.url));
  let server, browser, page, cache, closed = false;
  const abort = () => { void page?.close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  return {
    async page(project) {
      signal?.throwIfAborted();
      cache = path.join(root, "projects", project, ".cache", "validation", "vite-" + process.pid);
      const entry = "\0frame-validation-entry";
      server = await createServer({ root, configFile: false, envFile: false, publicDir: false, logLevel: "silent", cacheDir: cache,
        plugins: [projectAssets({ project }), react(), {
          name: "frame-workspace-validation", resolveId: id => id === "/@frame-validation-entry.js" ? entry : null,
          load: id => id === entry ? "import project from " + JSON.stringify(path.join(root, "projects", project, "project.ts")) + ";" +
            "import {installOffline} from " + JSON.stringify(path.join(core, "src/engine/offline-session.ts")) + ";await installOffline(project);" : null,
          configureServer: instance => { instance.middlewares.use((req, res, next) => {
            if (req.url?.split("?")[0] !== "/") return next();
            res.setHeader("Content-Type", "text/html");
            res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#000}canvas{display:block}</style><script type="module" src="/@frame-validation-entry.js"></script>');
          }); },
        }],
        server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, fs: { allow: [root, core] }, watch: null },
      });
      await server.listen();
      signal?.throwIfAborted();
      browser = await launchBrowser();
      signal?.throwIfAborted();
      page = await browser.newPage({ viewport: { width, height: 320 }, deviceScaleFactor: 1 });
      const errors = [];
      page.on("pageerror", error => errors.push(String(error.message)));
      page.frameDiagnostics = () => ({ errors });
      await page.goto("http://127.0.0.1:" + server.httpServer.address().port + "/?width=" + width);
      await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready === true, null, { timeout: 60000 });
      signal?.throwIfAborted();
      return page;
    },
    async close() {
      if (closed) return; closed = true;
      signal?.removeEventListener("abort", abort);
      await Promise.allSettled([page?.close(), browser?.close(), server?.close()]);
      if (cache) await fs.rm(cache, { recursive: true, force: true });
    },
  };
}

/** Probe the actual shared browser renderer and short float audio; never encode a movie. */
export async function probeAiRuntime({
  work,
  project,
  signal,
  sessionFactory = createWorkspaceProbeSession,
}) {
  const { meta } = readProject(
    path.join(work, "projects", project, "project.ts"),
  );
  const session = await sessionFactory({ root: work, width: 320, signal });
  let page;
  const samples = [];
  try {
    page = await session.page(project, { purpose: "media" });
    for (const at of [...new Set([0, meta.duration / 2])]) {
      signal?.throwIfAborted();
      const png = meta.renderer === "remotion" && page.screenshot
        ? (await page.evaluate(at => window.__FRAME_STUDIO__.frame(at, false), at), await page.screenshot({ type: "png" }))
        : await framePng(page, at, false);
      if (
        png.length < 8 ||
        !png
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw Error("Runtime frame did not produce PNG bytes");
      const duration = Math.min(0.125, meta.duration - at);
      if (duration <= 0) continue;
      const encoded = await page.evaluate(
        ({ at, duration }) =>
          window.__FRAME_STUDIO__.audioChunk(
            at,
            duration,
            undefined,
            "float32",
          ),
        { at, duration },
      );
      const pcm = Buffer.from(encoded, "base64");
      if (!pcm.length || pcm.length % 8)
        throw Error("Runtime audio has invalid stereo float32 length");
      for (let offset = 0; offset < pcm.length; offset += 4)
        if (!Number.isFinite(pcm.readFloatLE(offset)))
          throw Error("Runtime audio contains non-finite samples");
      samples.push({
        time: at,
        duration,
        audioFrames: pcm.length / 8,
        pngBytes: png.length,
      });
      const errors = page.frameDiagnostics?.().errors || [];
      if (errors.length)
        throw Error("Runtime probe failed: " + errors.join("\n"));
    }
    return { status: "passed", width: 320, samples };
  } finally {
    try {
      await page?.close();
    } finally {
      await session.close();
    }
  }
}

function boundedRun(work, signal) {
  return (bin, args) =>
    command(bin, args, {
      cwd: work,
      signal,
      timeout: 120000,
      max: 8 * 1024 * 1024,
    });
}

/** Reports describe the sole workspace revision; concurrent saves invalidate the report. */
export async function validateAiWorkspace({
  core,
  work,
  project,
  baselineCommit,
  fingerprint,
  modeFingerprint,
  runtimeFingerprint,
  signal,
  run = boundedRun(work, signal),
  runtimeProbe = probeAiRuntime,
}) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(project) || project.length > 64)
    throw Error("Invalid Ai project identity");
  if (!/^[a-f0-9]{40}$/.test(baselineCommit || ""))
    throw Error("Workspace validation needs an actual Git baseline commit");
  const source = await confinedAsync(work, "projects/" + project);
  const before = await treeHash(source);
  const beforeMode = await treeHash(source, { includeExecutableMode: true });
  if (
    (fingerprint && before !== fingerprint) ||
    (modeFingerprint && beforeMode !== modeFingerprint)
  )
    throw Error("Workspace source changed before validation");
  const runtime = await runtimeIdentity(core);
  if (runtimeFingerprint && runtime.fingerprint !== runtimeFingerprint)
    throw Error("Workspace validator runtime differs from the recorded runtime");
  const validation = [],
    metrics = {};
  const measured = async (name, callback, { check = false } = {}) => {
    signal?.throwIfAborted();
    const started = performance.now();
    try {
      const value = await callback();
      metrics[name] = Math.round(performance.now() - started);
      if (check)
        validation.push({ name, status: "passed", durationMs: metrics[name] });
      return value;
    } catch (error) {
      metrics[name] = Math.round(performance.now() - started);
      if (check)
        validation.push({ name, status: "failed", durationMs: metrics[name] });
      throw error;
    }
  };
  try {
    await validateProject({ core, work, project, baselineCommit, run, measured });
    const probe = await measured("runtime", () => runtimeProbe({ work, project, signal }), { check: true });
    const after = await treeHash(source, { includeExecutableMode: true });
    return { status: "passed", previewMode: "live", fingerprint: before, modeFingerprint: beforeMode,
      runtime, runtimeFingerprint: runtime.fingerprint, validation, metrics, probe, stale: after !== beforeMode };
  } catch (error) {
    signal?.throwIfAborted();
    const after = await treeHash(source, { includeExecutableMode: true }).catch(() => null);
    return { status: "failed", error: String(error.message).slice(0, 2000), fingerprint: before, modeFingerprint: beforeMode,
      runtimeFingerprint: runtime.fingerprint, validation, metrics, stale: after !== beforeMode };
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const work = process.cwd();
  const cancellation = new AbortController();
  const stop = () => cancellation.abort(Error("Validation cancelled"));
  process.once("SIGTERM", stop);
  const timeout = setTimeout(() => cancellation.abort(Error("Workspace validation timed out")), 300000);
  let marker;
  try {
    const input = JSON.parse(process.argv[2]);
    if (!/^[0-9a-f-]{36}$/i.test(input.reportId || "")) throw Error("Invalid validation identity");
    marker = await confinedAsync(work, "projects/" + input.project + "/.cache/validation/" + input.reportId + ".json");
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, JSON.stringify({ reportId: input.reportId, pid: process.pid }), { mode: 0o600, flag: "wx" });
    const result = await validateAiWorkspace({ ...input, core: process.env.FRAME_EXECUTOR_CORE || "/opt/frame", work, signal: cancellation.signal });
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: "failed", error: String(error.message).slice(0, 2000) }));
  } finally {
    clearTimeout(timeout); process.removeListener("SIGTERM", stop);
    if (marker) await fs.rm(marker, { force: true });
  }
}
