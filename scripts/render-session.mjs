import fs from "node:fs";
import path from "node:path";
import { build, preview } from "vite";
import { launchBrowser } from "./browser.mjs";
import { captureInputAsync } from "./production-input.mjs";
import { projectAssets } from "./project-assets.mjs";
import { readProject } from "./project-metadata.mjs";
import { projectPath, inside } from "./project-paths.mjs";
import { frameDimensions } from "../src/engine/dimensions.mjs";

/** Each page renders frozen bytes. Media-only Remotion sessions prepare Frame audio on demand. */
export async function createRenderSession({
  root = process.cwd(),
  width = 1280,
  cacheRoot = root,
  signal,
} = {}) {
  let browser,
    browserPromise,
    closed = false;
  const owned = [],
    pending = new Set(),
    inputs = new Map();
  const cancellation = new AbortController();
  const abort = () => cancellation.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const stop = cancellation.signal;

  async function close() {
    if (closed) return;
    closed = true;
    cancellation.abort();
    signal?.removeEventListener("abort", abort);
    await Promise.allSettled([...pending]);
    const failures = [];
    try {
      await browser?.close();
    } catch (error) {
      failures.push(error);
    }
    for (const entry of owned.splice(0).reverse()) {
      try {
        if (entry.server)
          await new Promise((resolve, reject) =>
            entry.server.httpServer.close((error) =>
              error ? reject(error) : resolve(),
            ),
          );
      } catch (error) {
        failures.push(error);
      }
      try {
        await entry.remotion?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        entry.snapshot.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Failed to clean up production session",
      );
  }

  async function openPage(id, { purpose = "preview" } = {}) {
    if (!["preview", "media", "visual"].includes(purpose))
      throw Error("Invalid render session purpose");
    stop.throwIfAborted();
    if (
      fs.realpathSync(root) !== fs.realpathSync(cacheRoot) &&
      !inside(
        fs.realpathSync(projectPath(cacheRoot, id)),
        fs.realpathSync(root),
      )
    )
      throw Error(
        "Remotion cache owner must contain this project's frozen workspace",
      );
    const snapshot = await captureInputAsync(root, id);
    if (stop.aborted) {
      snapshot.close();
      stop.throwIfAborted();
    }
    const entry = { snapshot };
    owned.push(entry);
    inputs.set(id, snapshot.manifest);
    const meta = readProject(
      path.join(snapshot.root, "projects", id, "project.ts"),
    ).meta;
    if (meta.renderer === "remotion") {
      entry.remotion = await (
        await import("./remotion-render.mjs")
      ).createRemotionRender({
        root: snapshot.root,
        id,
        meta,
        width,
        input: snapshot.manifest,
        cacheRoot,
        signal: stop,
      });
      stop.throwIfAborted();
    }
    async function prepareFramePage() {
      stop.throwIfAborted();
      if (entry.framePromise) return entry.framePromise;
      entry.framePromise = (async () => {
        fs.writeFileSync(
          path.join(snapshot.root, "index.html"),
          '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><style>body{margin:0;background:#000}canvas{display:block}</style><script type="module" src="/entry.ts"></script>',
        );
        fs.writeFileSync(
          path.join(snapshot.root, "entry.ts"),
          `import project from './projects/${id}/project'; import {installOffline} from './src/engine/offline-session'; installOffline(project);`,
        );
        const config = {
          root: snapshot.root,
          configFile: false,
          logLevel: "error",
          base: "./",
          plugins: [projectAssets()],
          worker: { format: "es" },
          build: { target: "es2022", outDir: "dist", emptyOutDir: true },
          preview: {
            host: "127.0.0.1",
            port: 0,
            strictPort: false,
            open: false,
          },
        };
        await build(config);
        stop.throwIfAborted();
        entry.server = await preview(config);
        browserPromise ??= launchBrowser().then((value) => (browser = value));
        const activeBrowser = await browserPromise;
        stop.throwIfAborted();
        const page = await activeBrowser.newPage({
          viewport: frameDimensions(meta, width),
          deviceScaleFactor: 1,
        });
        entry.framePage = page;
        page.metadata = meta;
        const errors = [];
        let cancelledMediaRequests = 0;
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("response", (response) => {
          if (response.status() >= 400)
            errors.push(`${response.status()} ${response.url()}`);
        });
        page.on("requestfailed", (request) => {
          if (
            request.failure()?.errorText === "net::ERR_ABORTED" &&
            !request.isNavigationRequest() &&
            request.method() === "GET" &&
            new URL(request.url()).pathname.startsWith("/films/" + id + "/") &&
            /\.(webm|mp4)(?:[?#]|$)/i.test(request.url())
          ) {
            cancelledMediaRequests++;
            return;
          }
          errors.push(`${request.failure()?.errorText} ${request.url()}`);
        });
        page.frameDiagnostics = () => ({
          errors: [...errors],
          cancelledMediaRequests,
          input: snapshot.manifest.fingerprint,
          ...(entry.remotion ? { remotionCache: entry.remotion.cache } : {}),
        });
        if (entry.remotion) attachNative(page);
        try {
          await page.goto(
            "http://127.0.0.1:" +
              entry.server.httpServer.address().port +
              "/?width=" +
              width,
            { waitUntil: "networkidle" },
          );
          await page.waitForFunction(
            () =>
              window.__FRAME_STUDIO__?.ready ||
              document.querySelector('[role="alert"]'),
            {},
            { timeout: 60000 },
          );
          if (!(await page.evaluate(() => window.__FRAME_STUDIO__?.ready)))
            throw Error(await page.locator('[role="alert"]').innerText());
          if (errors.length) throw Error(errors.join("\n"));
          stop.throwIfAborted();
          return page;
        } catch (error) {
          await page.close();
          throw error;
        }
      })();
      pending.add(entry.framePromise);
      entry.framePromise
        .finally(() => pending.delete(entry.framePromise))
        .catch(() => {});
      return entry.framePromise;
    }
    function attachNative(page) {
      page.remotion = entry.remotion;
      page.remotionAudio = (file, start, duration, format, nativeOnly) =>
        import("./remotion-export.mjs").then((m) =>
          m.writeRemotionAudio(
            page,
            file,
            start,
            duration,
            meta,
            format,
            nativeOnly,
          ),
        );
    }
    if (entry.remotion && purpose !== "preview") {
      let pageClosed = false;
      const page = {
        metadata: meta,
        frameDiagnostics: () =>
          entry.framePage?.frameDiagnostics() ?? {
            errors: [],
            cancelledMediaRequests: 0,
            input: snapshot.manifest.fingerprint,
            remotionCache: entry.remotion.cache,
          },
        async evaluate(...args) {
          if (purpose === "visual")
            throw Error(
              "Visual-only Remotion session does not prepare Frame audio",
            );
          if (pageClosed) throw Error("Render page is closed");
          return (await prepareFramePage()).evaluate(...args);
        },
        async close() {
          if (pageClosed) return;
          pageClosed = true;
          try {
            await entry.framePage?.close();
          } finally {
            await entry.remotion.close();
          }
        },
      };
      attachNative(page);
      return page;
    }
    return prepareFramePage();
  }

  return {
    close,
    input: (id) => inputs.get(id),
    async page(id, options) {
      if (closed) throw Error("Render session is closed");
      const opening = openPage(id, options);
      pending.add(opening);
      try {
        return await opening;
      } finally {
        pending.delete(opening);
      }
    },
  };
}
export async function framePng(page, time, subtitles = true) {
  if (page.remotion) return page.remotion.still(time, subtitles);
  const data = await page.evaluate(
    async ({ time, subtitles }) => {
      await window.__FRAME_STUDIO__.frame(time, subtitles);
      return window.__FRAME_STUDIO__.dataURL().split(",")[1];
    },
    { time, subtitles },
  );
  const errors = page.frameDiagnostics?.().errors ?? [];
  if (errors.length) throw new Error(errors.join("\n"));
  return Buffer.from(data, "base64");
}
