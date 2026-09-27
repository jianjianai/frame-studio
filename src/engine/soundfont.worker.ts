import {
  SoundBankLoader,
  SpessaSynthProcessor,
  SpessaLog,
} from "spessasynth_core";
import { scoreEvents, type Score } from "./score.mjs";
import type { StereoPcm } from "./procedural-audio";
import { masterScoreTracks } from "./score-mastering";

// The same library version, bank, event rounding, block size, effects and
// level scaling as the original offline score renderer, on a browser worker.
const sampleRate = 48000;
self.onmessage = async (
  event: MessageEvent<{ score: Score; bank: ArrayBuffer; foley: StereoPcm }>,
) => {
  let synth: SpessaSynthProcessor | undefined;
  try {
    const { score, bank, foley } = event.data;
    SpessaLog.setLogLevel(false, false, false);
    synth = new SpessaSynthProcessor(sampleRate, {
      eventsEnabled: false,
      maxBufferSize: 128,
    });
    synth.soundBankManager.addSoundBank(
      SoundBankLoader.fromArrayBuffer(bank),
      "GeneralUser GS",
    );
    await synth.processorInitialized;
    synth.setSystemParameter("autoAllocateVoices", true);
    const events = scoreEvents(score).map((e) => ({
      ...e,
      sample: Math.round(e.t * sampleRate),
    }));
    const length = Math.round(score.duration * sampleRate);
    if (foley[0].length !== length || foley[1].length !== length)
      throw new Error("动作音效时长与乐谱不一致");
    const music: StereoPcm = [
      new Float32Array(length),
      new Float32Array(length),
    ];
    let cursor = 0,
      next = 0;
    while (cursor < length) {
      while (next < events.length && events[next].sample <= cursor)
        synth.processMessage(events[next++].data);
      const block = Math.min(
        128,
        length - cursor,
        next < events.length ? Math.max(1, events[next].sample - cursor) : 128,
      );
      synth.process(music[0], music[1], cursor, block);
      cursor += block;
    }
    let energy = 0,
      peak = 0;
    for (const channel of music)
      for (const sample of channel) {
        if (!Number.isFinite(sample)) throw new Error("乐器采样产生了无效数据");
        energy += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
    if (peak < 0.0001) throw new Error("乐器采样未产生声音");
    const scale = Math.min(
      0.12 / Math.sqrt(energy / (length * 2)),
      0.72 / peak,
    );
    for (const channel of music)
      for (let i = 0; i < length; i++) channel[i] *= scale;
    masterScoreTracks(music, foley);
    postMessage(
      { music, foley },
      {
        transfer: [...music, ...foley].map(
          (channel) => channel.buffer as ArrayBuffer,
        ),
      },
    );
  } catch (error) {
    postMessage({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    synth?.destroySynthProcessor();
    self.onmessage = null;
  }
};
