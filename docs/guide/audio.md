# audio：音乐、音效、配音与混音

声音由 `audio.json`（混音文档）描述，`project.ts` 声明 `loadAudioDocument: () => import("./audio.json")`。用户在时间轴上看到的音轨就是这里的 tracks 与 clips。

最省事的方法是用工具：

- `audio_place`：把 `public/` 中的音频文件放到某条音轨的某个时间（音轨不存在会自动创建，audio.json 不存在会自动创建并在 project.ts 中声明）。
- `speech_synthesize`：生成配音并可直接放到「配音」音轨（见 `speech`）。
- `audio_get` / `audio_edit`：读取或原子修改混音文档（`update` 只改一项的部分字段）。
- `preview_audio`：响度检查；`src` 指向配乐文件并加 `beats: true` 时给出 BPM、拍号、每个节拍和每小节第一拍的时间，用来把切点放在节拍上、段落和大的画面变化放在小节开头（文件内时间换算到作品时间：片段 `start` + 文件内时间 − 片段 `offset`）。

## 混音原则（用户的要求，必须遵守）

- **音效响时不要压低音乐**：不给音乐加由音效触发的 `duck`，也不要用音量自动化在音效处把音乐压下去。音效和音乐的平衡靠各自的音量（`gain`）和 EQ 调好。
- **只有人声（配音、旁白）才可能压低音乐，而且要用户明确要求**：用户说了“说话时压低音乐”之类的话，才在音乐轨加 `duck`（`track` 指向人声音轨）。没要求时，靠把音乐整体调低让人声清楚。

## audio.json 结构

```json
{
  "schemaVersion": 1,
  "sources": [
    { "id": "bgm", "kind": "file", "src": "films/work-1a2b3c4d/music/bgm.mp3" },
    { "id": "vo1", "kind": "file", "src": "films/work-1a2b3c4d/voice/line1.mp3" },
    { "id": "synth", "kind": "generated", "module": "pad", "trackId": "main", "engine": "tone" }
  ],
  "tracks": [
    { "id": "music", "name": "配乐", "gain": 0.45 },
    { "id": "voice", "name": "配音", "gain": 1, "processors": [{ "type": "compressor" }] },
    { "id": "fx", "name": "音效", "gain": 0.8, "sends": [{ "bus": "space", "gain": 0.3 }] }
  ],
  "clips": [
    { "id": "c1", "track": "music", "source": "bgm", "start": 0, "duration": 15, "fadeIn": 1, "fadeOut": 2 },
    { "id": "c2", "track": "voice", "source": "vo1", "start": 1.2, "duration": 3.4 },
    { "id": "c3", "track": "fx", "source": "synth", "start": 5, "duration": 4 }
  ],
  "buses": [{ "id": "space", "name": "混响", "processors": [{ "type": "reverb", "seconds": 2, "mix": 1 }] }],
  "master": { "gain": 1, "processors": [{ "type": "limiter", "ceiling": -1 }] }
}
```

- clip：`start`/`duration` 是作品时间；`offset` 是素材内起点；`rate` 速度（默认变调，`preservePitch: true` 保持音高）；`pitch` 半音移调；`gain` 0–4；`pan` -1–1；`fadeIn`/`fadeOut`；`loop` 循环长度；`automation: [{at, value}]` 音量自动化（at 为片段内时间）；`muted`。
- 片段不能超过作品时长；所有 id 唯一、字母开头。
- 处理器（轨道/总线/master 的 `processors`）：`gain`、`pan`、`filter`（type/frequency/q/gain）、`compressor`、`limiter`、`delay`、`reverb`、`distortion`、`stereo`、`duck`（被 `track` 指定的音轨触发时压低本轨。只用于人声避让，而且要用户明确要求，见上面的混音原则）、`tone`（任意 Tone.js 效果：`{ "type": "tone", "effect": "Chorus", "options": { "wet": 0.4 } }`，effect 可选 AutoFilter、AutoPanner、AutoWah、BitCrusher、Chebyshev、Chorus、Distortion、FeedbackDelay、FrequencyShifter、Freeverb、JCReverb、PingPongDelay、PitchShift、Phaser、Reverb、StereoWidener、Tremolo、Vibrato）。
- 音轨/总线：`id`、`name`（必填），`gain` 0–4、`pan`、`muted`、`processors`、`output`（默认 `master`，或某个总线 id）、`sends: [{ bus, gain }]`。
- 处理器参数（都可省略用默认值）：`gain{gain}`、`pan{pan}`、`filter{type: lowpass|highpass|bandpass|notch|lowshelf|highshelf|peaking|allpass, frequency, q, gain}`、`compressor{threshold, knee, ratio, attack, release}`、`limiter{ceiling, release}`、`delay{time, feedback, mix}`、`reverb{seconds, decay, mix}`、`distortion{drive, mix}`、`stereo{width}`、`duck{track, amount, attack, release}`、`tone{effect, options, tail}`。

