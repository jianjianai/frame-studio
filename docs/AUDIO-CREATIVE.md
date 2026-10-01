# 音频创作：Tone 与 Signalsmith

Frame 8.1 将 Tone 15.1.22 完整宿主绑定 API 和 Signalsmith Stretch 1.3.2 官方 WASM/AudioWorklet 接到同一宿主音频时间轴。既能在项目代码中自由组合声音，也能直接在权威 audio.json 中做独立移调、保调变速和 Tone 效果。旧作品保持原来的默认声音行为。

## AI 从准确接口开始

```sh
pnpm --silent film capabilities --category audio --json
pnpm --silent film capabilities --query Sampler --json
pnpm --silent film capabilities --id signalsmith --json
pnpm --silent film capabilities --id audio-processor-tone --json
pnpm --silent film reference audio-creative --json
pnpm --silent film context my-film --json
```

CLI、MCP frame_capabilities 和任务内 work-tool 的发现来自同一目录。tone-source、tone-instrument、tone-effect、tone-event、tone-component、tone-signal、tone-core 返回相应官方导出；query 可以按任何类名检索。项目代码位于 projects/<id>/，素材位于该项目 public/，通过 films/<id>/... 和 assetUrl 定位。不要猜测工程音频权威来源：先查看 context.authority。

## 选择入口

| 任务                                         | 入口                                          | 使用方式                                                     |
| -------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| 从一段单音采样写旋律、和弦或鼓点             | createSamplerAudio                            | 原始音高映射、音符列表、片段切片与包络；准备后按共享时间演奏 |
| 用任意 Tone 合成器演奏音符                   | createToneSequence                            | 提供乐器工厂和音符列表                                       |
| 自由组合整个 Tone 库                         | createToneAudio                               | build 中得到完整 HostTone、toneContext 和宿主调度参数        |
| 用 Part/Sequence/Loop/Transport 编排有限乐谱 | createToneTimeline                            | 初次生成受预算约束的浏览器 PCM，之后精确跳转和导出           |
| 文件片段独立移调或保调变速                   | audio.json 的 pitch / preservePitch / stretch | 可直接保存与编辑，不需要另写生成器                           |
| 完整 Signalsmith 节点编程                    | createSignalsmithNode                         | 官方调度、输入缓冲、流式处理、循环、共振峰与配置方法         |
| 项目内 Signalsmith 音频生成器                | createSignalsmithAudio                        | 根据源时间重建和准备，实时播放与离线导出共用实现             |

公开模块：src/engine/audio-adapters.ts、audio-authoring.ts、signalsmith-audio.ts。底层 Tone 节点可以任意组合，不限于示例乐器或效果。

## 一份采样写旋律

```ts
// projects/my-film/audio.ts
import { createAudioRack } from "../../src/engine/audio-adapters";
import { createSamplerAudio } from "../../src/engine/audio-authoring";

const sampler = createSamplerAudio({
  samples: { C4: "films/my-film/music/note-c4.wav" },
  notes: [
    { at: 0, duration: 0.4, note: "C4", velocity: 0.8 },
    { at: 0.5, duration: 0.4, note: "E4", velocity: 0.65 },
    { at: 1, duration: 0.8, note: "G4", velocity: 0.7 },
    { at: 2, duration: 0.8, note: "C4", velocity: 0.6 },
    { at: 2, duration: 0.8, note: "E4", velocity: 0.6 },
    { at: 2, duration: 0.8, note: "G4", velocity: 0.6 },
  ],
  attack: 0.005,
  release: 0.04,
  gain: 0.45,
});
export const { generators, createAudio } = createAudioRack({ sampler });
```

project.ts 声明 loadAudio: () => import('./audio') 和 loadAudioDocument: () => import('./audio.json')。混音文档至少包含：

```json
{
  "schemaVersion": 1,
  "sources": [
    {
      "id": "instrument",
      "kind": "generated",
      "module": "sampler",
      "engine": "web-audio"
    }
  ],
  "tracks": [
    { "id": "music", "name": "采样旋律", "gain": 0.7, "output": "master" }
  ],
  "clips": [
    {
      "id": "phrase",
      "track": "music",
      "source": "instrument",
      "start": 0,
      "duration": 3
    }
  ],
  "buses": [],
  "master": { "gain": 1 }
}
```

