import {
  SoundBankLoader,
  SpessaSynthProcessor,
  SpessaLog,
} from "spessasynth_core";
import { scoreEvents } from "./score.mjs";
import type { StereoPcm } from "./procedural-audio";
import { createScoreMastering } from "./score-mastering";
import {
  SCORE_SAMPLE_RATE,
  SCORE_CHUNK_FRAMES,
  type ScoreChunkRange,
  type ScoreWorkerRequest,
  type ScoreWorkerResponse,
} from "./soundfont-protocol";

let synth: SpessaSynthProcessor | undefined;
let initialized: Promise<void> | undefined;
let events: { data: number[]; sample: number }[] = [];
let foley: StereoPcm;
let master: ReturnType<typeof createScoreMastering>;
let length = 0,
  cursor = 0,
  eventIndex = 0,
  nextChunk = 0,
  target = 0;
let queued = false,
  failed = false;
let ranges: ScoreChunkRange[] = [];
// Keep preroll in the worker. Transfer only requested intervals; cached earlier
// sound can then be fetched on a backward seek without synthesizing it again.
const cached = new Map<number, { music: StereoPcm; foley: StereoPcm }>();
const tasks = new MessageChannel();
tasks.port1.onmessage = () => {
  queued = false;
  pump();
};
const block: StereoPcm = [new Float32Array(128), new Float32Array(128)];
let blockOffset = 0,
  blockLength = 0;
function send(message: ScoreWorkerResponse, transfer: Transferable[] = []) {
  postMessage(message, { transfer });
}
function fail(error: unknown) {
  if (failed) return;
  failed = true;
  synth?.destroySynthProcessor();
  synth = undefined;
  cached.clear();
  send({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
}
async function initialize(data: Extract<ScoreWorkerRequest, { type: "init" }>) {
  const { score, bank, levels } = data;
  if (
    !Number.isFinite(levels.music) ||
    levels.music <= 0 ||
    !Number.isFinite(levels.master) ||
    levels.master <= 0
  )
    throw new Error("无效的配乐混音增益");
  length = Math.round(score.duration * SCORE_SAMPLE_RATE);
  foley = data.foley;
  if (foley[0].length !== length || foley[1].length !== length)
    throw new Error("动作音效时长与乐谱不一致");
  master = createScoreMastering(length, levels.music, levels.master);
  SpessaLog.setLogLevel(false, false, false);
  synth = new SpessaSynthProcessor(SCORE_SAMPLE_RATE, {
    eventsEnabled: false,
    maxBufferSize: 128,
  });
  synth.soundBankManager.addSoundBank(
    SoundBankLoader.fromArrayBuffer(bank),
    "GeneralUser GS",
  );
  await synth.processorInitialized;
  synth.setSystemParameter("autoAllocateVoices", true);
  events = scoreEvents(score).map((e) => ({
    data: e.data,
    sample: Math.round(e.t * SCORE_SAMPLE_RATE),
  }));
  send({ type: "ready" });
}
function deliver(index: number) {
  const chunk = cached.get(index);
  if (!chunk) return;
  cached.delete(index);
  send(
    { type: "chunk", index, ...chunk },
    [...chunk.music, ...chunk.foley].map((c) => c.buffer as ArrayBuffer),
  );
}
function requestPump() {
  if (queued || failed || nextChunk >= target) return;
  queued = true;
  tasks.port2.postMessage(null);
}
function renderChunk() {
  const start = nextChunk * SCORE_CHUNK_FRAMES;
  const count = Math.min(SCORE_CHUNK_FRAMES, length - start);
  const music: StereoPcm = [new Float32Array(count), new Float32Array(count)];
  // Keep the original 128-frame/event-aligned processing boundaries, carrying
  // unused samples across transport chunks rather than splitting synth blocks.
  for (let written = 0; written < count;) {
    if (blockOffset === blockLength) {
      while (eventIndex < events.length && events[eventIndex].sample <= cursor)
        synth!.processMessage(events[eventIndex++].data);
      blockLength = Math.min(
        128,
        length - cursor,
        eventIndex < events.length
          ? Math.max(1, events[eventIndex].sample - cursor)
          : 128,
      );
      block[0].fill(0);
      block[1].fill(0);
      synth!.process(block[0], block[1], 0, blockLength);
      cursor += blockLength;
      blockOffset = 0;
    }
    const take = Math.min(blockLength - blockOffset, count - written);
    for (let channel = 0; channel < 2; channel++)
      music[channel].set(
        block[channel].subarray(blockOffset, blockOffset + take),
        written,
      );
    blockOffset += take;
    written += take;
  }
  const effects: StereoPcm = [
    foley[0].slice(start, start + count),
    foley[1].slice(start, start + count),
  ];
  master(music, effects, start);
  for (const channel of [...music, ...effects])
    for (const sample of channel)
      if (!Number.isFinite(sample)) throw new Error("音频片段包含无效采样");
  const index = nextChunk++;
  cached.set(index, { music, foley: effects });
  if (ranges.some((range) => index >= range.from && index < range.through))
    deliver(index);
  if (nextChunk * SCORE_CHUNK_FRAMES >= length) {
    synth?.destroySynthProcessor();
    synth = undefined;
    foley = [new Float32Array(0), new Float32Array(0)];
  }
}
function pump() {
  if (failed) return;
  try {
    // Batch DSP work without one timer delay per audio chunk. Yield after a
    // bounded slice so a newer seek can replace the old requested range.
    const deadline = performance.now() + 12;
    while (
      !failed &&
      nextChunk < target &&
      nextChunk * SCORE_CHUNK_FRAMES < length
    ) {
      renderChunk();
      if (performance.now() >= deadline) break;
    }
    requestPump();
  } catch (error) {
    fail(error);
  }
}
self.onmessage = ({ data }: MessageEvent<ScoreWorkerRequest>) => {
  if (failed) return;
  if (data.type === "init") {
    if (initialized) return fail(new Error("音频线程重复初始化"));
    initialized = initialize(data);
    void initialized.catch(fail);
  } else {
    if (
      !initialized ||
      data.ranges.some(
        (range) =>
          !Number.isInteger(range.from) ||
          !Number.isInteger(range.through) ||
          range.from < 0 ||
          range.through < range.from,
      )
    )
      return fail(new Error("无效的音频片段请求"));
    ranges = data.ranges.map((range) => ({
      from: range.from,
      through: Math.min(range.through, Math.ceil(length / SCORE_CHUNK_FRAMES)),
    }));
    target = ranges.reduce((end, range) => Math.max(end, range.through), 0);
    for (const range of ranges)
      for (
        let index = range.from;
        index < Math.min(nextChunk, range.through);
        index++
      )
        deliver(index);
    requestPump();
  }
};
