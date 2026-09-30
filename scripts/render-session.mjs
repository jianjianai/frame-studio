import fs from "node:fs";
import path from "node:path";
import { build, preview } from "vite";
import { launchBrowser } from "./browser.mjs";
import { captureInput } from "./production-input.mjs";
import { projectAssets } from "./project-assets.mjs";
import { readProject } from "./project-metadata.mjs";
import { frameDimensions } from "../src/engine/dimensions.mjs";

/** Each project page has frozen input bytes and a static production build. */
export async function createRenderSession({
  root = process.cwd(),
  width = 1280,
} = {}) {
  let browser;
  const owned = [];
  const inputs = new Map();
  async function close() {
    const failures = [];
    try {
      await browser?.close();
    } catch (error) {
      failures.push(error);
    }
    for (const entry of owned.splice(0).reverse()) {
      try {
        if (entry.server)
          await new Promise((resolve) =>
            entry.server.httpServer.close(resolve),
          );
      } catch (error) {
        failures.push(error);
      }
      try {
        await entry.remotion?.close();
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
  return {
    close,
    input: (id) => inputs.get(id),
    async page(id) {
      const snapshot = captureInput(root, id);
      const entry = { snapshot };
      owned.push(entry);
      inputs.set(id, snapshot.manifest);
      const meta = readProject(
        path.join(snapshot.root, "projects", id, "project.ts"),
      ).meta;
      if (meta.renderer === "remotion")
        entry.remotion = await (
          await import("./remotion-render.mjs")
        ).createRemotionRender({ root: snapshot.root, id, meta, width });
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
        preview: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
      };
      await build(config);
      entry.server = await preview(config);
      browser ??= await launchBrowser();
      const page = await browser.newPage({
        viewport: frameDimensions(
          readProject(path.join(snapshot.root, "projects", id, "project.ts"))
            .meta,
          width,
        ),
        deviceScaleFactor: 1,
      });
      if (entry.remotion) {
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
      const errors = [];
      let cancelledMediaRequests = 0;
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        if (response.status() >= 400)
          errors.push(`${response.status()} ${response.url()}`);
      });
      page.on("requestfailed", (request) => {
        // Seeking/disposal intentionally cancels range prefetch. Target-frame readiness
        // remains authoritative; actual HTTP/decode/render failures still fail export.
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
      });
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
          throw new Error(await page.locator('[role="alert"]').innerText());
        if (errors.length) throw new Error(errors.join("\n"));
        return page;
      } catch (error) {
        await page.close();
        throw error;
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