samples 的键是已知原音，如 C4 或 MIDI 数字字符串；多份采样按距离选择原音，减少过度变调。note 可以为科学音高字符串或 MIDI 数值；at/duration 是源时间秒，velocity 为 0..1，pan 为 -1..1。sampleOffset/sampleDuration 选择采样中的一小段。采样播放变调会改变采样消耗速度；需要独立时间拉伸时使用 Signalsmith。

## 合成器与短采样处理的便利层

```ts
import { createToneSequence } from "../../src/engine/audio-authoring";
import { createSignalsmithAudio } from "../../src/engine/signalsmith-audio";

const melody = createToneSequence({
  notes: [{ at: 0, duration: 1, note: "A4", velocity: 0.7 }],
  instrument: ({ Tone, toneContext }) =>
    new Tone.FMSynth({ context: toneContext, volume: -12 }),
  tailSeconds: 0.5,
});

// supplySample 返回项目采样的 AudioBuffer；加载素材时使用 assetUrl。
const shifted = createSignalsmithAudio({
  buffers: supplySample,
  configuration: { preset: "default" },
  schedule: { semitones: 7, formantCompensation: true },
});
```

createToneSequence 为不同音符从起音生成可重用、受预算约束的 PCM，跳转到延音中间时按源时间读取，不重新触发 Attack。乐器工厂每个声音独立实例；共享总线效果放 audio.json。maxBufferBytes 调整缓存预算，极长音符应使用自定义流式生成器。

Sampler 可配置 attack、decay、sustain、release、loop.start/end 和 maxBufferBytes；采样映射使用 assetUrl 解析后的版本，素材改变会重新准备。官方 Signalsmith 1.3.2 的 Web 包对未来调度、读指针、循环和 configure 有兼容修复，版本固定且逐项检查原源码匹配，WASM 算法保持官方实现。

## 文件片段：音高与速度分开

```json
{
  "id": "vocal",
  "track": "voice",
  "source": "recording",
  "start": 0,
  "duration": 4,
  "offset": 1.2,
  "rate": 1.2,
  "pitch": 3,
  "preservePitch": true,
  "stretch": {
    "preset": "default",
    "formantCompensation": true,
    "formantBaseHz": 180
  },
  "fadeIn": 0.02,
  "fadeOut": 0.05
}
```

pitch 是额外半音移调；preservePitch 控制 rate 的变速是否保持原音高。默认 pitch=0、preservePitch=false，兼容原有变速带动音高的行为。stretch 可以配置 tonalityHz、formantSemitones、formantCompensation、formantBaseHz、preset、blockMs、intervalMs、splitComputation；参数含义对应官方 Signalsmith 接口。实际输出依素材、变化幅度和窗口设置，避免把极端移调当作无损操作。

## Tone 的全部效果

轨道、总线和主输出均可以使用通用 Tone 处理器：

```json
{
  "type": "tone",
  "effect": "Chorus",
  "options": { "frequency": 1.5, "delayTime": 3.5, "depth": 0.7, "wet": 0.4 },
  "tail": 2
}
```

可用效果：AutoFilter、AutoPanner、AutoWah、BitCrusher、Chebyshev、Chorus、Distortion、FeedbackDelay、FrequencyShifter、Freeverb、JCReverb、Phaser、PingPongDelay、PitchShift、Reverb、StereoWidener、Tremolo、Vibrato。options 使用该官方类的参数；tail 声明预滚动/尾音需要的秒数。效果可以与现有 EQ、压缩、延迟和混响组成链，排序会改变结果。异步准备完成后才启动音频。

音频编辑器选中轨道、总线或主输出后，在处理链添加“Tone.js 效果”，即可选择全部 18 种效果并调常用参数。高级“完整官方参数 JSON”支持时间/频率表达式、嵌套配置与其他官方选项；修改单个常用参数会保留其他配置。非法 JSON 不应用、不覆盖已有参数，可恢复当前参数。效果顺序、启用、删除与保存沿用混音文档的版本保护。

