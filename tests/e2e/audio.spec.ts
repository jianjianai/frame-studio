import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type {
  AnimationProject,
  GeneratedAudioOptions,
} from "../../src/engine/types";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
let server: ViteDevServer, origin: string;
test.beforeAll(async () => {
  server = await createServer({
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const address = server.httpServer!.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
});

test("slow browser rendering preserves every frame and cancellation releases the export scene", async ({
  page,
}) => {
  await page.goto(origin + "/?render=tiny-seed&width=320");
  await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
  const result = await page.evaluate(async () => {
    const moduleURL = "/src/engine/browser-export.ts",
      projectURL = "/projects/tiny-seed/project.ts";
    const { exportWebm } = await import(moduleURL);
    const { default: original } = await import(projectURL);
    HTMLCanvasElement.prototype.captureStream = () => {
      throw new Error("Realtime capture forbidden");
    };
    let disposed = 0;
    const project: AnimationProject = {
      ...original,
      duration: 1,
      fps: 12,
      audio: undefined,
      audioTracks: [],
      async load() {
        return {
          createScene({ width, height, quality }) {
            if (quality !== "high")
              throw new Error("Export inherited draft quality");
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d")!;
            return {
              canvas,
              render(time) {
                const began = performance.now();
                while (performance.now() - began < 100) {
                  /* slower than a 12 fps deadline */
                }
                const frame = Math.round(time * 12);
                context.fillStyle = `rgb(${10 + frame * 18}, 40, 80)`;
                context.fillRect(0, 0, width, height);
              },
              dispose() {
                disposed++;
              },
            };
          },
        };
      },
    };
    const abort = new AbortController();
    let canceled = false;
    try {
      await exportWebm(project, {
        width: 320,
        fps: 12,
        subtitles: false,
        signal: abort.signal,
        onProgress: ({ completed }: { completed: number }) => {
          if (completed === 2) abort.abort();
        },
      });
    } catch (error) {
      canceled = (error as Error).name === "AbortError";
    }
    const afterCancel = disposed;
    const blob = await exportWebm(project, {
      width: 320,
      fps: 12,
      subtitles: false,
      signal: new AbortController().signal,
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let data = "";
    for (let i = 0; i < bytes.length; i += 8192)
      data += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { data: btoa(data), canceled, afterCancel, disposed };
  });
  expect(result).toMatchObject({ canceled: true, afterCancel: 1, disposed: 2 });
  const file = test.info().outputPath("slow-frames.webm");
  await fs.writeFile(file, Buffer.from(result.data, "base64"));
  const probe = JSON.parse(
    (
      await promisify(execFile)(
        process.env.FFPROBE_PATH || "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_frames",
          "-of",
          "json",
          file,
        ],
        { windowsHide: true },
      )
    ).stdout,
  );
  expect(probe.frames).toHaveLength(12);
  probe.frames.forEach(
    (frame: { best_effort_timestamp_time: string }, index: number) =>
      expect(Number(frame.best_effort_timestamp_time)).toBeCloseTo(
        index / 12,
        2,
      ),
  );
  const pixels = (
    await promisify(execFile)(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-vf",
        "scale=1:1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { encoding: "buffer", windowsHide: true },
    )
  ).stdout;
  expect(pixels.length).toBe(12 * 3);
  for (let frame = 0; frame < 12; frame++)
    expect(Math.abs(pixels[frame * 3] - (10 + frame * 18))).toBeLessThan(6);
});

test("a project-only generated soundtrack exports through CLI and browser without prebuilt WAV", async ({
  page,
}) => {
  test.setTimeout(60000);
  const id = "audio-test-" + randomUUID().slice(0, 8);
  const parent = path.resolve("projects"),
    folder = path.join(parent, id);
  const run = (script: string, args: string[]) =>
    promisify(execFile)(process.execPath, [path.resolve(script), ...args], {
      windowsHide: true,
      timeout: 45000,
    });
  let created = false;
  try {
    await run("scripts/new-animation.mjs", [
      id,
      "音频导出验证",
      "--renderer",
      "canvas",
    ]);
    created = true;
    let source = await fs.readFile(path.join(folder, "project.ts"), "utf8");
    source = source
      .replace('"duration": 24', '"duration": 1')
      .replace(
        ", load:",
        ", audioTracks: [{ id: 'melody', name: '旋律', kind: 'generated', gain: 0.6 }, { id: 'pulse', name: '节奏', kind: 'generated', gain: 0.4 }], loadAudio: () => import('./audio'), load:",
      );
    await fs.writeFile(path.join(folder, "project.ts"), source);
    await run("scripts/check-projects.mjs", [id, "--strict"]);
    await run("scripts/render.mjs", [
      id,
      "--frame",
      "12",
      "--fps",
      "24",
      "--width",
      "320",
    ]);
    const png = path.join(folder, "exports/frame-0.500000.png");
    expect(await sharp(png).metadata()).toMatchObject({
      width: 320,
      height: 180,
      format: "png",
    });
    await run("scripts/film.mjs", [
      "storyboard",
      id,
      "--times",
      "0,0.5",
      "--width",
      "320",
    ]);
    const board = path.join(folder, "exports/storyboard.png");
    expect(await sharp(board).metadata()).toMatchObject({
      width: 640,
      height: 216,
    });
    const boardReport = JSON.parse(await fs.readFile(board + ".json", "utf8"));
    expect(
      boardReport.frames.map((frame: { time: number }) => frame.time),
    ).toEqual([0, 0.5]);
    await expect(run("scripts/film.mjs", ["storyboard", id])).rejects.toThrow(
      /Output exists/,
    );
    await expect(
      run("scripts/film.mjs", [
        "storyboard",
        id,
        "--out",
        path.resolve("projects/tiny-seed/exports/forbidden.png"),
      ]),
    ).rejects.toThrow(/inside projects/);
    const mp4 = path.join(folder, "exports/generated.mp4");
    await run("scripts/render.mjs", [
      id,
      "--width",
      "320",
      "--fps",
      "12",
      "--out",
      mp4,
    ]);
    const report = JSON.parse(await fs.readFile(mp4 + ".render.json", "utf8"));
    expect(report.frames).toBe(12);
    expect(
      report.ffprobe.streams.some(
        (stream: { codec_type: string }) => stream.codec_type === "audio",
      ),
    ).toBe(true);
    // Decode the delivered AAC, so a silent/missing generated mix cannot pass on stream metadata alone.
    const decoded = await promisify(execFile)(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        mp4,
        "-f",
        "s16le",
        "-ac",
        "1",
        "-ar",
        "48000",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 1000000, windowsHide: true },
    );
    let energy = 0;
    for (let i = 0; i + 1 < decoded.stdout.length; i += 2)
      energy += (decoded.stdout.readInt16LE(i) / 32768) ** 2;
    expect(Math.sqrt(energy / (decoded.stdout.length / 2))).toBeGreaterThan(
      0.015,
    );
    await page.goto(origin + "/?debug=1#/film/" + id);
    await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
    await expect(page.getByRole("region", { name: "音轨混音" })).toBeVisible();
    await expect(
      page
        .getByText("实时生成", { exact: false })
        .filter({ hasText: "实时生成" }),
    ).toHaveCount(2);
    await page.getByRole("button", { name: "导出作品" }).click();
    expect(
      await page.getByRole("combobox", { name: "导出分辨率" }).inputValue(),
    ).toBe("1920");
    await page.getByRole("combobox", { name: "导出帧率" }).selectOption("12");
    const download = page.waitForEvent("download", { timeout: 30000 });
    await page.getByRole("button", { name: /WebM/ }).click();
    const webm = await download;
    expect((await fs.stat((await webm.path())!)).size).toBeGreaterThan(1000);
    const webmProbe = JSON.parse(
      (
        await promisify(execFile)(
          process.env.FFPROBE_PATH || "ffprobe",
          [
            "-v",
            "error",
            "-count_frames",
            "-show_streams",
            "-of",
            "json",
            (await webm.path())!,
          ],
          { windowsHide: true },
        )
      ).stdout,
    );
    expect(
      webmProbe.streams.find(
        (stream: { codec_type: string }) => stream.codec_type === "video",
      ),
    ).toMatchObject({ width: 1920, height: 1080, nb_read_frames: "12" });
    const browserPCM = await promisify(execFile)(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        (await webm.path())!,
        "-f",
        "s16le",
        "-ac",
        "1",
        "-ar",
        "48000",
        "pipe:1",
      ],
      { encoding: "buffer", maxBuffer: 3000000, windowsHide: true },
    );
    let browserEnergy = 0;
    for (let i = 0; i + 1 < browserPCM.stdout.length; i += 2)
      browserEnergy += (browserPCM.stdout.readInt16LE(i) / 32768) ** 2;
    expect(
      Math.sqrt(browserEnergy / (browserPCM.stdout.length / 2)),
    ).toBeGreaterThan(0.005);
    expect(
      (await fs.readdir(path.join(folder, "public"))).some((name) =>
        name.endsWith(".wav"),
      ),
    ).toBe(false);
    await page.goto("about:blank");
  } catch (error) {
    await test.info().attach("audio-export-state", {
      body: JSON.stringify(
        await page.evaluate(() => ({
          state: window.__FRAME_STUDIO__?.getState(),
          text: document.body.innerText,
        })),
      ),
      contentType: "application/json",
    });
    throw error;
  } finally {
    if (
      created &&
      path.dirname(folder) === parent &&
      path.basename(folder) === id
    )
      await fs.rm(folder, { recursive: true, force: true });
  }
});

test("real Web Audio mixes files and generated tracks with trim, timing, mute and chunk continuity", async ({
  page,
}) => {
  await page.goto(origin + "/?render=tiny-seed&width=320");
  await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
  const result = await page.evaluate(async () => {
    const graphURL = "/src/engine/audio-graph.ts",
      projectURL = "/projects/tiny-seed/project.ts";
    const { OfflineAudioRenderer } = await import(graphURL);
    const { default: original } = await import(projectURL);
    const synth = {
      createAudio({
        context,
        destination,
        when,
        offset,
        duration,
        rate,
      }: GeneratedAudioOptions) {
        const source = context.createBufferSource();
        source.buffer = context.createBuffer(
          1,
          Math.ceil(duration * context.sampleRate),
          context.sampleRate,
        );
        const samples = source.buffer.getChannelData(0);
        for (let i = 0; i < samples.length; i++)
          samples[i] =
            0.1 *
            Math.sin((offset + i / context.sampleRate) * 2 * Math.PI * 437);
        source.playbackRate.value = rate;
        source.connect(destination);
        source.start(when);
        return {
          dispose() {
            source.stop();
            source.disconnect();
          },
        };
      },
    };
    const file = {
      id: "file",
      name: "文件",
      kind: "file",
      src: original.audio,
      gain: 0.3,
    };
    const synthTrack = {
      id: "code",
      name: "代码",
      kind: "generated",
      start: 0.25,
      offset: 0.13,
      duration: 0.6,
      gain: 0.5,
    };
    const meta = {
      ...original,
      audio: undefined,
      loadAudio: async () => synth,
    };
    const decode = (base64: string) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      return new Int16Array(bytes.buffer);
    };
    const render = async (tracks: unknown[]) =>
      decode(
        await new OfflineAudioRenderer({ ...meta, audioTracks: tracks }).pcm(
          0,
          1,
        ),
      );
    const baseline = await render([file]),
      mixed = await render([file, synthTrack]);
    const muted = await render([file, { ...synthTrack, muted: true }]);
    let error = 0,
      silenceError = 0,
      addedPeak = 0;
    for (let i = 0; i < 48000; i++) {
      const time = i / 48000;
      const expected =
        time >= 0.25 && time < 0.85
          ? 0.05 * Math.sin((time - 0.25 + 0.13) * 2 * Math.PI * 437)
          : 0;
      const delta = mixed[i * 2] - baseline[i * 2];
      error = Math.max(error, Math.abs(delta / 32768 - expected));
      addedPeak = Math.max(addedPeak, Math.abs(delta));
      silenceError = Math.max(
        silenceError,
        Math.abs(muted[i * 2] - baseline[i * 2]),
      );
    }
    const renderer = new OfflineAudioRenderer({
      ...meta,
      audioTracks: [file, synthTrack],
    });
    const a = decode(await renderer.pcm(0, 0.5)),
      b = decode(await renderer.pcm(0.5, 0.5));
    let chunkError = 0;
    for (let i = 0; i < mixed.length; i++)
      chunkError = Math.max(
        chunkError,
        Math.abs(mixed[i] - (i < a.length ? a[i] : b[i - a.length])),
      );
    return { error, silenceError, addedPeak, chunkError };
  });
  expect(result.error).toBeLessThan(0.0001);
  expect(result.silenceError).toBe(0);
  expect(result.addedPeak).toBeGreaterThan(1500);
  expect(result.chunkError).toBeLessThanOrEqual(2);
});

