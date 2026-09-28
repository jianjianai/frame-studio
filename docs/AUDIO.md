# 音轨、旁白与代码生成声音

通用绝对时间 PCM Worker、分轨试听/测量、逐句旁白缓存与实测字幕流水线见 [AI 制作工作流](AI-PRODUCTION.md)。这些能力复用当前音频时钟，不要求已有采样乐谱改写。

播放器直接支持多音轨，无需先合成完整混音文件。已有音乐、旁白、录音和音效素材直接配置文件音轨，由浏览器加载、解码、裁切、调音和混合；代码生成声音使用生成接口，乐器采样则加载原素材并按乐谱播放。各类音轨共用公共时间轴。

在项目 `project.ts` 配置：

```typescript
audioTracks: [
  { id: 'voice', name: '旁白', kind: 'file', src: 'films/my-film/voice.wav', start: 2, offset: 0, gain: 1 },
  { id: 'melody', name: '配乐', kind: 'generated', gain: 0.6 },
  { id: 'pulse', name: '音效', kind: 'generated', gain: 0.4 },
],
loadAudio: () => import('./audio'),
```

`audio.ts` 由脚手架提供示例，可在本项目中替换。实时播放直接调用 Web Audio，不读写预合成文件。命令行 MP4 和浏览器逐帧 WebM 都使用同一生成器在 OfflineAudioContext 中渲染，无需在导出时实时播放。完整字段、时间约定、资源释放和分段重建要求见 [AUTHORING.md](AUTHORING.md)。

每轨可配置起始时间、源偏移、时长、增益和静音，播放器也能临时调音。浏览器导出采用当前设置；命令导出采用元数据设置。需要保留调音结果时在本项目元数据中修改 gain/muted。

## 可选的文件混音

需要固定 WAV 时仍可使用：

```powershell
pnpm audio:mix my-film projects/my-film/production/mix.json
```

文件内路径相对于 manifest 所在目录，所有输入输出必须在 `projects/my-film/`：

```json
{
  "duration": 24,
  "output": "../public/audio/mix.wav",
  "license": "源音轨的作者、出处与授权",
  "tracks": [
    { "file": "../public/music.wav", "gain": 0.3, "fadeIn": 1, "fadeOut": 2 },
    { "file": "../public/voice.wav", "start": 1.5, "gain": 1 }
  ]
}
```

默认拒绝覆盖，明确加 `--force` 可替换指定输出。工具只更新该项目的素材和波形索引。FFmpeg 可通过 FFMPEG_PATH 指定。

## 现有 Demo 的原采样配乐

三个 Demo 均已接入生成音轨，`audio.ts` 提供入口，`music/score.mjs` 保存乐谱，`music/foley.mjs` 保存动作音效。两轨可独立调节。乐器部分继续使用原 GeneralUser GS 2.0.3 采样库、原乐谱和 spessasynth_core 4.3.22。素材与完整许可随各项目 public/music 保存，浏览器读取素材，在后台线程处理乐谱和声音；不使用新的合成音色替换。动作音效保留原代码与固定种子，不依赖预合成整曲 WAV。

`createSampledScoreAudio({score, foley, bank, sha256, levels})` 按需生成采样配乐，项目导出返回对象的 `prepareAudio`、`prepareSegment`、`createAudio`、`disposeAudio`。加载采样素材后先准备约半秒播放缓冲，随后按约 0.256 秒的片段生成，保持约 1.5 秒的播放余量，倍速时相应增加源音频长度。生成线程在满足请求后停止计算，不会为了启动播放而先合成整首音乐。原动作音效函数仍一次性准备，以保留原随机序列和声音细节。

`music/mix.json` 的 `music` 和 `master` 保存既定混音增益，播放时不再扫描整曲响度。当前参数从原处理流程标定：原始采样配乐的 `music = min(0.12 / RMS, 0.72 / peak)`；原 EQ 和首尾淡化处理后的音乐与动作音效相加，再由 `masterScoreTracks` 计算 -18 LUFS 与 -1.8 dB 峰值上限之间较小的总增益。`sourceEventSha256` 标记标定时的乐谱事件摘要，不是运行时检查。修改乐谱、采样、动作音效或母带处理时需要同步重新标定，不能沿用原曲的响度结论。

滤波和混响状态跨片段延续；已生成部分缓存在内存，回拖和循环复用。首次跳到尚未生成的后段时，需要从已有进度重建原乐器状态，公共时钟等待准备完成。变速、暂停或跳转会撤销旧声音节点；生成落后时暂停并提示，不继续播放缺音视频。离开播放器时释放其线程与缓存。离线导出另用生成线程，逐段等待所需音频完整就绪后编码，仍使用逐帧组帧导出。

播放器在场景就绪后预加载声音素材和所选位置的首段缓冲，不自动播放。暂停时移动时间轴也会提前准备新位置；连续拖动、暂停与变速会撤销过期准备请求，后台按当前有效区间工作。冷跳转的状态推进采用分批连续计算，每批约 12 ms 后让出执行权处理新请求，省去每个音频片段的计时器等待。页面只接收请求区间的声音，前面的状态推进结果留在后台缓存，回拖时直接取回，不重复合成。首次到达完全未生成的后段仍需实际计算原延音和混响状态，这不是常数耗时的随机定位；不会清除持续音符或缩短混响来制造快速响应。

`src/engine/procedural-audio.ts` 的 `createPcmAudio({ music: () => stereoPcm, foley: () => stereoPcm })` 是短片辅助接口：默认 48 kHz，生成器返回左右两个 Float32Array 或它们的 Promise。导出其 `prepareAudio` 和 `createAudio` 即可接入播放器。可选的 `prepareAudio(context)` 在公共时钟开始前准备数据；只缓存 AudioBuffer，不缓存节点、上下文或独立计时器。每个模块实例首次使用时生成一次，跨播放、跳转及离线导出复用，修改代码后重新载入生成器。

`createPcmAudio` 缓存完整短片的双声道数据，48 kHz 每轨每秒约 384 KB；它不会自动变为流式生成。采样乐谱的分段缓存同样会随已访问时长增长，超长影片应另行实现有界缓存与状态快照。旧 MIDI、事件快照与测量报告保存在各项目 records 中。运行所需的原采样和许可在 public/music；createSampledScoreAudio 负责素材加载、摘要核对、按需后台采样与内存缓存。