Tone 的频移 FrequencyShifter 与半音移调 PitchShift 不是同一种效果：前者把频率整体加减固定 Hz，可产生非谐波音色；后者按音程改变音高。

## 完整库 API 的生命周期

createToneAudio 的 build 接收 Tone（HostTone）、toneContext、context、destination、when、offset、duration、rate 及片段处理参数；ready 会被宿主等待。可提供 prepare 钩子准备样本、WASM 或其他异步资源。所有类自动绑定本实例 toneContext，节点可以显式传 context，连接 destination 或使用 toDestination()；返回 dispose 释放本实例资源。

HostTone 提供全部类及 Transport、Destination、Draw、Listener、context、相应 get 方法、now/immediate/loaded、版本和支持状态。Time/Frequency/Midi/Ticks/TransportTime 工厂使用本实例上下文。Tone.start() 由宿主管理，不另启音频；setContext 明确拒绝替换宿主，借用上下文的 close/resume 不关闭或启动公共 AudioContext。不要直接导入全局 tone 命名空间绕过适配器。 Tone.Context 创建同一宿主 AudioContext 的借用包装，子 Transport 跟随宿主时间推进；不会另起原生音频时钟。

官方事件、信号、分析、录音和输入类可自由组合。Recorder 录制已有声音，不自行申请麦克风。UserMedia 使用下述可信工作台输入桥；用于正式导出的设备输入应先固化成项目素材。原始 createToneAudio 的跨切点事件状态、延音和随机源需要按 offset 重建；需要自由编排且自动支持任意跳转时使用下面的有限乐谱入口。

```ts
import { createToneTimeline } from "../../src/engine/audio-authoring";
import { createAudioRack } from "../../src/engine/audio-adapters";

const score = createToneTimeline({
  duration: 8, // 包含需要保留的尾音
  build: ({ Tone }) => {
    Tone.Transport.bpm.value = 100;
    const synth = new Tone.PolySynth(Tone.Synth).toDestination();
    new Tone.Part(
      (time, note) => {
        synth.triggerAttackRelease(note, "8n", time, 0.6);
      },
      [
        [0, "C4"],
        [0.6, "E4"],
        [1.2, "G4"],
      ],
    ).start(0);
    new Tone.Sequence(
      (time, note) => {
        synth.triggerAttackRelease(note, "16n", time, 0.4);
      },
      ["C3", "G3", "E3", "G3"],
      "8n",
    )
      .start(2)
      .stop(6);
    // 默认从源时间 0 启动 Transport；节点在准备结束后自动释放。
  },
});
export const { generators, createAudio } = createAudioRack({ score });
```

createToneTimeline 只在明确选用时准备完整有限乐谱，正常工程不因此强制预合成全片。默认 48kHz、双声道、128MiB PCM 预算，启动前检查 duration × sampleRate × channels × 4；超出预算明确报错。build 可异步返回或返回 {ready, dispose}，renderBuffer(signal) 返回同一份 PCM，可传 createSignalsmithAudio 的 buffers 做独立音高、速度与共振峰处理。取消/释放中止过期准备并清除缓存。初次准备需要计算和内存；长乐谱使用 createToneSequence 的有界音符准备或可重建的流式生成器。

HostTone.Offline 的回调多提供一个绑定离线上下文的命名空间：

```ts
const buffer = await Tone.Offline((offlineContext, offlineTone) => {
  new offlineTone.Synth().toDestination().triggerAttackRelease("A4", 0.2, 0);
}, 0.5);
```

回调内部使用 offlineTone，不能捕获外层 Tone 构造节点。有限离线渲染也受 128MiB 预算保护。

createSignalsmithNode(context, options, signal) 保留官方完整接口：