test("transport caches decoded audio, reschedules generated voices and disposes on pause and close", async ({
  page,
}) => {
  await page.goto(origin + "/?render=tiny-seed&width=320");
  await page.waitForFunction(() => window.__FRAME_STUDIO__?.ready);
  const result = await page.evaluate(async () => {
    const transportURL = "/src/engine/audio.ts",
      projectURL = "/projects/tiny-seed/project.ts";
    const { AudioTransport } = await import(transportURL);
    const { default: original } = await import(projectURL);
    let active = 0,
      started = 0,
      fetches = 0;
    const originalFetch = window.fetch;
    window.fetch = (...args) => {
      fetches++;
      return originalFetch(...args);
    };
    const project: AnimationProject = {
      ...original,
      audio: undefined,
      duration: 2,
      audioTracks: [
        { id: "file", name: "文件", kind: "file", src: original.audio },
        { id: "code", name: "代码", kind: "generated" },
      ],
      loadAudio: async () => ({
        createAudio({ context, destination, when, duration, rate }) {
          const oscillator = context.createOscillator();
          oscillator.connect(destination);
          oscillator.start(when);
          oscillator.stop(when + duration / rate);
          active++;
          started++;
          return {
            dispose() {
              oscillator.stop();
              oscillator.disconnect();
              active--;
            },
          };
        },
      }),
    };
    const sound = new AudioTransport(project);
    try {
      await sound.play();
      sound.seek(0.5);
      sound.setRate(2);
      sound.setTrack("code", { muted: true });
      const muted = active;
      sound.setTrack("code", { muted: false });
      sound.setLoop(true);
      sound.seek(1.95);
      const beforeLoop = started;
      for (
        let i = 0;
        i < 40 && (started === beforeLoop || sound.clock.time() >= 1);
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      const looped = started > beforeLoop && sound.clock.time() < 1;
      sound.pause();
      const paused = active;
      await sound.play();
      await sound.dispose();
      return {
        fetches,
        active,
        started,
        muted,
        paused,
        looped,
        state: sound.context?.state,
      };
    } finally {
      window.fetch = originalFetch;
      await sound.dispose();
    }
  });
  expect(result.fetches).toBe(1);
  expect(result.started).toBeGreaterThan(5);
  expect(result).toMatchObject({
    active: 0,
    muted: 0,
    paused: 0,
    looped: true,
    state: "closed",
  });
});
