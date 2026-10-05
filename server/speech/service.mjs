import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
import * as tar from "tar";
import { SPEECH_MODELS } from "./models.mjs";
import { problem, notFound } from "../util.mjs";

const require = createRequire(import.meta.url);

/** Float32 mono samples → 16-bit PCM WAV. */
export function wavFromSamples(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index++) data.writeInt16LE(Math.max(-1, Math.min(1, samples[index])) * 32767, index * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Speech providers:
 *   edge    Microsoft Edge online voices (free, needs internet)
 *   openai  OpenAI or any OpenAI-compatible /v1/audio/speech service
 *   local:<model>  installed sherpa-onnx model, fully offline
 */
export class SpeechService {
  constructor({ config, settings, tasks, events }) {
    this.dir = path.join(config.dirs.models, "speech");
    fs.mkdirSync(this.dir, { recursive: true });
    this.settings = settings;
    this.tasks = tasks;
    this.events = events;
    this.engines = new Map();
    this.installing = new Map();
    this.edgeVoices = null;
  }
  conf() {
    return this.settings.get("speech");
  }
  modelDir(id) {
    return path.join(this.dir, id);
  }
  installed(id) {
    return fs.existsSync(path.join(this.modelDir(id), ".installed"));
  }
  models() {
    return SPEECH_MODELS.map((model) => ({ ...model, installed: this.installed(model.id), installing: this.installing.get(model.id) ?? null }));
  }
  providers() {
    const openai = this.conf().providers?.openai ?? {};
    const list = [
      { id: "edge", name: "Edge 在线语音", ready: true, detail: "免费，需要联网；中文、英文等数百种声音" },
      { id: "openai", name: "OpenAI 兼容接口", ready: Boolean(openai.baseUrl || this.settings.hasSecret("speech:openai")), detail: openai.baseUrl || "未配置" },
    ];
    for (const model of SPEECH_MODELS.filter((item) => this.installed(item.id)))
      list.push({ id: "local:" + model.id, name: `本地 · ${model.name}`, ready: true, detail: "离线运行 · " + model.languages.join(" / ") });
    return list;
  }
  defaultProvider() {
    const wanted = this.conf().defaultProvider;
    return this.providers().some((item) => item.id === wanted && item.ready)
      ? wanted
      : (this.providers().find((item) => item.id.startsWith("local:"))?.id ?? "edge");
  }
  updateSettings({ defaultProvider, openai }) {
    if (openai?.apiKey !== undefined) this.settings.setSecret("speech:openai", openai.apiKey);
    return this.settings.update("speech", (speech) => ({
      ...speech,
      ...(defaultProvider ? { defaultProvider } : {}),
      ...(openai
        ? {
            providers: {
              ...speech.providers,
              openai: { baseUrl: (openai.baseUrl || "").replace(/\/+$/, ""), model: openai.model || "", voices: openai.voices || [] },
            },
          }
        : {}),
    }));
  }

  async voices(provider = this.defaultProvider()) {
    if (provider === "edge") {
      if (!this.edgeVoices) {
        const { MsEdgeTTS } = require("msedge-tts");
        const voices = await new MsEdgeTTS().getVoices();
        this.edgeVoices = voices.map((voice) => ({
          id: voice.ShortName,
          name: `${voice.FriendlyName?.replace(/^Microsoft |\s+Online.*$/g, "") || voice.ShortName}`,
          language: voice.Locale,
          gender: voice.Gender,
        }));
      }
      return [...this.edgeVoices].sort((a, b) => Number(/^zh-CN/.test(b.language)) - Number(/^zh-CN/.test(a.language)) || a.language.localeCompare(b.language));
    }
    if (provider === "openai") {
      const voices = this.conf().providers?.openai?.voices;
      return (voices?.length ? voices : ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"]).map((voice) => ({
        id: voice,
        name: voice,
      }));
    }
    if (provider.startsWith("local:")) {
      const engine = await this.engine(provider.slice(6));
      const names = engine.speakerNames ?? [];
      return Array.from({ length: engine.numSpeakers }, (_, sid) => ({
        id: String(sid),
        name: names[sid] ? voiceLabel(names[sid]) : engine.numSpeakers > 1 ? `声音 ${sid}` : "默认声音",
        language: names[sid]?.startsWith("z") ? "zh-CN" : undefined,
      }));
    }
    throw notFound("未知语音引擎：" + provider);
  }

  /** Synthesize speech; returns { bytes, ext, duration? }. */
  async synthesize({ text, provider = this.defaultProvider(), voice, rate = 1 }) {
    text = String(text || "").trim();
    if (!text) throw problem(400, "没有要合成的文字");
    if (text.length > 5000) throw problem(400, "一次最多 5000 字，请分段生成");
    if (provider === "edge") {
      const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
      const tts = new MsEdgeTTS();
      await tts.setMetadata(voice || "zh-CN-XiaoxiaoNeural", OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(escapeSsml(text), { rate: `${Math.round((rate - 1) * 100) >= 0 ? "+" : ""}${Math.round((rate - 1) * 100)}%` });
      const chunks = [];
      for await (const chunk of audioStream) chunks.push(chunk);
      tts.close?.();
      if (!chunks.length) throw problem(502, "Edge 语音没有返回音频（检查网络或换一个声音）");
      return { bytes: Buffer.concat(chunks), ext: "mp3" };
    }
    if (provider === "openai") {
      const conf = this.conf().providers?.openai ?? {};
      const response = await fetch(`${conf.baseUrl || "https://api.openai.com/v1"}/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.settings.secret("speech:openai") ? { Authorization: "Bearer " + this.settings.secret("speech:openai") } : {}),
        },
        body: JSON.stringify({ model: conf.model || "gpt-4o-mini-tts", voice: voice || "alloy", input: text, speed: rate, response_format: "wav" }),
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok) throw problem(502, `语音接口返回 ${response.status}：${(await response.text()).slice(0, 300)}`);
      return { bytes: Buffer.from(await response.arrayBuffer()), ext: "wav" };
    }
    if (provider.startsWith("local:")) {
      const engine = await this.engine(provider.slice(6));
      const audio = await engine.generateAsync({ text, sid: Number(voice) || 0, speed: rate });
      return { bytes: wavFromSamples(audio.samples, audio.sampleRate), ext: "wav", duration: audio.samples.length / audio.sampleRate };
    }
    throw notFound("未知语音引擎：" + provider);
  }

  async engine(id) {
    if (!this.installed(id)) throw problem(400, "模型尚未安装：" + id);
    if (!this.engines.has(id))
      this.engines.set(
        id,
        this.createEngine(id).catch((error) => (this.engines.delete(id), Promise.reject(error))),
      );
    return this.engines.get(id);
  }
  async createEngine(id) {
    const sherpa = require("sherpa-onnx-node");
    const model = SPEECH_MODELS.find((item) => item.id === id);
    let dir = this.modelDir(id);
    const entries = fs.readdirSync(dir).filter((name) => !name.startsWith("."));
    if (entries.length === 1 && fs.statSync(path.join(dir, entries[0])).isDirectory()) dir = path.join(dir, entries[0]);
    const file = (name) => (fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : "");
    const onnx = fs.readdirSync(dir).filter((name) => name.endsWith(".onnx"));
    const pick = onnx.find((name) => name.includes("int8")) || onnx.find((name) => name.startsWith("model")) || onnx[0];
    const lexicons = fs
      .readdirSync(dir)
      .filter((name) => /^lexicon.*\.txt$/.test(name))
      .map((name) => path.join(dir, name))
      .join(",");
    const common = { tokens: file("tokens.txt"), dataDir: file("espeak-ng-data"), ...(file("dict") ? { dictDir: file("dict") } : {}) };
    let modelConfig;
    if (model?.type === "kokoro") modelConfig = { kokoro: { model: path.join(dir, pick), voices: file("voices.bin"), lexicon: lexicons, ...common } };
    else if (model?.type === "kitten") modelConfig = { kitten: { model: path.join(dir, pick), voices: file("voices.bin"), ...common } };
    else modelConfig = { vits: { model: path.join(dir, pick), lexicon: lexicons, ...common } };
    // Text normalization rules (dates, numbers, phone numbers) ship as *.fst files with various names.
    const ruleFsts = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".fst"))
      .map((name) => path.join(dir, name))
      .join(",");
    const tts = await sherpa.OfflineTts.createAsync({
      model: { ...modelConfig, numThreads: Math.max(1, Math.min(4, (await import("node:os")).cpus().length - 1)) },
      maxNumSentences: 2,
      ruleFsts,
    });
    try {
      tts.speakerNames = onnxSpeakerNames(path.join(dir, pick));
    } catch {}
    return tts;
  }

  /** Download + extract a model as a background task. */
  install(id) {
    const model = SPEECH_MODELS.find((item) => item.id === id);
    if (!model) throw notFound("未知模型");
    if (this.installed(id)) return null;
    if (this.installing.has(id)) throw problem(409, "正在下载这个模型");
    const target = this.modelDir(id);
    const temp = target + ".partial";
    this.installing.set(id, { progress: 0, message: "准备下载" });
    return this.tasks.start({ kind: "speech-model", title: `下载语音模型 ${model.name}` }, async ({ signal, progress }) => {
      const report = (value, message) => {
        this.installing.set(id, { progress: value, message });
        progress(value, message);
        this.events.emit({ type: "speech-models" });
      };
      try {
        fs.rmSync(temp, { recursive: true, force: true });
        fs.mkdirSync(temp, { recursive: true });
        const response = await fetch(model.archive, { signal, redirect: "follow" });
        if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
        const total = Number(response.headers.get("content-length")) || model.size;
        let received = 0;
        const counted = Readable.fromWeb(response.body).on("data", (chunk) => {
          received += chunk.length;
          if (received % (2 * 1024 * 1024) < chunk.length)
            report(Math.min(0.99, received / total), `已下载 ${(received / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`);
        });
        const bunzip = require("unbzip2-stream");
        await pipeline(counted, bunzip(), tar.x({ cwd: temp, strict: true }), { signal });
        fs.writeFileSync(path.join(temp, ".installed"), new Date().toISOString());
        fs.rmSync(target, { recursive: true, force: true });
        fs.renameSync(temp, target);
        return { model: id };
      } catch (error) {
        fs.rmSync(temp, { recursive: true, force: true });
        throw error;
      } finally {
        this.installing.delete(id);
        this.events.emit({ type: "speech-models" });
      }
    });
  }
  remove(id) {
    this.engines.delete(id);
    fs.rmSync(this.modelDir(id), { recursive: true, force: true });
    this.events.emit({ type: "speech-models" });
  }
}

/**
 * Speaker names stored by sherpa-onnx in the ONNX metadata ("speaker_names").
 * Metadata props are serialized after the graph, so only the file tail is read.
 */
export function onnxSpeakerNames(file) {
  const size = fs.statSync(file).size;
  const length = Math.min(size, 2 * 1024 * 1024);
  const buffer = Buffer.alloc(length);
  const handle = fs.openSync(file, "r");
  try {
    fs.readSync(handle, buffer, 0, length, size - length);
  } finally {
    fs.closeSync(handle);
  }
  const key = buffer.lastIndexOf("speaker_names");
  if (key < 0 || buffer[key + 13] !== 0x12) return [];
  let offset = key + 14,
    value = 0,
    shift = 0;
  for (;;) {
    const byte = buffer[offset++];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return buffer
    .subarray(offset, offset + value)
    .toString("utf8")
    .split(",")
    .filter(Boolean);
}

const voiceLabel = (name) => {
  const match = /^([abjzefhip])([fm])_(.+)$/.exec(name);
  if (!match) return name;
  const language = { a: "美式英语", b: "英式英语", z: "中文", j: "日语", e: "西班牙语", f: "法语", h: "印地语", i: "意大利语", p: "葡萄牙语" }[match[1]];
  return `${language}${match[2] === "f" ? "女声" : "男声"} ${match[3]}`;
};

const escapeSsml = (text) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
