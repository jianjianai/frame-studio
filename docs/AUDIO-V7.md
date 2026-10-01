# V7 多轨音频

V8 创作页默认使用增量实时预览，保存源码后更新；音频不再先整片生成并切块。弱网播放、不可变版本与正式导出规则见 [V8 实时预览](V8-LIVE-PREVIEW.md)。

V7 将音源、混音轨道、时间片段、分组总线和主输出分开。工程音频的权威文档是项目内的 `audio.json`，由 `project.ts` 的 `loadAudioDocument: () => import('./audio.json')` 声明。旧 `audio`、`audioTracks` 和 `loadAudio` 仍兼容；未启用文档的作品不会自动迁移。编辑器首次保存会用同一个原子编辑同时新增文档与入口。已声明文档时，它覆盖旧音轨定义，避免重复播放。

## 编辑与混音

工作台左侧“音频”打开多轨编辑器。先添加或选择音源、音轨，再添加片段；可拖动、跨轨移动、左右裁切、按播放头分割、变速、循环、设置素材入点、淡入淡出、声像及音量关键帧。Alt 拖动取消帧吸附。轨道允许重叠片段；相邻片段的淡化可组成交叉淡化。分割保留素材相位与原自动化时间。撤销/重做保留最近 50 次本地修改，保存混音后更新作品预览即可试听。

轨道和总线有增益、声像、静音、效果链、输出总线及后级发送。输出图必须无环。主输出负责最终作品增益与处理。播放头控制同步到画面。播放器的监听音量、临时静音/独奏不写入工程，也不进入正式导出；需要交付的混音必须保存到文档。作品静音保存在轨道/片段中。

素材波形通过服务端逐块扫描真实双声道 PCM 得到，展示源素材幅度；波形不假装包含之后的效果、自动化或生成器声音。选择文件音源可查看采样率、声道、峰值、RMS 和满幅采样计数。版本过期会拒绝保存，保留本地修改；“放弃未保存修改”重新读取服务器版本。未保存草稿会暂存在当前浏览器标签页，重新进入编辑器时恢复；服务器版本变化仍会触发冲突保护。离开页面前，浏览器会提示未保存修改。

## 文档例子

以下片段放在至少 12 秒的作品中：

```json
{
  "schemaVersion": 1,
  "sources": [
    { "id": "voice", "kind": "file", "src": "films/my-film/voice.wav" },
    {
      "id": "music",
      "kind": "generated",
      "module": "synth",
      "trackId": "main",
      "engine": "tone"
    }
  ],
  "tracks": [
    { "id": "speech", "name": "旁白", "output": "master" },
    {
      "id": "score",
      "name": "配乐",
      "gain": 0.4,
      "output": "musicBus",
      "processors": [
        {
          "type": "duck",
          "track": "speech",
          "amount": 0.3,
          "attack": 0.03,
          "release": 0.3
        }
      ]
    }
  ],
  "clips": [
    {
      "id": "line",
      "track": "speech",
      "source": "voice",
      "start": 2,
      "duration": 4,
      "fadeIn": 0.02,
      "fadeOut": 0.08
    },
    {
      "id": "bed",
      "track": "score",
      "source": "music",
      "start": 0,
      "duration": 12,
      "fadeIn": 1,
      "fadeOut": 2
    }
  ],
  "buses": [
    {
      "id": "musicBus",
      "name": "音乐总线",
      "processors": [{ "type": "reverb", "mix": 0.15, "seconds": 1.2 }]
    }
  ],
  "master": { "gain": 1, "processors": [{ "type": "limiter", "ceiling": -1 }] },
  "linkedVideo": true
}
```

