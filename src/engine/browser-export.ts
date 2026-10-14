import {
  Output,
  BufferTarget,
  StreamTarget,
  type StreamTargetChunk,
  WebMOutputFormat,
  CanvasSource,
  AudioBufferSource,
  EncodedVideoPacketSource,
  EncodedPacketSink,
  Input,
  BlobSource,
  WEBM,
  Quality,
  canEncodeVideo,
  canEncodeAudio,
} from "mediabunny";
import { FrameRenderer } from "./renderer";
import { resolveProject } from "./resolve-project";
import { OfflineAudioRenderer } from "./audio-graph";
import { projectAudioTracks, type AnimationProject } from "./types";
import { nextTask } from "./scheduling";

/**
 * Exports made in the browser (the local GPU draws, WebCodecs encodes), in segments. Each
 * segment is encoded on its own, so an export that stops (page closed, tab discarded, a
 * crash) loses at most the segment in progress. Finished segments are joined into one WebM
 * without encoding the picture again; the sound of each segment is kept as PCM and encoded
 * once while joining, so it has no seams.
 */
export type ExportCodec = "vp9" | "vp8";
export const SAMPLE_RATE = 48000;

export interface SegmentPlan {
  /** Time of the first exported frame in the work (seconds). */
  start: number;
  fps: number;
  width: number;
  height: number;
  subtitles: boolean;
}

const quality = new Quality("very-high");
const encoding = { quality, latencyMode: "quality" as const, hardwareAcceleration: "prefer-software" as const };

/** The video codecs this browser can encode at this size, best first. */
export async function encodableCodecs(width: number, height: number): Promise<ExportCodec[]> {
  const found: ExportCodec[] = [];
  for (const codec of ["vp9", "vp8"] as const) if (await canEncodeVideo(codec, { width, height, ...encoding })) found.push(codec);
  return found;
}

export const canEncodeSound = () => canEncodeAudio("opus", { sampleRate: SAMPLE_RATE, numberOfChannels: 2 });

/** The first audio sample of a frame: the sound of a segment covers exactly its frames. */
export const sampleOf = (frame: number, fps: number) => Math.round((frame * SAMPLE_RATE) / fps);

/** The video encoder failed, not the work: the segment's pictures are encoded again, then with the next codec. */
export class EncoderError extends Error {}
async function encoderStep<T>(step: () => Promise<T>, signal: AbortSignal) {
  try {
    return await step();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new EncoderError(error instanceof Error ? error.message : String(error));
  }
}

/** Draws and mixes a work for a local export, a range of frames at a time. */
export class SegmentRenderer {
  private readonly canvas = document.createElement("canvas");
  private readonly renderer: FrameRenderer;
  private readonly audio: OfflineAudioRenderer;
  readonly hasAudio: boolean;

  private constructor(
    project: AnimationProject,
    private readonly plan: SegmentPlan,
  ) {
    this.renderer = new FrameRenderer(this.canvas, project);
    this.audio = new OfflineAudioRenderer(project);
    this.hasAudio = projectAudioTracks(project).length > 0;
  }

  static async create(project: AnimationProject, plan: SegmentPlan) {
    const segments = new SegmentRenderer(await resolveProject(project), plan);
    try {
      // Export quality is independent from the preview's draft/standard setting.
      await segments.renderer.init(plan.width, plan.height, "high");
      await document.fonts.ready;
    } catch (error) {
      segments.dispose();
      throw error;
    }
    return segments;
  }

  /** The mix of frames [from, to) as interleaved 16-bit stereo PCM (null for a work without sound). */
  async sound(from: number, to: number, signal: AbortSignal): Promise<ArrayBuffer | null> {
    if (!this.hasAudio) return null;
    const { start, fps } = this.plan;
    const first = sampleOf(from, fps);
    const end = sampleOf(to, fps);
    const pcm = new Int16Array((end - first) * 2);
    // The audio renderer takes at most 10 s at a time.
    for (let at = first; at < end; at += SAMPLE_RATE * 10) {
      const count = Math.min(SAMPLE_RATE * 10, end - at);
      const buffer = await this.audio.render(start + at / SAMPLE_RATE, count / SAMPLE_RATE);
      signal.throwIfAborted();
      interleave(buffer, pcm, (at - first) * 2, count);
    }
    return pcm.buffer;
  }

