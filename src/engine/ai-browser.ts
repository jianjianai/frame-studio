import { type AnimationProject, projectAudioTracks } from "./types";
import { waitForStudio } from "./debug";
import { FrameRenderer } from "./renderer";
import { exportWebm, type ExportProgress } from "./browser-export";
import { downloadBlob } from "./download";
import { toSrt } from "./subtitles";
import { frameDimensions, compositionSize, fitComposition } from "./dimensions.mjs";

export function installAiBrowser(project: AnimationProject) {
  let segmentTimer: number | undefined;
  let serial = 0;
  const jobs = new Map<
    string,
    {
      state: string;
      progress?: ExportProgress;
      error?: string;
      controller: AbortController;
      blob?: Blob;
      url?: string;
      filename: string;
    }
  >();
  const controls = new Map<string, { gain: number; muted: boolean }>();
  let volume = 1;
  const api = () => {
    const value = window.__FRAME_STUDIO__;
    if (!value) throw Error("Player not ready; await FRAME_AI.ready()");
    return value;
  };
  const stopSegment = () => {
    if (segmentTimer !== undefined) clearInterval(segmentTimer);
    segmentTimer = undefined;
  };
  const validTime = (time: number) => {
    if (!Number.isFinite(time) || time < 0 || time > project.duration)
      throw Error("Time must be inside work duration");
    return time;
  };
  const info = () => ({
    id: project.id,
    title: project.title,
    duration: project.duration,
    fps: project.fps,
    renderer: project.renderer,
    composition: compositionSize(project),
    tracks: projectAudioTracks(project),
    beats: project.beats,
    subtitles: project.subtitles,
    compute: "browser",
    exportFormats: ["png", "webm", "srt"],
  });
  const publicJob = (id: string) => {
    const j = jobs.get(id);
    if (!j) throw Error("Unknown export");
    return {
      id,
      state: j.state,
      progress: j.progress,
      error: j.error,
      url: j.url,
      bytes: j.blob?.size,
      mime: j.blob?.type,
      filename: j.filename,
    };
  };
  const control = {
    version: 1,
    help: () => ({
      ready: "await FRAME_AI.ready()",
      info: "FRAME_AI.info()",
      state: "FRAME_AI.state()",
      frame: "await FRAME_AI.frame({time:2,width:1280}) or {frame:60}",
      storyboard: "await FRAME_AI.storyboard({times:[0,1,2],width:320})",
      play: "await FRAME_AI.play({start:1,end:4,rate:1,loop:false})",
      pause: "FRAME_AI.pause()",
      seek: "await FRAME_AI.seek(3)",
      track: 'FRAME_AI.setTrack("voice",{gain:0.7,muted:false})',
      export:
        "const {id}=FRAME_AI.exportVideo({start:1,end:3,width:1280,fps:30}); FRAME_AI.exportStatus(id); FRAME_AI.download(id)",
      cancel: "FRAME_AI.cancelExport(id)",
      subtitles: "FRAME_AI.subtitles({download:true})",
      cleanup: "FRAME_AI.release(id)",
      notes:
        "All rendering, sound and encoding run in this browser. Export jobs require the tab to remain open. Autoplay may require clicking Enable audio once.",
    }),
    async ready() {
      const deadline = Date.now() + 60000;
      while (!window.__FRAME_STUDIO__) {
        if (Date.now() > deadline) throw Error("Player unavailable");
        await new Promise((r) => setTimeout(r, 20));
      }
      await waitForStudio(api());
      return info();
    },
    info,
    state: () => ({
      ...api().getState(),
      diagnostics: api().getDiagnostics?.(),
      exports: [...jobs.keys()].map(publicJob),
    }),
    async frame(
      options: {
        time?: number;
        frame?: number;
        width?: number;
        subtitles?: boolean;
        download?: boolean;
      } = {},
    ) {
      await control.ready();
      stopSegment();
      api().pause();
      if (options.time !== undefined && options.frame !== undefined)
        throw Error("Choose time or frame");
      if (
        options.frame !== undefined &&
        (!Number.isInteger(options.frame) || options.frame < 0)
      )
        throw Error("Frame must be a nonnegative integer");
      const time = validTime(
        options.frame === undefined
          ? (options.time ?? api().getState().time)
          : options.frame / project.fps,
      );
      api().frame(time, options.subtitles ?? true);
      let dataURL = api().dataURL(),
        width = api().getState().width,
        height = api().getState().height;
      if (options.width !== undefined) {
        width = options.width;
        if (
          !Number.isInteger(width) ||
          width < 64 ||
          width > 3840 ||
          width % 2
        )
          throw Error("Width must be an even integer from 64 to 3840");
        height = frameDimensions(project, width).height;
        const canvas = document.createElement("canvas"),
          renderer = new FrameRenderer(canvas, project);
        try {
          await renderer.init(width, height, "high");
          await document.fonts.ready;
          renderer.render(time, options.subtitles ?? true);
          dataURL = canvas.toDataURL("image/png");
        } finally {
          renderer.dispose();
          canvas.width = canvas.height = 1;
        }
      }
      if (options.download)
        downloadBlob(
          new Blob(
            [
              Uint8Array.from(atob(dataURL.split(",")[1]), (c) =>
                c.charCodeAt(0),
              ),
            ],
            { type: "image/png" },
          ),
          `${project.id}-frame-${Math.round(time * project.fps)}.png`,
        );
      return {
        time,
        frame: Math.round(time * project.fps),
        width,
        height,
        mime: "image/png",
        dataURL,
      };
    },
    async storyboard({
      times,
      width = 320,
      subtitles = true,
    }: {
      times: number[];
      width?: number;
      subtitles?: boolean;
    }) {
      if (!times.length || times.length > 24)
        throw Error("Choose 1..24 timestamps");
      const frames = [];
      for (const time of times)
        frames.push(await control.frame({ time, width, subtitles }));
      return { frames };
    },
    async seek(time: number) {
      stopSegment();
      await control.ready();
      api().frame(validTime(time));
      return api().getState();
    },
    async play({
      start,
      end = project.duration,
      rate = 1,
      loop = false,
    }: { start?: number; end?: number; rate?: number; loop?: boolean } = {}) {
      await control.ready();
      stopSegment();
      const from = validTime(start ?? api().getState().time);
      validTime(end);
      if (end <= from) throw Error("End must follow start");
      api().setLoop?.(false);
      api().setRate?.(rate);
      api().seek(from);
      await api().play();
      segmentTimer = window.setInterval(() => {
        if (api().getState().time >= end) {
          api().pause();
          api().frame(end);
          if (loop) {
            api().seek(from);
            void api()
              .play()
              .catch(() => stopSegment());
          } else stopSegment();
        }
      }, 16);
      return api().getState();
    },
    pause() {
      stopSegment();
      api().pause();
      return api().getState();
    },
    setRate(rate: number) {
      api().setRate?.(rate);
      return api().getState();
    },
    setVolume(value: number) {
      if (!Number.isFinite(value) || value < 0 || value > 1)
        throw Error("Volume must be 0..1");
      volume = value;
      api().setVolume?.(value);
    },
    setTrack(id: string, change: Partial<{ gain: number; muted: boolean }>) {
      if (!projectAudioTracks(project).some((t) => t.id === id))
        throw Error("Unknown audio track");
      api().setTrack?.(id, change);
      const track = projectAudioTracks(project).find((t) => t.id === id)!;
      controls.set(id, {
        gain: track.gain ?? 1,
        muted: track.muted ?? false,
        ...controls.get(id),
        ...change,
      });
      return control.state();
    },
    exportVideo(
      options: {
        start?: number;
        end?: number;
        width?: number;
        fps?: number;
        subtitles?: boolean;
      } = {},
    ) {
      if ([...jobs.values()].some((j) => j.state === "running"))
        throw Error("An export is already running");
      control.pause();
      const id = "export-" + ++serial,
        job = {
          state: "running",
          controller: new AbortController(),
          filename: project.id + ".webm",
        };
      jobs.set(id, job);
      void exportWebm(project, {
        width: options.width ?? fitComposition(project, 1280).width,
        fps: options.fps ?? project.fps,
        start: options.start,
        end: options.end,
        subtitles: options.subtitles ?? true,
        signal: job.controller.signal,
        controls,
        volume,
        onProgress: (progress) => Object.assign(job, { progress }),
      })
        .then((blob) => {
          if (!blob) throw Error("Export returned no data");
          Object.assign(job, {
            state: "succeeded",
            blob,
            url: URL.createObjectURL(blob),
          });
        })
        .catch((error) =>
          Object.assign(job, {
            state: job.controller.signal.aborted ? "cancelled" : "failed",
            error: String(error),
          }),
        );
      return { id };
    },
    exportStatus: publicJob,
    cancelExport(id: string) {
      const job = jobs.get(id);
      if (!job) throw Error("Unknown export");
      job.controller.abort();
      return publicJob(id);
    },
    download(id: string) {
      const job = jobs.get(id);
      if (!job?.blob) throw Error("Export is not complete");
      downloadBlob(job.blob, job.filename);
      return publicJob(id);
    },
    subtitles({ download = false } = {}) {
      const text = toSrt(project.subtitles);
      if (download)
        downloadBlob(
          new Blob([text], { type: "text/plain;charset=utf-8" }),
          project.id + ".srt",
        );
      return text;
    },
    release(id: string) {
      const job = jobs.get(id);
      job?.controller.abort();
      if (job?.url) URL.revokeObjectURL(job.url);
      jobs.delete(id);
    },
  };
  window.FRAME_AI = control;
  const dispose = () => {
    stopSegment();
    for (const id of jobs.keys()) control.release(id);
  };
  window.addEventListener("pagehide", dispose, { once: true });
  return control;
}
declare global {
  interface Window {
    FRAME_AI?: ReturnType<typeof installAiBrowser>;
  }
}
