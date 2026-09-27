import { assetUrl, type GeneratedAudioModule } from "./types";
import type { Score } from "./score.mjs";
import { createPcmAudio, type StereoPcm } from "./procedural-audio";

export interface SampledScoreOptions {
  score: Score;
  foley(): StereoPcm;
  bank: string;
  sha256: string;
}

/** Load the project's original instrument samples; never substitute oscillator timbres. */
export function createSampledScoreAudio(
  options: SampledScoreOptions,
): GeneratedAudioModule {
  let prepared: Promise<{ music: StereoPcm; foley: StereoPcm }> | undefined;
  const prepare = () =>
    (prepared ??= (async () => {
      const response = await fetch(assetUrl(options.bank));
      if (!response.ok) throw new Error(`乐器采样载入失败：${response.status}`);
      const bank = await response.arrayBuffer();
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bank)),
        (n) => n.toString(16).padStart(2, "0"),
      ).join("");
      if (digest !== options.sha256)
        throw new Error("乐器采样校验失败，请恢复项目指定的采样库");
      // makeScore includes editing helpers: send only its serializable event data.
      const { id, duration, bpm, meter, notes, controls, instruments, cues } =
        options.score;
      const score = {
        id,
        duration,
        bpm,
        meter,
        notes,
        controls,
        instruments,
        cues,
      };
      const foley = options.foley();
      return new Promise<{ music: StereoPcm; foley: StereoPcm }>(
        (resolve, reject) => {
          const worker = new Worker(
            new URL("./soundfont.worker.ts", import.meta.url),
            { type: "module" },
          );
          const finish = () => {
            worker.terminate();
            worker.onmessage = null;
            worker.onerror = null;
            worker.onmessageerror = null;
          };
          worker.onmessage = (
            event: MessageEvent<{
              music: StereoPcm;
              foley: StereoPcm;
              error?: string;
            }>,
          ) => {
            finish();
            if (event.data.error) reject(new Error(event.data.error));
            else resolve(event.data);
          };
          worker.onerror = (error) => {
            finish();
            reject(new Error(error.message || "乐器采样生成失败"));
          };
          worker.onmessageerror = () => {
            finish();
            reject(new Error("乐器采样结果无法读取"));
          };
          try {
            worker.postMessage({ score, bank, foley }, [
              bank,
              foley[0].buffer as ArrayBuffer,
              foley[1].buffer as ArrayBuffer,
            ]);
          } catch (error) {
            finish();
            reject(error);
          }
        },
      );
    })().catch((error) => {
      prepared = undefined;
      throw error;
    }));
  const audio = createPcmAudio({
    music: async () => (await prepare()).music,
    foley: async () => (await prepare()).foley,
  });
  return {
    async prepareAudio(context) {
      try {
        await audio.prepareAudio!(context);
      } finally {
        prepared = undefined;
      } // PCM is now owned by the reusable AudioBuffers.
    },
    createAudio: audio.createAudio,
  };
}