| 方法/属性                     | 用途                                                 |
| ----------------------------- | ---------------------------------------------------- |
| schedule                      | 以宿主输出时间调度输入位置、倍率、半音、共振峰和循环 |
| start / stop                  | 立即或指定宿主时间启动/停止                          |
| addBuffers                    | 添加声道 Float32Array，支持增量流式添加              |
| dropBuffers                   | 释放全部或指定源时间之前的缓冲                       |
| inputTime / setUpdateInterval | 查询输入进度并控制回调更新间隔                       |
| latency                       | 查询处理延迟，提前调度并补偿                         |
| configure                     | 预设、窗口、计算间隔和分散计算                       |
| dispose                       | 停止节点、释放端口和连接，保留宿主上下文             |

底层 createSignalsmithNode 的 schedule/start 保留官方的有限数值 rate：0 冻结当前缓冲位置，负值向较早的位置倒读输入缓冲。缓冲模式须提供要读取的样本；负速循环的音质与环绕语义没有本框架额外保证。宿主播放时间线与 createSignalsmithAudio 便利层要求 rate 为正值，避免无效时长、除零或逆向调度；需要冻结或倒读时在项目代码中使用底层节点并按宿主输出时间调用 stop。

对实时输入的变速不能凭空获得未来音频；官方 live-input 模式忽略 sample-buffer 的位置、速度和循环参数。需要拉伸素材时先提供缓冲。不要把 live-input 节点当成离线素材处理的替代品。

## 真实麦克风与录音

```ts
import {
  createAudioRack,
  createToneAudio,
} from "../../src/engine/audio-adapters";

const liveInput = createToneAudio(({ Tone }) => {
  const input = new Tone.UserMedia({ volume: -6 });
  const filter = new Tone.Filter(1200, "lowpass").toDestination();
  input.connect(filter);
  return {
    ready: input.open(), // 可传 enumerateDevices 返回的音频输入 deviceId
    dispose: () => {
      input.dispose();
      filter.dispose();
    },
  };
});
export const { generators, createAudio } = createAudioRack({ liveInput });
```

工程调用 UserMedia.open 时，当前工作台会显示麦克风请求，由用户明确允许或拒绝。允许后才调用浏览器原生授权。可信父页面采集声音，通过验证来源的 MessageChannel 和有界 PCM 缓冲接入该实例的宿主 AudioContext；预览继续保持 opaque iframe，不增加同源权限。取消准备、关闭输入、切换作品或关闭预览会释放本请求；最后一个输入释放后停止自有麦克风轨道和采集上下文。

UserMedia 的 volume、mute、connect、close、state、设备信息与设备枚举沿用 Tone 使用方式。可将输入连接 Meter/Analyser、任意 Tone 效果或 Signalsmith live-input 节点，再用 Recorder 记录需要的片段。Recorder 也可录制合成器或采样器输出；此时不需要麦克风授权。

麦克风是当前真实声音，跳转不会重放过去的设备输入。浏览器离线上下文和正式导出明确拒绝活麦克风，需先录制并保存为项目 public 素材，再用文件轨道或 Sampler。完整预览缓存保存程序与项目文件，不保存未来设备输入。

## 有界准备与连续声音

实时音频以当前时间附近的窗口准备，首次缓存验收不会合成整段长音乐。ToneSequence 并发准备最多两个音符；Signalsmith 长素材和含 Tone 文档效果的离线混音使用固定 2 秒处理窗口、历史预滚动和交叉淡化，处理 PCM 默认 32MiB，避免持续播放不断增加内存。任意切点读取同一处理网格，保持连续播放、跳转和离线分段的一致性。

## 预览与导出

原始模式和完整缓存模式把原素材交给浏览器。压缩模式仅影响交互预览的媒体传输。音乐算法、效果、混音和正式导出不改写源素材；正式导出读取原始资源。缓存完成消除已收录资源的网络等待，解码、合成与绘制仍需要计算，所以播放器继续做音视频准备和共同时钟缓冲。

验证至少包括正常播放、随机跳转、速率/音高变化、连续保存、取消、错误恢复及离线导出；以真实浏览器和输出 PCM 证明处理效果，不能只通过类型检查判断音质。

官方参考：[Tone 15.1.22](https://tonejs.github.io/docs/15.1.22/index.html)、[Signalsmith Web](https://github.com/Signalsmith-Audio/signalsmith-stretch/blob/main/web/release/README.md)。库许可分别按项目依赖的原始许可证保留。
