import { importWork, workSourceFromQuery } from "./load-work";
import { SegmentRenderer, EncoderError, encodableCodecs, canEncodeSound, joinSegments, type ExportCodec } from "../engine/browser-export";
import { createExportPlan } from "../engine/export-plan.mjs";
import { projectAudioTracks, type AnimationProject } from "../engine/types";
import {
  EXPORT_CHANNEL,
  SEGMENT_SECONDS,
  exportLock,
  fileOf,
  jobFolder,
  readJob,
  removeJob,
  removeSegments,
  saveJob,
  writeFile,
  type ExportJob,
  type ExportMessage,
  type ExportPlan,
} from "./export-jobs";

/**
 * Renders one local export (the studio keeps this page in a hidden frame while it runs):
 * segment by segment into the browser's own storage, then joins the segments into the video.
 * Everything it needs is in the export's folder, so a later page continues where an earlier
 * one stopped.
 */
export interface ExportPageApi {
  /** Stop after the frame in progress: "paused" keeps what is done, "cancelled" removes the export. */
  stop(reason: "paused" | "cancelled"): void;
}
declare global {
  interface Window {
    __FRAME_EXPORT__?: ExportPageApi;
  }
}

const params = new URLSearchParams(location.search);
const id = params.get("job") ?? "";
const channel = new BroadcastChannel(EXPORT_CHANNEL);
const post = (message: ExportMessage) => channel.postMessage(message);
const controller = new AbortController();
let stopping: "paused" | "cancelled" | null = null;
const stop = (reason: "paused" | "cancelled") => {
  stopping ??= reason;
  controller.abort(new DOMException("导出已停止", "AbortError"));
};
window.__FRAME_EXPORT__ = { stop };
// A studio in another tab asks through the channel.
channel.onmessage = (event: MessageEvent<ExportMessage>) => {
  const message = event.data;
  if (message.type === "command" && message.id === id) stop(message.command === "cancel" ? "cancelled" : "paused");
};

// The lock says the export is being rendered; while it is held, Chrome does not freeze the tab in the background.
void navigator.locks.request(exportLock(id), { ifAvailable: true }, async (lock) => {
  if (!lock) return post({ type: "busy", id });
  try {
    await run();
  } finally {
    post({ type: "stopped", id });
  }
});