省略字段由公共 schema 填默认值。最多 256 音源、64 轨道、1024 片段、16 总线、每通道 16 处理器、8 发送。资源只能属于当前项目。`linkedVideo` 控制合成视频原声是否继续参与混音。默认播放速度仍改变采样速率与音高。Frame 8.1 的片段 pitch 独立调整半音，preservePitch 保调变速，stretch 控制 Signalsmith 的共振峰与窗口；Tone 全部效果和代码采样乐器见 [AUDIO-CREATIVE.md](AUDIO-CREATIVE.md)。

## 生成器

引擎注册表列出 Web Audio、Tone.js、Signalsmith Stretch、PCM Worker/WASM、SoundFont/MIDI 和自定义生成器。标签是能力说明；实际代码通过项目的 `loadAudio` 模块导出 `generators` 注册表。多个框架可在一个工程混用，均接收宿主上下文和绝对调度时间，不另启全局时钟。

```ts
// projects/my-film/audio.ts
import {
  createAudioRack,
  createToneAudio,
} from "../../src/engine/audio-adapters";

const synth = createToneAudio(
  ({ Tone, toneContext, destination, when, offset, duration, rate }) => {
    const instrument = new Tone.Synth({ context: toneContext, volume: -20 });
    instrument.connect(destination);
    // Source-time notes reconstruct correctly for arbitrary clip offsets.
    const period = 0.5;
    for (
      let t = Math.ceil(offset / period) * period;
      t < offset + duration;
      t += period
    )
      instrument.triggerAttackRelease(
        "A4",
        0.12 / rate,
        when + (t - offset) / rate,
      );
    return { dispose: () => instrument.dispose() };
  },
);
export const { generators, createAudio } = createAudioRack({ synth });
```

Tone 实例必须显式传入 `toneContext`，避免 `Tone.start()`、`setContext()` 或全局 Transport。宿主提供的上下文不能由生成器关闭。示例为短音序列；有跨切点延音的乐器应自行重建持续音符状态。适配器不承诺把任意使用全局状态的第三方音频代码自动变成可跳转生成器。

V8 的 `createToneAudio` 按需导入 Tone 的类入口，准备声音时不触发公共 `tone` 入口对全局 Transport、Destination 和原生上下文的提前初始化；传给生成器的 `Tone` 是类命名空间。每个节点仍显式使用 `toneContext`，适配器只释放自己的包装器，宿主 AudioContext 由播放器管理。Tone 某些类的默认参数在首次创建节点时仍可能惰性初始化库自己的默认上下文；Frame 不改写或擅自销毁第三方全局上下文。参数和源码更新复用已有宿主上下文，不为每次修改创建新上下文。计算音高可使用 `new Tone.FrequencyClass(toneContext, 'A3')`，避免隐式全局上下文。

`createWorkerPcmAudio` 在 Worker 内生成绝对时间 PCM，可封装 WASM DSP；`createSampledScoreAudio` 继续使用 SoundFont/MIDI 原采样与原乐谱。其使用与资源约束见 [AUDIO.md](AUDIO.md) 和 [AI-PRODUCTION.md](AI-PRODUCTION.md)。`module:"legacy"` 直接选择原来的 `createAudio`，便于兼容迁移。

## 效果处理

| 类型       | 实现与用途                                                        |
| ---------- | ----------------------------------------------------------------- |
| gain / pan | 增益与等功率声像                                                  |
| filter     | 高低通、带通、陷波、高低搁架、峰值 EQ、全通；多段 EQ 用多个滤波器 |
| compressor | 阈值、拐点、压缩比、起音、释放                                    |
| limiter    | 压缩器加硬采样峰值保护；不是过采样真峰值母带限制器                |
| delay      | 可调时长、反馈、干湿比                                            |
| reverb     | 固定种子双声道卷积脉冲、尾音、衰减、干湿比                        |
| distortion | 非线性 WaveShaper，4 倍过采样                                     |
| stereo     | 中侧矩阵控制立体声宽度                                            |
| duck       | 按触发轨道片段时间避让；不是检测实际信号包络的侧链压缩            |

