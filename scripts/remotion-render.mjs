import fs from "node:fs/promises";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const webpack = require(
  createRequire(require.resolve("@remotion/bundler")).resolve("webpack"),
);
import {
  openBrowser,
  selectComposition,
  renderStill,
  renderMedia,
} from "@remotion/renderer";
import { browserOptions } from "./browser.mjs";
import { compositionSize } from "../src/engine/dimensions.mjs";

/** Native Remotion bundle lives inside the caller's frozen, project-owned snapshot. */
export async function createRemotionRender({ root, id, meta, width }) {
  const entry = path.join(root, "remotion-entry.tsx"),
    outDir = path.join(root, "remotion-bundle");
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
  const serveUrl = await bundle({
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
  await fs.mkdir(path.join(outDir, "films"), { recursive: true });
  await fs.cp(
    path.join(root, "projects", id, "public"),
    path.join(outDir, "films", id),
    { recursive: true },
  );
  const browserExecutable = browserOptions().executablePath;
  const chromiumOptions = { gl: "angle", enableMultiProcessOnLinux: true };
  let browser;
  try {
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
    };
    const composition = await selectComposition({
      ...base,
      id: "FrameComposition",
    });
    const props = (captions) => ({
      captions,
      filmProps: meta.remotion?.inputProps ?? {},
    });
    let closed = false;
    return {
      async still(time, captions = true) {
        const { buffer } = await renderStill({
          ...base,
          composition: { ...composition, props: props(captions) },
          inputProps: props(captions),
          frame: Math.min(
            composition.durationInFrames - 1,
            Math.floor(time * meta.fps + 1e-7),
          ),
          scale: width / composition.width,
          imageFormat: "png",
        });
        if (!buffer) throw Error("Remotion returned no still image");
        return buffer;
      },
      async video({ output, start, end, subtitles = true, onProgress }) {
        const first = Math.floor(start * meta.fps + 1e-7),
          last = Math.min(
            composition.durationInFrames - 1,
            Math.ceil(end * meta.fps - 1e-7) - 1,
          );
        await renderMedia({
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
        });
        return { start: first / meta.fps, audio: output + ".wav" };
      },
      async audio({ output, start, end }) {
        const first = Math.floor(start * meta.fps + 1e-7),
          last = Math.min(
            composition.durationInFrames - 1,
            Math.ceil(end * meta.fps - 1e-7) - 1,
          );
        await renderMedia({
          ...base,
          composition,
          inputProps: props(false),
          outputLocation: output,
          frameRange: [first, last],
          codec: "wav",
          enforceAudioTrack: true,
          concurrency: 2,
        });
        return { start: first / meta.fps };
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await browser.close({ silent: true });
      },
    };
  } catch (error) {
    await browser?.close({ silent: true });
    throw error;
  }
}