async function run() {
  let job: ExportJob;
  try {
    job = await readJob(id);
  } catch {
    return; // removed meanwhile
  }
  if (job.status !== "queued" && job.status !== "running") return;
  const update = async (change: Partial<ExportJob>) => {
    job = await saveJob({ ...job, ...change });
    post({ type: "job", job });
  };
  const { signal } = controller;
  const pace = new Pace();
  let segments: SegmentRenderer | undefined;
  try {
    await update({ status: "running", error: undefined, stalls: job.stalls + 1 });
    pace.loading(job);
    const project = await importWork(workSourceFromQuery(params)).catch((error) => {
      throw new Error("作品无法加载：" + describe(error));
    });
    signal.throwIfAborted();
    const plan = job.plan ?? planOf(project, job);
    if (plan.end > project.duration + 1e-6)
      throw new Error(`作品现在只有 ${seconds(project.duration)} 秒，比这次导出的范围（到 ${seconds(plan.end)} 秒）短，接不上了：请从头重新导出`);
    if (plan.audio && !(await canEncodeSound())) throw new Error("这个浏览器不能编码声音（Opus），请改用服务器导出 MP4");
    const codecs: ExportCodec[] = job.codec ? [job.codec] : await encodableCodecs(plan.width, plan.height);
    if (!codecs.length)
      throw new Error(
        job.codec
          ? `这个浏览器不能编码 ${job.codec.toUpperCase()}，接不上已导出的部分：请回到原来的浏览器继续，或者从头重新导出`
          : "这个浏览器不能编码视频（VP9 / VP8），请改用服务器导出 MP4",
      );
    const folder = await jobFolder(id);
    // Segments whose files went missing (storage cleared in part) are made again.
    const files = new Set<string>();
    for await (const name of folder.keys()) files.add(name);
    const done = job.done.filter((index) => files.has(`v-${index}.webm`) && (!plan.audio || files.has(`a-${index}.pcm`)));
    if (!job.plan || done.length !== job.done.length) await update({ plan, done });
    segments = await SegmentRenderer.create(project, {
      start: plan.start,
      fps: plan.fps,
      width: plan.width,
      height: plan.height,
      subtitles: job.options.subtitles,
    });
    signal.throwIfAborted();
    pace.rendering(job, plan);
    for (let index = 0; index < plan.segments; index++) {
      if (job.done.includes(index)) continue;
      const from = index * plan.segmentFrames;
      const to = Math.min(plan.frames, from + plan.segmentFrames);
      const began = performance.now();
      const sound = await segments.sound(from, to, signal);
      const failures: string[] = [];
      let video: ArrayBuffer | undefined;
      // The first segment settles the codec; the others must use the same one to be joined.
      for (const codec of job.codec ? [job.codec] : codecs) {
        // An encoder that loses a frame now and then gets a few more tries before the next codec.
        for (let attempt = 1; attempt <= 3 && !video; attempt++)
          try {
            video = await segments.pictures(from, to, codec, { signal, onFrame: (count) => pace.frame(count) });
          } catch (error) {
            if (!(error instanceof EncoderError)) throw error;
            console.warn(`FRAME 本机导出：第 ${index + 1} 段第 ${attempt} 次编码失败`, error.message);
            failures.push(`${codec}：${error.message}`);
          }
        if (!video) continue;
        if (!job.codec) await update({ codec });
        break;
      }
      if (!video) throw new Error(job.codec ? `视频编码失败：${failures.at(-1)}` : `浏览器无法编码视频，请改用服务器导出 MP4（${failures.join("；")}）`);
      if (sound) await writeFile(folder, `a-${index}.pcm`, sound);
      await writeFile(folder, `v-${index}.webm`, video);
      await update({
        done: [...job.done, index],
        bytes: job.bytes + video.byteLength + (sound?.byteLength ?? 0),
        stats: { frames: job.stats.frames + to - from, ms: job.stats.ms + performance.now() - began },
        stalls: 0,
      });
      pace.segment(job);
    }
    pace.joining(job);
    const output = await folder.getFileHandle("output.webm", { create: true });
    await joinSegments({
      codec: job.codec!,
      fps: plan.fps,
      sound: plan.audio,
      count: plan.segments,
      writable: await output.createWritable(),
      signal,
      segment: async (index) => ({
        from: index * plan.segmentFrames,
        video: await fileOf(folder, `v-${index}.webm`),
        sound: plan.audio ? await fileOf(folder, `a-${index}.pcm`) : null,
      }),
      onSegment: (count) => pace.joined(count),
    });
    const file = await output.getFile();
    // Marked done before the segments go: a page closed in between leaves a few files, not a broken export.
    await update({ status: "done", output: { name: fileName(job.title), size: file.size, finishedAt: new Date().toISOString() }, stalls: 0 });
    await removeSegments(id);
  } catch (error) {
    if (stopping === "cancelled") {
      await removeJob(id);
      post({ type: "removed", id });
    } else if (stopping === "paused") await update({ status: "paused", stalls: 0 }).catch(() => {});
    else await update({ status: "failed", error: describe(error), stalls: 0 }).catch(() => {});
  } finally {
    segments?.dispose();
  }
}

function planOf(project: AnimationProject, job: ExportJob): ExportPlan {
  let base: ReturnType<typeof createExportPlan>;
  try {
    base = createExportPlan({
      duration: project.duration,
      composition: project.composition,
      width: job.options.width,
      fps: job.options.fps,
      start: job.options.start,
      end: job.options.end,
    });
  } catch {
    throw new Error(`导出范围无效：作品长 ${seconds(project.duration)} 秒，开始时间要小于结束时间`);
  }
  const segmentFrames = Math.max(1, Math.round(SEGMENT_SECONDS * base.fps));
  return { ...base, segmentFrames, segments: Math.ceil(base.frames / segmentFrames), audio: projectAudioTracks(project).length > 0 };
}