  /** Frames [from, to) as a WebM of their own that starts with a key frame. */
  async pictures(from: number, to: number, codec: ExportCodec, { signal, onFrame }: { signal: AbortSignal; onFrame?: (done: number) => void }) {
    const { start, fps, subtitles } = this.plan;
    const target = new BufferTarget();
    const output = new Output({ format: new WebMOutputFormat(), target });
    // Encoders drop frames now and then (Chrome does when another tab comes to the front, the
    // key frame a segment starts with too): a segment is only kept with all its frames.
    let packets = 0;
    let keyFirst = false;
    const video = new CanvasSource(this.canvas, {
      codec,
      ...encoding,
      onEncodedPacket: (packet) => {
        if (packets++ === 0) keyFirst = packet.type === "key" && packet.timestamp === 0;
      },
    });
    output.addVideoTrack(video, { frameRate: fps });
    try {
      await encoderStep(() => output.start(), signal);
      for (let frame = from; frame < to; frame++) {
        signal.throwIfAborted();
        await this.renderer.render(start + frame / fps, subtitles, signal);
        await encoderStep(() => video.add((frame - from) / fps, 1 / fps), signal);
        onFrame?.(frame + 1 - from);
        // Pause and cancel requests get through between frames, also in a background tab.
        await nextTask();
      }
      signal.throwIfAborted();
      video.close();
      await encoderStep(() => output.finalize(), signal);
    } catch (error) {
      await output.cancel().catch(() => {});
      throw error;
    }
    if (!target.buffer?.byteLength || !keyFirst || packets < to - from)
      throw new EncoderError(`编码器丢了画面（这一段 ${to - from} 帧，编码出 ${packets} 帧${packets && !keyFirst ? "，没有从关键帧开始" : ""}）`);
    return target.buffer;
  }

  dispose() {
    this.audio.dispose();
    this.renderer.dispose();
    this.canvas.width = this.canvas.height = 1;
  }
}

export interface EncodedSegment {
  /** The segment's first frame in the export. */
  from: number;
  video: Blob;
  sound: Blob | null;
}

/**
 * Join segments into one WebM: the packets of the pictures are copied as they are (every
 * segment starts with a key frame), the sound is encoded to Opus in one go.
 */
export async function joinSegments({
  codec,
  fps,
  sound,
  count,
  segment,
  writable,
  signal,
  onSegment,
}: {
  codec: ExportCodec;
  fps: number;
  sound: boolean;
  count: number;
  segment: (index: number) => Promise<EncodedSegment>;
  writable: WritableStream<StreamTargetChunk>;
  signal: AbortSignal;
  onSegment?: (done: number) => void;
}) {
  const output = new Output({ format: new WebMOutputFormat(), target: new StreamTarget(writable, { chunked: true, chunkSize: 8 * 1024 * 1024 }) });
  const video = new EncodedVideoPacketSource(codec);
  output.addVideoTrack(video, { frameRate: fps });
  const audio = sound ? new AudioBufferSource({ codec: "opus", quality: new Quality({ bitrate: 192000 }) }) : null;
  if (audio) output.addAudioTrack(audio);
  try {
    await output.start();
    let sequence = 0;
    for (let index = 0; index < count; index++) {
      signal.throwIfAborted();
      const part = await segment(index);
      const input = new Input({ source: new BlobSource(part.video), formats: [WEBM] });
      try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error(`第 ${index + 1} 段没有画面`);
        const decoderConfig = sequence === 0 ? await track.getDecoderConfig() : null;
        for await (const packet of new EncodedPacketSink(track).packets()) {
          const moved = packet.clone({ timestamp: part.from / fps + packet.timestamp, sequenceNumber: sequence });
          await video.add(moved, decoderConfig && sequence === 0 ? { decoderConfig } : undefined);
          sequence++;
        }
      } finally {
        input.dispose();
      }
      if (audio && part.sound?.size) await audio.add(toAudioBuffer(new Int16Array(await part.sound.arrayBuffer())));
      onSegment?.(index + 1);
      await nextTask();
    }
    signal.throwIfAborted();
    video.close();
    audio?.close();
    await output.finalize();
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  }
}

function interleave(buffer: AudioBuffer, into: Int16Array, offset: number, count: number) {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  for (let i = 0; i < Math.min(count, buffer.length); i++) {
    into[offset + i * 2] = toInt16(left[i]);
    into[offset + i * 2 + 1] = toInt16(right[i]);
  }
}
const toInt16 = (sample: number) => Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767));

function toAudioBuffer(pcm: Int16Array) {
  const length = pcm.length / 2;
  const buffer = new AudioBuffer({ numberOfChannels: 2, length, sampleRate: SAMPLE_RATE });
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  for (let i = 0; i < length; i++) {
    left[i] = pcm[i * 2] / 32768;
    right[i] = pcm[i * 2 + 1] / 32768;
  }
  return buffer;
}
