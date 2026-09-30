import { FrameRenderer } from "./renderer";
import { resolveProject } from "./resolve-project";
import { OfflineAudioRenderer } from "./audio-graph";
import { projectAudioTracks, type AnimationProject } from "./types";
import { waitForStudio, type StudioApi } from "./debug";
import { frameDimensions, fitComposition } from "./dimensions.mjs";

/** Production entry without a studio registry, UI, HMR, or playback clock. */
export async function installOffline(project: AnimationProject) {
  project=await resolveProject(project);
  const requested = new URLSearchParams(location.search).get("width");
  const { width, height } = frameDimensions(project, requested ? Number(requested) : fitComposition(project, 1280).width);
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
    capture: () => renderer.capture(),
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
      audio: { state: "offline", bufferedRanges: null },
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
    await renderer.init(width, height, "high");
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
