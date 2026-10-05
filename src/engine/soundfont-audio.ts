import { assetUrl, type GeneratedAudioModule } from "./types";
import { browserSha256 } from "../browser/hash.mjs";
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
  const selectedBank = async (): Promise<ArrayBuffer | undefined> => {
    // Bank-select and system-exclusive messages can change preset resolution;
    // those scores keep the original complete bank and its checksum contract.
    if (
      options.score.controls.some(
        (e) =>
          (e.data[0] & 0xf0) === 0xf0 ||
          ((e.data[0] & 0xf0) === 0xb0 && [0, 32].includes(e.data[1])),
      )
    )
      return;
    const response = await fetch(assetUrl(options.bank + ".parts/index.json"), { headers: { "X-Frame-Optional": "1" } });
    if (!response.ok) return;
    const manifest = await response.json();
    if (manifest.version !== 1 || manifest.sourceSha256 !== options.sha256)
      return;
    const wanted = new Set<string>();
    for (const i of options.score.instruments)
      wanted.add((i.channel === 9 ? "drum:" : "program:") + i.program);
    for (const e of options.score.controls)
      if ((e.data[0] & 0xf0) === 0xc0)
        wanted.add(((e.data[0] & 15) === 9 ? "drum:" : "program:") + e.data[1]);
    // Include the default patch only if it can sound before that channel's first program change.
    for (const channel of new Set(options.score.notes.map((n) => n.channel))) {
      const firstNote = Math.min(
        ...options.score.notes
          .filter((n) => n.channel === channel)
          .map((n) => n.t),
      );
      if (
        !options.score.controls.some(
          (e) =>
            (e.data[0] & 0xf0) === 0xc0 &&
            (e.data[0] & 15) === channel &&
            e.t <= firstNote,
        )
      )
        wanted.add((channel === 9 ? "drum:" : "program:") + "0");
    }
    if (!wanted.size) return;
    const indices = [...new Set([...wanted].map((key) => manifest.keys[key]))];
    if (indices.some((index) => typeof index !== "number")) return;
    const buffers = await Promise.all(
      indices.map(async (index) => {
        const part = manifest.parts[index];
        if (!part || !/^[a-f0-9]{64}\.sf2$/.test(part.file))
          throw new Error("无效的乐器分包");
        const r = await fetch(assetUrl(options.bank + ".parts/" + part.file));
        if (!r.ok) throw new Error("乐器采样分包载入失败");
        const bytes = await r.arrayBuffer();
        if ((await browserSha256(bytes)) !== part.sha256)
          throw new Error("乐器采样分包校验失败");
        return bytes;
      }),
    );
    const { BasicSoundBank, SoundBankLoader, SpessaLog } =
      await import("spessasynth_core");
    SpessaLog.setLogLevel(false, false, false);
    return BasicSoundBank.mergeSoundBanks(
      ...buffers.map((b) => SoundBankLoader.fromArrayBuffer(b)),
    ).writeSF2();
  };
  const loadBank = () =>
    (bank ??= (async () => {
      const selected = await selectedBank();
      if (selected) return selected;
      const response = await fetch(assetUrl(options.bank));
      if (!response.ok) throw new Error(`乐器采样载入失败：${response.status}`);
      const bytes = await response.arrayBuffer();
      if ((await browserSha256(bytes)) !== options.sha256)
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
      // Export prepares exactly the requested span. Live startup uses the same
      // bounded adaptive window as voice.ready, which also queues native nodes.
      const stream = client(context);
      await stream.ensure(
        offset,
        offset +
          Math.min(
            duration,
            isOffline(context) ? duration : stream.bufferSeconds(rate, true) * rate,
          ),
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
