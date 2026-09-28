import { FrameRenderer } from "./renderer";
import { OfflineAudioRenderer } from "./audio-graph";
import { projectAudioTracks, type AnimationProject } from "./types";
import { waitForStudio, type StudioApi } from "./debug";

/** Production entry without a studio registry, UI, HMR, or playback clock. */
export async function installOffline(project: AnimationProject) {
  const width = Number(
    new URLSearchParams(location.search).get("width") ?? 1280,
  );
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const renderer = new FrameRenderer(canvas, project);
  const audio = new Map<string, OfflineAudioRenderer>();
  let time = 0;
  const api: StudioApi = {
    ready: false,
    projectId: project.id,
    duration: project.duration,
    frame(t, subtitles = false) {
      if (!Number.isFinite(t) || t < 0 || t > project.duration)
        throw new Error("Invalid frame time");
      time = t;
      renderer.render(t, subtitles);
    },
    seek(t) {
      this.frame(t);
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
      height: (width * 9) / 16,
    }),
    dataURL: () => canvas.toDataURL("image/png"),
    async waitUntilReady(options = {}) {
      await waitForStudio(api, options);
      if (options.audio)
        await api.audioChunk!(time, Math.min(0.25, project.duration - time));
    },
    async captureAt(t, options = {}) {
      await waitForStudio(api, options);
      api.frame(t, options.subtitles);
      await api.waitUntilReady!(options);
      return {
        time,
        dataURL: api.dataURL(),
        diagnostics: api.getDiagnostics!(),
      };
    },
    getDiagnostics: () => ({
      ...renderer.diagnostics(),
      audio: { state: "offline", bufferedRanges: null },
    }),
    getParameters: () => renderer.parameters(),
    setParameters(values) {
      renderer.setParameters(values);
      renderer.render(time);
    },
    setOverlay(enabled) {
      renderer.setOverlay(enabled);
      renderer.render(time);
    },
    async audioChunk(start, duration, trackId) {
      const key = trackId ?? "__mix__";
      const tracks = projectAudioTracks(project);
      if (trackId && !tracks.some((t) => t.id === trackId))
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
                    Boolean(t.muted) || Boolean(trackId && t.id !== trackId),
                },
              ]),
            ),
          ),
        );
      return audio.get(key)!.pcm(start, duration);
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
    await renderer.init(width, (width * 9) / 16, "high");
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
