import { describe, expect, it } from "vitest";
import { Listening, lowpass, RATE } from "../server/speech/listen.mjs";

const tone = (seconds, amplitude) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, index) => amplitude * Math.sin(index / 3));
const silence = (seconds) => new Float32Array(Math.round(seconds * RATE));
const concat = (...parts) => Float32Array.from(parts.flatMap((part) => [...part]));

/** Like sherpa-onnx's VAD: speech is loud windows; a segment ends after three quiet ones. */
class FakeVad {
  segments = [];
  current = null;
  quiet = 0;
  acceptWaveform(samples) {
    const loud = samples.some((value) => Math.abs(value) > 0.05);
    if (!loud && !this.current) return;
    (this.current ??= []).push(samples);
    this.quiet = loud ? 0 : this.quiet + 1;
    if (this.quiet >= 3) this.flush();
  }
  flush() {
    if (this.current) this.segments.push({ samples: concat(...this.current) });
    this.current = null;
    this.quiet = 0;
  }
  isDetected() {
    return Boolean(this.current);
  }
  isEmpty() {
    return !this.segments.length;
  }
  front() {
    return this.segments[0];
  }
  pop() {
    this.segments.shift();
  }
}

/** "Recognizes" a sentence by its loudness, and remembers what it was given. */
const recognizer = (delay = 0) => {
  const heard = [];
  const recognize = async (samples) => {
    heard.push(samples.length);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    return peak > 0.4 ? "Hello world." : "你好。";
  };
  return { recognize, heard };
};

describe("voice input sessions", () => {
  it("sends each sentence once it ends, in order, numbered", async () => {
    const sent = [];
    const { recognize } = recognizer(5);
    const session = new Listening({ vad: new FakeVad(), recognize, send: (message) => sent.push(message), partials: false });
    session.feed(concat(tone(1, 0.3), silence(0.5), tone(1, 0.6), silence(0.5)));
    await session.finish();
    expect(sent).toEqual([
      { type: "final", sentence: 0, text: "你好。" },
      { type: "final", sentence: 1, text: "Hello world." },
    ]);
  });

  it("keeps the moment before speech was noticed, and finishes the sentence cut off by stop", async () => {
    const sent = [];
    const { recognize, heard } = recognizer();
    const session = new Listening({ vad: new FakeVad(), recognize, send: (message) => sent.push(message), partials: false });
    session.feed(concat(silence(1), tone(0.8, 0.3)));
    await session.finish();
    expect(sent).toEqual([{ type: "final", sentence: 0, text: "你好。" }]);
    // 0.8 s of speech plus the windows kept before it, padded to whole 512-sample windows.
    expect(heard[0]).toBeGreaterThan(0.8 * RATE + 2 * 512);
  });

  it("shows the sentence being spoken, and drops what is late for a finished one", async () => {
    const sent = [];
    const { recognize } = recognizer(30);
    const session = new Listening({ vad: new FakeVad(), recognize, send: (message) => sent.push(message) });
    session.feed(tone(1, 0.3)); // long enough for a partial result
    session.feed(silence(0.5)); // ends the sentence while that partial is still being recognized
    await session.finish();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sent).toEqual([{ type: "final", sentence: 0, text: "你好。" }]);

    const live = [];
    const later = new Listening({ vad: new FakeVad(), recognize: recognizer().recognize, send: (message) => live.push(message) });
    later.feed(tone(1, 0.3));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(live).toEqual([{ type: "partial", sentence: 0, text: "你好。" }]);
  });

  it("takes 16-bit samples from any byte offset", async () => {
    const sent = [];
    const session = new Listening({ vad: new FakeVad(), recognize: recognizer().recognize, send: (message) => sent.push(message), partials: false });
    const pcm = Int16Array.from(tone(1, 0.6), (value) => value * 32767);
    const bytes = Buffer.alloc(pcm.byteLength + 1);
    Buffer.from(pcm.buffer).copy(bytes, 1);
    session.push(bytes.subarray(1));
    await session.finish();
    expect(sent).toEqual([{ type: "final", sentence: 0, text: "Hello world." }]);
  });

  it("reports a failed recognition once", async () => {
    const sent = [];
    const session = new Listening({ vad: new FakeVad(), recognize: async () => Promise.reject(new Error("模型坏了")), send: (message) => sent.push(message), partials: false });
    session.feed(concat(tone(0.5, 0.3), silence(0.3), tone(0.5, 0.3), silence(0.3)));
    await session.finish();
    expect(sent).toEqual([{ type: "error", message: "模型坏了" }]);
  });
});

describe("downsampling filter", () => {
  const gain = (frequency) => {
    const filter = lowpass(48000, RATE);
    const input = Float32Array.from({ length: 4800 }, (_, index) => Math.sin((2 * Math.PI * frequency * index) / 48000));
    const output = filter(input.subarray(0, 2400));
    const rest = filter(input.subarray(2400)); // state carries over between blocks
    const tail = concat(output, rest).subarray(1000);
    return Math.sqrt(tail.reduce((sum, value) => sum + value * value, 0) / tail.length) * Math.SQRT2;
  };
  it("passes speech and removes what would fold back below 8 kHz", () => {
    expect(gain(1000)).toBeCloseTo(1, 1);
    expect(gain(14000)).toBeLessThan(0.05);
  });
});
