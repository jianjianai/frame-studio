import { createRequire } from "node:module";
import { RECOGNITION_MODELS } from "./models.mjs";

const require = createRequire(import.meta.url);

export const RATE = 16000;
const WINDOW = 512; // Silero VAD frame at 16 kHz
const LOOKBACK = 16; // windows (0.5 s) kept before speech starts: the VAD notices it late, quiet speech later still
const PARTIAL_MIN = RATE / 2;
const PARTIAL_GAP = 300;
const MAX_SECONDS = 600;

const concat = (parts) => {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) out.set(part, offset), (offset += part.length);
  return out;
};

/**
 * A low-pass filter for downsampling to `toRate`: the linear resampler alone folds everything
 * above 8 kHz back into the speech band, which costs recognition accuracy.
 */
export function lowpass(fromRate, toRate, taps = 63) {
  const cutoff = (0.45 * toRate) / fromRate;
  const kernel = new Float32Array(taps);
  for (let index = 0; index < taps; index++) {
    const offset = index - (taps - 1) / 2;
    const sinc = offset === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * offset) / (Math.PI * offset);
    kernel[index] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * index) / (taps - 1)));
  }
  const sum = kernel.reduce((total, value) => total + value, 0);
  for (let index = 0; index < taps; index++) kernel[index] /= sum;
  let history = new Float32Array(taps - 1);
  return (samples) => {
    const input = concat([history, samples]);
    const out = new Float32Array(samples.length);
    for (let index = 0; index < out.length; index++) {
      let total = 0;
      for (let tap = 0; tap < taps; tap++) total += kernel[tap] * input[index + taps - 1 - tap];
      out[index] = total;
    }
    history = input.slice(input.length - (taps - 1));
    return out;
  };
}

/**
 * One voice input: 16-bit PCM from the browser's microphone in, text out. The VAD cuts the
 * audio at pauses and each finished sentence is recognized ("final"); the sentence still
 * being spoken is recognized again now and then ("partial"), so words show while the user
 * talks. Messages carry the sentence number: a partial is for the sentence after the last
 * final, and results of one that has been finished since are dropped.
 */
export class Listening {
  constructor({ vad, recognize, send, partials = true, resample = (samples) => samples }) {
    Object.assign(this, { vad, recognize, send, partials, resample });
    this.pending = new Float32Array(0);
    this.speech = [];
    this.speechLength = 0;
    this.recent = [];
    this.sentence = 0;
    this.finals = Promise.resolve();
    this.partialBusy = false;
    this.partialAt = 0;
    this.closed = false;
    this.failed = false;
    this.finalsPending = 0;
    this.partialGap = PARTIAL_GAP;
    // What was heard, for the user when nothing came of it and for the log.
    this.heard = { samples: 0, peak: 0, speech: 0, sentences: 0, partials: 0, error: null };
  }

  summary() {
    const { samples, peak, speech, sentences, partials, error } = this.heard;
    const seconds = (count) => Math.round((count / RATE) * 10) / 10;
    return { seconds: seconds(samples), peak: Math.round(peak * 1000) / 1000, speech: seconds(speech), sentences, partials, error };
  }

