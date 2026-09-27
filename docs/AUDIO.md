# 音轨、旁白与代码生成声音

播放器直接支持多音轨，无需先合成完整混音文件。文件音轨和代码生成音轨可以同时播放，统一使用公共时间轴。

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

三个现有 Demo 保留原来的已提交音频。`pnpm music:build <id>` 可选重建指定作品的采样音乐、MIDI 和动作音效；只写该项目目录。它需要采样库及 FFmpeg，不是新实时音频接口的必需步骤。