## audio_edit 操作

按顺序执行，全部成功才写入；`dryRun: true` 只校验。

```json
{ "operations": [
  { "op": "put", "collection": "sources", "value": { "id": "bgm", "kind": "file", "src": "films/work-1a2b3c4d/music/bgm.mp3" } },
  { "op": "put", "collection": "tracks", "value": { "id": "music", "name": "配乐", "gain": 0.6 } },
  { "op": "put", "collection": "clips", "value": { "id": "c1", "track": "music", "source": "bgm", "start": 0, "duration": 15, "fadeOut": 2 } },
  { "op": "update", "collection": "clips", "id": "c1", "patch": { "gain": 0.8, "fadeIn": 0.5 } },
  { "op": "update", "collection": "master", "patch": { "gain": 0.9 } },
  { "op": "split", "id": "c1", "at": 8, "newId": "c1b" },
  { "op": "remove", "collection": "clips", "id": "c1b" }
]}
```

- `update`：按 collection（sources/tracks/clips/buses/master）+ id 只改 `patch` 里的字段，嵌套对象逐项合并，数组（processors、automation、sends）整体替换；`unset` 删除字段（有默认值的字段恢复默认）。改音量、时间、淡入淡出、静音都用它。
- `put`：在 sources/tracks/clips/buses 中新增一项，或用完整内容**整项替换** id 相同的一项。
- `audio_get` 每项一行，省略取默认值的字段。
- `remove`：按 collection + id 删除；`split`：在作品时间 `at` 切开片段；`replace`：`{ "op": "replace", "document": {…} }` 替换整个文档。
- 只是把一个文件放上音轨时，`audio_place` 更简单。

## 代码生成的声音

在 `audio.ts` 中用 `createAudioRack` 注册生成器，source 的 `module` 对应这里的名字；`project.ts` 再加 `loadAudio: () => import("./audio")`。生成器必须能从任意时间点开始重建（跳转、导出都会这样调用），不能使用自己的时钟。

```ts
// audio.ts
import { createAudioRack, createToneSequence, createSamplerAudio, createToneAudio } from "../../src/engine/audio-adapters";

// 1) 合成器旋律：每个音符独立实例，跳转到延音中间也正确
const melody = createToneSequence({
  notes: [
    { at: 0, duration: 0.5, note: "C4", velocity: 0.7 },
    { at: 0.5, duration: 0.5, note: "E4", velocity: 0.6 },
    { at: 1, duration: 1, note: "G4", velocity: 0.7 },
  ],
  instrument: ({ Tone, toneContext }) => new Tone.Synth({ context: toneContext, oscillator: { type: "triangle" }, volume: -10 }),
  tailSeconds: 0.6,
});

// 2) 采样乐器：用一个（或多个）采样演奏任意音高
const piano = createSamplerAudio({
  samples: { C4: "films/work-1a2b3c4d/samples/piano-c4.wav" },
  notes: [{ at: 0, duration: 1.5, note: "A3", velocity: 0.8 }],
  attack: 0.005,
  release: 0.3,
});

// 3) 完全自由：拿到宿主绑定的完整 Tone 库，在给定的时间窗口内调度
const noise = createToneAudio(({ Tone, toneContext, destination, when, offset, duration }) => {
  const source = new Tone.Noise({ context: toneContext, type: "pink", volume: -24 }).connect(destination);
  source.start(when, offset).stop(when + duration);
  return { dispose: () => source.dispose() };
});

export const { generators, createAudio } = createAudioRack({ melody, piano, noise });
```

```json
{ "id": "melodySrc", "kind": "generated", "module": "melody", "engine": "tone" }
```

- 较长的乐谱（Part/Sequence/Transport）用 `createToneTimeline({ duration, build })`：首次生成整段 PCM，之后精确跳转。
- 纯数学合成可以用 `createPcmAudio({ main: () => [left, right] })`（`src/engine/procedural-audio.ts`），适合短音效。
- 最底层：导出 `createAudio({ context, destination, when, offset, duration, rate })`，用 Web Audio 节点在 `when` 时刻播放源时间 `offset` 起的 `duration` 秒，返回 `{ dispose }`。

## 检查

- 改完声音用 `preview_audio` 看响度：对白一般 RMS −20 到 −16 dBFS，峰值不要超过 −1 dBFS（master 加 limiter）。
- `silentWindows` 很多说明声音没有接上（检查 source、clip 时间和 project.ts 的声明）。