  /** Little-endian Int16 samples, as the browser sends them. */
  push(bytes) {
    if (this.closed) return;
    const copy = new Uint8Array(bytes); // also aligns the view for Int16Array
    const pcm = new Int16Array(copy.buffer, 0, copy.length >> 1);
    const samples = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index++) samples[index] = pcm[index] / 32768;
    this.feed(this.resample(samples));
  }

  feed(samples) {
    const all = concat([this.pending, samples]);
    let offset = 0;
    for (; offset + WINDOW <= all.length; offset += WINDOW) this.frame(all.slice(offset, offset + WINDOW));
    this.pending = all.slice(offset);
    this.maybePartial();
  }

  frame(samples) {
    this.vad.acceptWaveform(samples);
    this.heard.samples += samples.length;
    for (const value of samples) if (Math.abs(value) > this.heard.peak) this.heard.peak = Math.abs(value);
    if (this.vad.isDetected()) {
      this.heard.speech += samples.length;
      if (!this.speechLength) (this.speech = [...this.recent]), (this.speechLength = this.recent.reduce((sum, part) => sum + part.length, 0));
      this.speech.push(samples);
      this.speechLength += samples.length;
    } else {
      this.recent.push(samples);
      if (this.recent.length > LOOKBACK) this.recent.shift();
    }
    this.drain();
  }

  /** Finished sentences: recognized in order (the service decodes one at a time), sent in order. */
  drain() {
    while (!this.vad.isEmpty()) {
      // The sentence as kept here, with the moment before the VAD noticed it: its own segment
      // can clip the first syllable. Copied out (false): pop() frees the segment's buffer.
      const samples = this.speechLength ? concat(this.speech) : this.vad.front(false).samples;
      this.vad.pop();
      const sentence = this.sentence++;
      this.speech = [];
      this.speechLength = 0;
      const result = this.recognize(samples);
      this.finalsPending++;
      this.finals = this.finals.then(() =>
        result
          .then(
            (text) => text && (this.heard.sentences++, this.send({ type: "final", sentence, text })),
            (error) => this.fail(error),
          )
          .finally(() => this.finalsPending--),
      );
    }
  }

  /** Finished sentences go first; on a busy server partials come less often (as often as they take). */
  maybePartial() {
    if (!this.partials || this.partialBusy || this.finalsPending || this.closed || this.failed) return;
    if (this.speechLength < PARTIAL_MIN || Date.now() - this.partialAt < this.partialGap) return;
    const sentence = this.sentence;
    const began = Date.now();
    this.partialBusy = true;
    this.recognize(concat(this.speech))
      .then(
        (text) => text && sentence === this.sentence && !this.closed && (this.heard.partials++, this.send({ type: "partial", sentence, text })),
        () => {}, // the sentence's final result reports what went wrong
      )
      .finally(() => {
        this.partialBusy = false;
        this.partialAt = Date.now();
        this.partialGap = Math.max(PARTIAL_GAP, this.partialAt - began);
      });
  }

  fail(error) {
    if (this.failed) return;
    this.failed = true;
    this.heard.error = error?.message ?? String(error);
    this.send({ type: "error", message: this.heard.error });
  }

  /** The user stopped: what was said last becomes a sentence too; resolves once every sentence is sent. */
  async finish() {
    if (this.closed) return;
    if (this.pending.length) {
      const last = new Float32Array(WINDOW);
      last.set(this.pending);
      this.pending = new Float32Array(0);
      this.frame(last);
    }
    this.vad.flush();
    this.drain();
    this.closed = true;
    await this.finals;
  }

  close() {
    this.closed = true;
  }
}

/**
 * The /api/speech/listen socket: {"type":"start","rate":<Hz>} once the browser's microphone is
 * open, then binary frames of audio, then {"type":"stop"}. The browser connects while the user
 * is still being asked for the microphone, so a missing engine shows up right away.
 */
