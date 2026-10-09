import type { GeneratedAudioModule, GeneratedAudioOptions } from "./types";

export type StereoPcm = [Float32Array, Float32Array];

/**
 * Short-film generators prepare once, then reuse their in-memory sound on every seek/export.
 * `lazy`: make only the sounds that are played (a library of many sounds), each before its
 * first segment, instead of all of them up front.
 */
export function createPcmAudio(
  tracks: Record<string, () => StereoPcm | Promise<StereoPcm>>,
  sampleRate = 48000,
  { lazy = false }: { lazy?: boolean } = {},
): GeneratedAudioModule {
  const buffers = new Map<string, AudioBuffer>();
  const preparing = new Map<string, Promise<void>>();
  async function prepare(id: string, context: BaseAudioContext) {
    if (buffers.has(id)) return;
    if (preparing.has(id)) return preparing.get(id);
    const pending = (async () => {
      const pcm = await tracks[id]();
      if (!pcm[0].length || pcm[0].length !== pcm[1].length)
        throw new Error("生成音轨的两个声道长度必须相同且非空");
      for (const channel of pcm)
        for (const sample of channel)
          if (!Number.isFinite(sample)) throw new Error("生成音轨包含无效采样");
      const buffer = context.createBuffer(2, pcm[0].length, sampleRate);
      buffer.copyToChannel(pcm[0] as Float32Array<ArrayBuffer>, 0);
      buffer.copyToChannel(pcm[1] as Float32Array<ArrayBuffer>, 1);
      buffers.set(id, buffer);
    })().finally(() => preparing.delete(id));
    preparing.set(id, pending);
    return pending;
  }
  return {
    async prepareAudio(context) {
      // Called before the transport clock starts. AudioBuffers can be shared by
      // independent AudioContext/OfflineAudioContext instances; nodes cannot.
      if (!lazy) await Promise.all(Object.keys(tracks).map((id) => prepare(id, context)));
    },
    ...(lazy
      ? {
          async prepareSegment({ trackId, context }: { trackId: string; context: BaseAudioContext }) {
            if (!Object.hasOwn(tracks, trackId)) throw new Error("未知生成音轨: " + trackId);
            await prepare(trackId, context);
          },
        }
      : {}),
    createAudio({
      trackId,
      context,
      destination,
      when,
      offset,
      duration,
      rate,
    }: GeneratedAudioOptions) {
      if (!Object.hasOwn(tracks, trackId))
        throw new Error("未知生成音轨: " + trackId);
      const buffer = buffers.get(trackId);
      if (!buffer) throw new Error("请先调用 prepareAudio 准备生成音轨");
      const length = Math.min(duration, buffer.duration - offset);
      if (length <= 0) return { dispose() {} };
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = rate;
      let disposed = false,
        started = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        source.onended = null;
        if (started) source.stop();
        source.disconnect();
        source.buffer = null;
      };
      try {
        source.connect(destination);
        source.onended = dispose;
        source.start(when, offset, length);
        started = true;
        return { dispose };
      } catch (error) {
        dispose();
        throw error;
      }
    },
  };
}
