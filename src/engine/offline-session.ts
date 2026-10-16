import { FrameRenderer } from "./renderer";
import { resolveProject } from "./resolve-project";
import { OfflineAudioRenderer } from "./audio-graph";
import { projectAudioTracks, type AnimationProject, type Quality } from "./types";
import { waitForStudio, type StudioApi } from "./debug";
import { frameDimensions, fitComposition } from "./dimensions.mjs";

const QUALITIES: Quality[] = ["draft", "standard", "high"];

/** Base64 of bytes, in chunks (one String.fromCharCode call would overflow the stack). */
function base64(bytes: Uint8Array) {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

/** Production entry without a studio registry, UI, HMR, or playback clock. */
export async function installOffline(project: AnimationProject) {
  project=await resolveProject(project);
  const query = new URLSearchParams(location.search);
  const requested = query.get("width");
  let { width, height } = frameDimensions(project, requested ? Number(requested) : fitComposition(project, 1280).width);
  // The studio preview draws at "standard": timing measured for playback asks for it.
  let quality: Quality = QUALITIES.find((item) => item === query.get("quality")) ?? "high";
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const renderer = new FrameRenderer(canvas, project);
  const audio = new Map<string, OfflineAudioRenderer>();
  let time = 0;
  const api: StudioApi = {
    ready: false,
    projectId: project.id,
    duration: project.duration,
    async frame(t, subtitles = false) {
      if (!Number.isFinite(t) || t < 0 || t > project.duration)
        throw new Error("Invalid frame time");
      time = t;
      await renderer.render(t, subtitles);
    },
    async seek(t) {
      await this.frame(t);
    },
    async play() {},
    pause() {},
    getState: () => ({
      time,
      playing: false,
      rate: 1,
      loop: false,
      audioState: "offline",
      width,
      height,
    }),
    dataURL: () => renderer.dataURL(),
    capture: (region) => renderer.capture(region),
    luma: async () => base64(await renderer.luma()),
    async resize(nextWidth, nextQuality = quality) {
      const size = frameDimensions(project, nextWidth);
      if (size.width === width && size.height === height && nextQuality === quality) return size;
      // A new scene at the new size; the page and its modules stay (no reload, no recompiling).
      const prepared = await renderer.prepareProject(project, { ...size, quality: nextQuality, time: () => time, subtitles: () => false });
      if (!prepared.commit()) throw new Error("Resize superseded");
      ({ width, height } = size);
      quality = nextQuality;
      return size;
    },
    async waitUntilReady(options = {}) {
      await waitForStudio(api, options);
      if (options.audio)
        await api.audioChunk!(time, Math.min(0.25, project.duration - time));
    },
    async captureAt(t, options = {}) {
      await waitForStudio(api, options);
      await api.frame(t, options.subtitles);
      await api.waitUntilReady!(options);
      return {
        time,
        dataURL: await api.capture!(),
        diagnostics: api.getDiagnostics!(),
      };
    },
    getDiagnostics: () => ({
      ...renderer.diagnostics(),
      audio: { state: "offline" },
    }),
    getParameters: () => renderer.parameters(),
    async setParameters(values) {
      renderer.setParameters(values);
      await renderer.render(time);
    },
    async setOverlay(enabled) {
      renderer.setOverlay(enabled);
      await renderer.render(time);
    },
    async audioChunk(start, duration, trackId, format) {
      const key = trackId ?? "__mix__";
      const tracks = projectAudioTracks(project);
      if (trackId && !tracks.some((t) => t.id === trackId||t.channel===trackId))
        throw new Error("Unknown audio track");
      if (!audio.has(key))
        audio.set(
          key,
          new OfflineAudioRenderer(
            project,
            new Map(
              tracks.map((t) => [
                t.id,
                {
                  gain: t.gain ?? 1,
                  muted:
                    Boolean(t.muted) || Boolean(trackId && t.id !== trackId && t.channel!==trackId),
                },
              ]),
            ),
          ),
        );
      return audio.get(key)!.pcm(start, duration,format);
    },
  };
  window.__FRAME_STUDIO__ = api;
  addEventListener(
    "pagehide",
    () => {
      for (const item of audio.values()) item.dispose();
      renderer.dispose();
    },
    { once: true },
  );
  try {
    await renderer.init(width, height, quality);
    // Import the audio module now: a first import can make the dev server
    // re-optimize dependencies and reload, which is only safe before ready.
    await project.loadAudio?.();
    await document.fonts.ready;
    api.ready = true;
  } catch (error) {
    const alert = document.createElement("p");
    alert.role = "alert";
    alert.textContent = String(error);
    document.body.append(alert);
    throw error;
  }
}