export function listenSocket(speech) {
  return (ws, req) => {
    const opened = Date.now();
    const send = (message) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));
    const end = (message) => {
      send(message);
      ws.close();
    };
    const provider = speech.recognitionProvider();
    if (!provider) {
      const model = RECOGNITION_MODELS[0];
      const installing = speech.installing.get(model.id);
      return end(
        installing
          ? { type: "error", code: "INSTALLING", message: `语音识别模型正在下载（${installing.message}），下载完成后再试` }
          : {
              type: "error",
              code: "NO_RECOGNIZER",
              message: "还没有语音识别引擎：在 设置 → 语音 下载识别模型，或配置识别接口",
              model: { id: model.id, name: model.name, size: model.size },
            },
      );
    }
    const local = provider.startsWith("local:");
    // Loaded while the microphone opens and the first sentence is spoken.
    if (local) speech.recognizer(provider.slice(6)).catch(() => {});
    const vadModel = speech.vadModel();
    vadModel.catch(() => {});
    send({ type: "ready", provider });

    const early = [];
    let session = null;
    let starting = null;
    let stopping = false;
    let rate = null;
    let ended = "取消"; // what the user did: 停止 (kept the text) unless the socket just closed
    let client = null; // what the browser saw: audio blocks, loudness, its audio graph
    const limit = setTimeout(() => void stop(), MAX_SECONDS * 1000);

    async function begin() {
      const { Vad, LinearResampler } = require("sherpa-onnx-node");
      const vad = new Vad(
        {
          // Pauses shorter than 0.6 s stay inside a sentence; long monologues are cut at 20 s. A low
          // threshold: quiet speech counts too, while fans, typing and hiss stay below it.
          sileroVad: { model: await vadModel, threshold: 0.3, minSilenceDuration: 0.6, minSpeechDuration: 0.15, windowSize: WINDOW, maxSpeechDuration: 20 },
          sampleRate: RATE,
          numThreads: 1,
          debug: 0,
        },
        60,
      );
      const resampler = rate === RATE ? null : new LinearResampler(rate, RATE);
      const filter = rate > RATE ? lowpass(rate, RATE) : (samples) => samples;
      session = new Listening({
        vad,
        // A service answers per request: partial results would cost one call each.
        partials: local,
        recognize: (samples) => speech.recognize(provider, samples),
        resample: resampler ? (samples) => resampler.resample(filter(samples)) : undefined,
        send,
      });
      for (const data of early.splice(0)) session.push(data);
    }
    async function stop() {
      if (stopping) return;
      stopping = true;
      clearTimeout(limit);
      await starting;
      await session?.finish();
      end({ type: "done", heard: session?.summary() ?? null });
    }

    ws.on("message", (data, binary) => {
      if (binary) {
        if (!stopping) session ? session.push(data) : early.push(data);
        return;
      }
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.type === "start" && !starting) {
        rate = Math.min(192000, Math.max(8000, Math.round(Number(message.rate)) || RATE));
        starting = begin().catch((error) => end({ type: "error", message: error?.message ?? String(error) }));
      }
      if (message.type === "stop") {
        ended = "停止";
        client = message.client ?? null;
        void stop();
      }
    });
    ws.on("close", () => {
      clearTimeout(limit);
      stopping = true;
      session?.close();
      console.log(voiceLog({ ended, seconds: (Date.now() - opened) / 1000, rate, heard: session?.summary(), client, agent: req?.headers["user-agent"] }));
    });
  };
}

/** One log line per voice input, without what was said: enough to tell why nothing came out. */
export function voiceLog({ ended, seconds, rate, heard, client, agent }) {
  const parts = [`语音输入${ended} ${seconds.toFixed(1)} 秒`];
  if (!heard) parts.push(rate ? "没有开始识别" : "麦克风没有打开");
  else
    parts.push(
      `收到 ${heard.seconds} 秒音频（${rate} Hz，最大 ${heard.peak}），说话 ${heard.speech} 秒，${heard.sentences} 句，${heard.partials} 次中间结果` +
        (heard.error ? `，出错：${heard.error}` : ""),
    );
  if (client) parts.push(`浏览器：${JSON.stringify(client)}`);
  parts.push(browserName(agent));
  return parts.join("；");
}

const BROWSERS = [
  ["Edge", /Edg(?:e|A|iOS)?\/(\d+)/],
  ["Opera", /OPR\/(\d+)/],
  ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
  ["Chrome", /(?:Chrome|CriOS)\/(\d+)/],
  ["Safari", /Version\/(\d+).*Safari/],
];
const browserName = (agent = "") => {
  const [name, version] = BROWSERS.map(([name, pattern]) => [name, pattern.exec(agent)?.[1]]).find(([, version]) => version) ?? ["未知浏览器", ""];
  const system = ["iPhone", "iPad", "Android", "Mac OS X", "Windows", "Linux"].find((name) => agent.includes(name)) ?? "未知系统";
  return `${name} ${version} / ${system}${/MicroMessenger/.test(agent) ? "（微信）" : ""}`.replace("  ", " ");
};
