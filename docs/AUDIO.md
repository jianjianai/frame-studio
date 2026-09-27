# 配乐、旁白与音效的同步制作

播放器以一条完整音轨对应一部动画。多轨在制作阶段混合，而不是让三个浏览器计时器分别控制音乐、配音与音效。

## 混音工具

项目提供 FFmpeg 驱动的本地多轨混音脚本，不额外引入音频服务、账户或云费用：

```powershell
pnpm audio:mix path/to/mix.json
```

manifest 中所有路径相对于这个 JSON 所在目录。下面示例假定 mix.json 在项目根目录：

```json
{
  "duration": 180,
  "output": "public/audio/my-film.wav",
  "license": "配乐/旁白/音效均为原创或已经授权",
  "tracks": [
    {
      "file": "public/imports/music.wav",
      "start": 0,
      "gain": 0.25,
      "fadeIn": 1,
      "fadeOut": 3
    },
    { "file": "public/imports/narration.wav", "start": 1.5, "gain": 1 },
    {
      "file": "public/imports/impact.wav",
      "start": 26,
      "gain": 0.55,
      "duration": 2
    }
  ]
}
```

每轨参数：file 源文件；start 成片中的开始秒数；trimStart 裁掉源文件开头的秒数；duration 使用的最大长度（默认到成片结束）；gain 线性增益 0–4；fadeIn/fadeOut 淡入淡出秒数。要求 1–32 轨，成片时长不超过 3600 秒。

合成为 48kHz/16bit 双声道 WAV，统一时间偏移，防削波限幅，补齐静音到准确片长。输出在 public/ 下时同步更新素材索引。源文件不改写，默认禁止覆盖成品，明确指定 --force 才可替换。输出旁边的 .mix.json 记录混音参数。

然后将 project.ts 的 audio 设置为 audio/my-film.wav。正式旁白和音效应该围绕画面设计，不要只循环一小段背景音乐撑满片长。

## 限制

当前不是 DAW：没有音频波形拖放编辑、音高保持的倍速算法、动态自动 ducking、TTS 或自动字幕对齐。可在专业音频软件制作混音后导入；本地脚本适合确定的音轨增益、偏移、裁切和淡入淡出。

播放器倍速直接改变音源播放速率，音高也会改变。正式离线导出始终是项目原始速度。
