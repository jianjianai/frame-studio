# 音轨、旁白与代码生成声音

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

`src/engine/procedural-audio.ts` 的 `createPcmAudio({ music: () => stereoPcm, foley: () => stereoPcm })` 是短片辅助接口：默认 48 kHz，生成器返回左右两个 Float32Array 或它们的 Promise。导出其 `prepareAudio` 和 `createAudio` 即可接入播放器。可选的 `prepareAudio(context)` 在公共时钟开始前准备数据；只缓存 AudioBuffer，不缓存节点、上下文或独立计时器。每个模块实例首次使用时生成一次，跨播放、跳转及离线导出复用，修改代码后重新载入生成器。

此辅助器缓存完整短片的双声道数据，48 kHz 每轨每秒约 384 KB；长片或流式音源应自行实现按片段生成的 createAudio。旧 MIDI、事件快照与测量报告保存在各项目 records 中。运行所需的原采样和许可在 public/music；createSampledScoreAudio 负责素材加载、摘要核对、后台采样与内存缓存。