const seconds = (value: number) => Math.round(value * 100) / 100;
const fileName = (title: string) =>
  `${
    title
      .replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_")
      .trim()
      .slice(0, 80) || "video"
  }.webm`;
const describe = (error: unknown) =>
  error instanceof DOMException && error.name === "QuotaExceededError"
    ? "浏览器的存储空间不够：清理磁盘、移除不用的本机导出后点「重试」"
    : error instanceof Error
      ? error.message
      : String(error);

/** Joining copies data: this many bytes a second is a safe guess for the time it takes. */
const JOIN_BYTES_PER_SECOND = 80 * 1024 * 1024;

/**
 * Progress for the studio, at most four times a second, with the time left: this session's
 * pace once it has rendered a few seconds, until then the pace of earlier sessions.
 */
class Pace {
  private job?: ExportJob;
  private plan?: ExportPlan;
  private began = 0;
  /** Frames rendered in this session: finished segments, and the one in progress. */
  private finished = 0;
  private partial = 0;
  private joinBegan = 0;
  private last = 0;

  loading(job: ExportJob) {
    this.job = job;
    const plan = job.plan;
    this.report("loading", plan ? this.framesDone() : 0, plan?.frames ?? 0);
  }
  rendering(job: ExportJob, plan: ExportPlan) {
    this.job = job;
    this.plan = plan;
    this.began = performance.now();
    this.report("rendering", this.framesDone(), plan.frames);
  }
  frame(count: number) {
    this.partial = count;
    if (performance.now() - this.last >= 250) this.report("rendering", this.framesDone(), this.plan!.frames);
  }
  segment(job: ExportJob) {
    this.job = job;
    this.finished += this.partial;
    this.partial = 0;
    this.report("rendering", this.framesDone(), this.plan!.frames);
  }
  joining(job: ExportJob) {
    this.job = job;
    this.joinBegan = performance.now();
    this.report("joining", 0, this.plan!.segments);
  }
  joined(count: number) {
    if (performance.now() - this.last >= 250 || count === this.plan!.segments) this.report("joining", count, this.plan!.segments);
  }

  private framesDone() {
    const { job } = this;
    const plan = this.plan ?? job?.plan;
    if (!job || !plan) return 0;
    const finished = job.done.reduce((sum, index) => sum + Math.min(plan.frames, (index + 1) * plan.segmentFrames) - index * plan.segmentFrames, 0);
    return finished + this.partial;
  }
  /** Frames a second. */
  private rate() {
    const ms = this.began ? performance.now() - this.began : 0;
    const frames = this.finished + this.partial;
    if (ms >= 3000 && frames > 0) return frames / (ms / 1000);
    const { stats } = this.job!;
    if (stats.ms > 0 && stats.frames > 0) return stats.frames / (stats.ms / 1000);
    return ms > 0 && frames > 0 ? frames / (ms / 1000) : null;
  }
  private joinGuess() {
    const plan = this.plan ?? this.job?.plan;
    const job = this.job!;
    if (!plan || !job.done.length) return 2;
    const finished = this.framesDone() - this.partial;
    return 1 + (finished ? (job.bytes / finished) * plan.frames : 0) / JOIN_BYTES_PER_SECOND;
  }
  private report(phase: "loading" | "rendering" | "joining", done: number, total: number) {
    const now = performance.now();
    this.last = now;
    let fps: number | null = null;
    let eta: number | null = null;
    if (phase === "joining") {
      const elapsed = (now - this.joinBegan) / 1000;
      eta = done ? ((total - done) * elapsed) / done : this.joinGuess();
    } else {
      fps = this.rate();
      if (fps && total) eta = (total - done) / fps + this.joinGuess();
    }
    post({ type: "progress", progress: { id, phase, done, total, fps, eta } });
  }
}
