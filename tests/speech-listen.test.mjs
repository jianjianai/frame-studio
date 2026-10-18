import { describe, expect, it } from "vitest";
import { Listening, lowpass, RATE, voiceLog } from "../server/speech/listen.mjs";

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

  it("lets finished sentences go before the one being spoken, and counts what it heard", async () => {
    const sent = [];
    let calls = 0;
    const { recognize } = recognizer(40);
    const session = new Listening({ vad: new FakeVad(), recognize: (samples) => (calls++, recognize(samples)), send: (message) => sent.push(message) });
    session.feed(concat(tone(1, 0.3), silence(0.2)));
    session.feed(tone(1, 0.6)); // the first sentence is still being recognized: no partial yet
    expect(calls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    session.feed(silence(0.03));
    expect(calls).toBe(2);
    await session.finish();
    expect(sent.filter((message) => message.type === "final").map((message) => message.text)).toEqual(["你好。", "Hello world."]);
    expect(session.summary()).toMatchObject({ seconds: 2.2, peak: expect.closeTo(0.6, 2), sentences: 2, error: null });
    expect(session.summary().speech).toBeGreaterThan(1.9);
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

describe("voice input log", () => {
  it("says how far a voice input got and on which browser, without what was said", () => {
    const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
    const heard = { seconds: 4.9, peak: 0.42, speech: 3.1, sentences: 1, partials: 3, error: null };
    expect(voiceLog({ ended: "停止", seconds: 5.23, rate: 16000, heard, client: { blocks: 49 }, agent: edge })).toBe(
      '语音输入停止 5.2 秒；收到 4.9 秒音频（16000 Hz，最大 0.42），说话 3.1 秒，1 句，3 次中间结果；浏览器：{"blocks":49}；Edge 141 / Windows',
    );
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    expect(voiceLog({ ended: "取消", seconds: 2, rate: null, agent: iphone })).toBe("语音输入取消 2.0 秒；麦克风没有打开；Safari 18 / iPhone");
    const wechat = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36 MicroMessenger/8.0";
    expect(voiceLog({ ended: "停止", seconds: 1, rate: 48000, agent: wechat })).toMatch(/没有开始识别；Chrome 141 \/ Android（微信）$/);
  });
});