所有处理器可关闭、排序和删除，轨道、总线与主输出共用同一实现。原生节点工作在浮点域。工程不会偷偷自动归一化混音；交付时查看响度/真峰值报告，必要时降低主增益或添加峰值保护。素材降噪、修复、保调变速、VST/AU 插件、录音输入及环绕声并未在本版本冒充为已支持。

## 格式与导出

文件素材使用 Mediabunny 的实际格式识别与浏览器解码能力。验收环境直接测试 WAV、FLAC、MP3、Ogg/Opus、M4A/AAC；不同浏览器的编解码器可能不同。AIFF、CAF、WMA 等可以导入，再通过“转换副本”转换成兼容 WAV/FLAC。转换从不覆盖原文件或已有目的文件，音视频源均可抽取首条音频流。当前混音/导出为 48 kHz 双声道；文件解码对常见 3 声道、四声道、5.0/5.1 做双声道降混（中置/环绕按矩阵混入，5.1 的 LFE 不混入），保留中置人声；超过 6 声道或特殊布局需先转换为双声道副本。

```sh
pnpm film audio engines --json
pnpm film audio my-film --json
pnpm film audio my-film edit --input projects/my-film/production/audio-edit.json --json
pnpm film audio-media my-film inspect --src films/my-film/voice.wav
pnpm film audio-media my-film transcode --src films/my-film/voice.aiff --out public/voice-compatible.wav
pnpm film audio my-film export --format flac --stems --start 0 --end 12
```

独立音频导出支持 WAV 24-bit、FLAC、MP3 192k、Ogg/Opus 160k、M4A/AAC 192k。通过原始浮点 PCM 转码，不先量化为 16 位。输出位于本作品 `exports/audio-<uuid>/`，包含混音、可选分轨和响度/真峰值/静音报告。分轨按通道独奏，经其总线、发送与主输出链；非线性处理存在时，各分轨相加不保证等于最终混音。程序代码与素材先冻结，再进行导出。视频 MP4/WebM 沿用公共离线渲染器。

本地 MCP 对应 `frame_audio_engines`、`frame_audio`、`frame_audio_edit`、`frame_audio_inspect`、`frame_audio_transcode`、`frame_audio_export`。平台 MCP 对应 `frame_works_audio`、`frame_works_audio_edit`、`frame_works_audio_inspect`、`frame_works_audio_media_probe`、`frame_works_audio_transcode`。GUI/CLI/MCP 文档编辑使用同一个 schema 和服务，保存传入上次读取的 SHA-256；首次迁移同时要求 project.ts 的 SHA-256。

## 调度与资源边界

新文档预览直接调度原素材/生成器；不先生成全片 MP3。文件按 0.5 秒区间解码，重复素材片段共享 48 kHz 双声道 PCM，LRU 缓存预算 128 MiB，打开的压缩源最多 8 个、每源缓存 2 MiB。播放按 1.5 秒余量调度，声音节点结束即回收。活动文件片段的预缓冲工作集超出 128 MiB 时，在解码前提示降低速度、减少重叠或预先导出分轨，不反复解码后才失败。离线声音节点可继续持有已经从 LRU 淘汰的区间，因而“128 MiB”不是包含渲染上下文和活动节点的全进程内存上限。

离线每次请求最多 10 秒，根据链路效果尾音额外重建预滚动并裁出目标区间，保证常规效果在分段和跳转时连续。若所需历史超过 120 秒，明确报错，避免悄悄截断效果历史。实时暂停、跳转会重建效果节点；跳转后的历史混响尾音不会瞬间重建。生成器内部历史状态仍由其自身实现。实时解码或生成跟不上时暂停并报告，不让无声画面继续播放。

旧作品继续采用旧渐进文件/分块压缩预览路径，代理音质从 64k 提升到 192k，正式导出始终读原源。旧短片整段 PCM 和旧 SoundFont 缓存的边界见 AUDIO.md；新的文件缓存不能替代它们内部的状态管理。
