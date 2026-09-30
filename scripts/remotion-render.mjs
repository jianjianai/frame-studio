import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { acquireRemotionBundle } from "./remotion-bundle-cache.mjs";
const require = createRequire(import.meta.url);
const webpack = require(
  createRequire(require.resolve("@remotion/bundler")).resolve("webpack"),
);
import {
  openBrowser,
  selectComposition,
  renderStill,
  renderMedia,
  makeCancelSignal,
} from "@remotion/renderer";
import { browserOptions } from "./browser.mjs";
import { compositionSize } from "../src/engine/dimensions.mjs";

async function runtimeIdentity(root) {
  const resolve = createRequire(path.join(root, "package.json"));
  const packages = [];
  for (const name of [
    "@remotion/bundler",
    "@remotion/renderer",
    "remotion",
    "webpack",
    "react",
    "react-dom",
  ]) {
    const resolver =
      name === "webpack"
        ? createRequire(resolve.resolve("@remotion/bundler"))
        : resolve;
    const packageFile = await fs.realpath(
      resolver.resolve(name + "/package.json"),
    );
    packages.push({
      name,
      path: packageFile,
      version: JSON.parse(await fs.readFile(packageFile, "utf8")).version,
    });
  }
  return {
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packages,
  };
}
async function aliasPublic(directory, outDir, id, relative = "") {
  for (const entry of await fs.readdir(path.join(directory, relative), {
    withFileTypes: true,
  })) {
    const name = relative ? relative + "/" + entry.name : entry.name;
    if (entry.isDirectory()) await aliasPublic(directory, outDir, id, name);
    else if (entry.isFile()) {
      const target = path.join(outDir, "films", id, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Both native staticFile and Frame assetUrl address the same frozen bytes.
      await fs.copyFile(
        path.join(directory, name),
        target,
        constants.COPYFILE_FICLONE,
      );
    } else throw Error("Unsupported frozen Remotion public asset");
  }
}

/** Compile once per frozen input/runtime; each renderer owns its browser and cache lease. */
export async function createRemotionRender({
  root,
  id,
  meta,
  width,
  input,
  cacheRoot = root,
  signal,
}) {
  if (!input?.fingerprint)
    throw Error("Remotion renderer requires its frozen input manifest");
  const entry = path.join(root, "remotion-entry.tsx");
  await fs.writeFile(
    entry,
    'import React from "react"; import {Composition,registerRoot} from "remotion";\n' +
      'import project from "./projects/' +
      id +
      '/project";\n' +
      'import {withFrameSubtitles} from "./src/engine/remotion-composition";\n' +
      'project.loadRemotion!().then(({default: Film})=>{ const Yes=withFrameSubtitles(Film,project,true),No=withFrameSubtitles(Film,project,false); const Content=({captions,filmProps})=>React.createElement(captions?Yes:No,filmProps); registerRoot(()=>React.createElement(Composition,{id:"FrameComposition",component:Content,width:' +
      compositionSize(meta).width +
      ",height:" +
      compositionSize(meta).height +
      ",fps:" +
      meta.fps +
      ",durationInFrames:" +
      Math.ceil(meta.duration * meta.fps) +
      ",defaultProps:{captions:true,filmProps:project.remotion?.inputProps??{}}})); });",
  );
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 2,
        project: id,
        fingerprint: input.fingerprint,
        runtime: await runtimeIdentity(root),
        baseUrl: "/",
        publicAliases: true,
      }),
    )
    .digest("hex");
  const cache = await acquireRemotionBundle({
    root: cacheRoot,
    id,
    key,
    signal,
    async build(outDir) {
      await bundle({
        entryPoint: entry,
        rootDir: root,
        outDir,
        publicDir: path.join(root, "projects", id, "public"),
        enableCaching: false,
        logLevel: "error",
        webpackOverride(config) {
          // Frame assetUrl() and web workers keep the same URL conventions in native bundles.
          config.plugins = [
            ...(config.plugins ?? []),
            new webpack.DefinePlugin({
              "import.meta.env.BASE_URL": JSON.stringify("/"),
            }),
          ];
          return config;
        },
      });
      await aliasPublic(path.join(root, "projects", id, "public"), outDir, id);
    },
  });
  const serveUrl = cache.directory;
  const browserExecutable = browserOptions().executablePath;
  const chromiumOptions = { gl: "angle", enableMultiProcessOnLinux: true };
  let browser;
  const cancellation = makeCancelSignal();
  const abort = () => cancellation.cancel();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    browser = await openBrowser("chrome", {
      browserExecutable,
      chromiumOptions,
    });
    const base = {
      serveUrl,
      browserExecutable,
      puppeteerInstance: browser,
      chromiumOptions,
      logLevel: "error",
      cancelSignal: cancellation.cancelSignal,
    };
    const composition = await selectComposition({
      ...base,
      id: "FrameComposition",
    });
    const props = (captions) => ({
      captions,
      filmProps: meta.remotion?.inputProps ?? {},
    });
    let closed = false,
      closing;
    const operations = new Set();
    function run(operation) {
      if (closed) throw Error("Remotion renderer is closed");
      const pending = Promise.resolve().then(() => {
        if (closed) throw Error("Remotion renderer is closed");
        signal?.throwIfAborted();
        return operation();
      });
      operations.add(pending);
      pending.finally(() => operations.delete(pending)).catch(() => {});
      return pending;
    }
    return {
      cache: { reused: cache.reused, key: cache.key },
      async still(time, captions = true) {
        const { buffer } = await run(() =>
          renderStill({
            ...base,
            composition: { ...composition, props: props(captions) },
            inputProps: props(captions),
            frame: Math.min(
              composition.durationInFrames - 1,
              Math.floor(time * meta.fps + 1e-7),
            ),
            scale: width / composition.width,
            imageFormat: "png",
          }),
        );
        if (!buffer) throw Error("Remotion returned no still image");
        return buffer;
      },
      async video({ output, start, end, subtitles = true, onProgress }) {
        const first = Math.floor(start * meta.fps + 1e-7),
          last = Math.min(
            composition.durationInFrames - 1,
            Math.ceil(end * meta.fps - 1e-7) - 1,
          );
        await run(() =>
          renderMedia({
            ...base,
            composition: { ...composition, props: props(subtitles) },
            inputProps: props(subtitles),
            outputLocation: output,
            frameRange: [first, last],
            scale: width / composition.width,
            codec: "h264",
            crf: 18,
            pixelFormat: "yuv420p",
            audioCodec: "pcm-16",
            separateAudioTo: output + ".wav",
            enforceAudioTrack: true,
            concurrency: 2,
            onProgress,
            onBrowserLog: (log) => {
              if (log.type === "error") console.error(log.text);
            },
          }),
        );
        return { start: first / meta.fps, audio: output + ".wav" };
      },
      async audio({ output, start, end }) {
        const first = Math.floor(start * meta.fps + 1e-7),
          last = Math.min(
            composition.durationInFrames - 1,
            Math.ceil(end * meta.fps - 1e-7) - 1,
          );
        await run(() =>
          renderMedia({
            ...base,
            composition,
            inputProps: props(false),
            outputLocation: output,
            frameRange: [first, last],
            codec: "wav",
            enforceAudioTrack: true,
            concurrency: 2,
          }),
        );
        return { start: first / meta.fps };
      },
      close() {
        if (closing) return closing;
        closed = true;
        cancellation.cancel();
        signal?.removeEventListener("abort", abort);
        closing = (async () => {
          await Promise.allSettled([...operations]);
          try {
            await browser.close({ silent: true });
          } finally {
            await cache.close();
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    signal?.removeEventListener("abort", abort);
    try {
      await browser?.close({ silent: true });
    } finally {
      await cache.close();
    }
    throw error;
  }
}
