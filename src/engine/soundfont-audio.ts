import { assetUrl, type GeneratedAudioModule } from "./types";
import {
  ScoreStream,
  createStreamVoice,
  type ScoreStreamSource,
} from "./soundfont-stream";

export interface SampledScoreOptions extends ScoreStreamSource {
  bank: string;
  sha256: string;
}
const isOffline = (context: BaseAudioContext) => "startRendering" in context;

/** Original samples and event timing, generated only as far ahead as playback needs. */
export function createSampledScoreAudio(
  options: SampledScoreOptions,
): GeneratedAudioModule {
  let bank: Promise<ArrayBuffer> | undefined;
  const loadBank = () =>
    (bank ??= (async () => {
      const response = await fetch(assetUrl(options.bank));
      if (!response.ok) throw new Error(`乐器采样载入失败：${response.status}`);
      const bytes = await response.arrayBuffer();
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (n) => n.toString(16).padStart(2, "0"),
      ).join("");
      if (digest !== options.sha256)
        throw new Error("乐器采样校验失败，请恢复项目指定的采样库");
      return bytes;
    })().catch((error) => {
      bank = undefined;
      throw error;
    }));
  const live = new WeakMap<BaseAudioContext, ScoreStream>();
  const offlineUsers = new Set<BaseAudioContext>();
  let offline: ScoreStream | undefined;
  function client(context: BaseAudioContext) {
    if (isOffline(context)) {
      if (!offline) throw new Error("请先准备离线音频");
      return offline;
    }
    const stream = live.get(context);
    if (!stream) throw new Error("请先准备播放音频");
    return stream;
  }
  return {
    async prepareAudio(context) {
      if (isOffline(context)) {
        offline ??= new ScoreStream(options, loadBank);
        offlineUsers.add(context);
      } else if (!live.has(context))
        live.set(context, new ScoreStream(options, loadBank));
      await client(context).initialize();
    },
    async prepareSegment({ context, offset, duration, rate, signal }) {
      // Export awaits the requested span; preview starts after half a second
      // and then feeds the queue as native audio nodes finish playing.
      await client(context).ensure(
        offset,
        offset + Math.min(duration, isOffline(context) ? duration : 0.5 * rate),
        signal,
      );
    },
    createAudio(options) {
      return createStreamVoice(
        client(options.context),
        options,
        isOffline(options.context),
      );
    },
    disposeAudio(context) {
      if (isOffline(context)) {
        offlineUsers.delete(context);
        if (!offlineUsers.size) {
          offline?.dispose();
          offline = undefined;
        }
      } else {
        live.get(context)?.dispose();
        live.delete(context);
      }
    },
  };
}
