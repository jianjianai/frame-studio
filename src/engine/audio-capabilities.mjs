/**
 * Pure audio capability metadata shared by schema validation and authoring discovery.
 * Keep these ids aligned with the implemented source adapters and processor schemas.
 *
 * @typedef {"web-audio" | "tone" | "worker-pcm" | "soundfont" | "custom"} AudioEngineId
 * @typedef {"gain" | "pan" | "filter" | "compressor" | "limiter" | "delay" | "reverb" | "distortion" | "stereo" | "duck"} AudioProcessorId
 */

/** @type {{id: AudioEngineId, name: string, realtime: boolean, offline: boolean}[]} */
export const audioEngines = [
  { id: "web-audio", name: "Web Audio", realtime: true, offline: true },
  { id: "tone", name: "Tone.js", realtime: true, offline: true },
  {
    id: "worker-pcm",
    name: "PCM Worker / WASM",
    realtime: true,
    offline: true,
  },
  { id: "soundfont", name: "SoundFont / MIDI", realtime: true, offline: true },
  { id: "custom", name: "项目自定义生成器", realtime: true, offline: true },
];

/** @type {{id: AudioProcessorId, name: string}[]} */
export const audioProcessors = [
  { id: "gain", name: "增益" },
  { id: "pan", name: "声像" },
  { id: "filter", name: "均衡 / 滤波" },
  { id: "compressor", name: "压缩" },
  { id: "limiter", name: "峰值保护" },
  { id: "delay", name: "延迟" },
  { id: "reverb", name: "混响" },
  { id: "distortion", name: "失真" },
  { id: "stereo", name: "立体声宽度" },
  { id: "duck", name: "旁白避让" },
];
