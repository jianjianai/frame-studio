# speech：配音

- `speech_voices`：列出可用引擎和声音。引擎：`edge`（在线、免费，中文常用 `zh-CN-XiaoxiaoNeural` 女声、`zh-CN-YunxiNeural` 男声）、`openai`（用户配置的 OpenAI 兼容接口）、`local:<模型>`（用户安装的离线模型，声音 id 是数字）。
- `speech_voices`：默认只列中文声音，`language: "en"` 等切换，`"all"` 列出全部。
- `speech_synthesize`：把文字生成到 `public/voice/`，返回地址和时长。

## 整段旁白：一次调用

```json
{
  "lines": [
    { "text": "欢迎了解我们的新产品。" },
    { "text": "它更轻、更快。", "gap": 0.6 },
    { "text": "现在就来试试吧。" }
  ],
  "voice": "zh-CN-YunxiNeural",
  "place": { "start": 1, "track": "配音" },
  "subtitles": true
}
```

- 每句生成一个文件，从 `place.start` 起依次排在音轨上，句间隔 `gap`（默认 0.3 秒，单句可覆盖）。
- `subtitles: true` 按每句的实际时间写入字幕（替换同一时间段的旧字幕）。
- 返回每句的开始、结束时间和最后一句的结束时间，用来安排画面节奏；旁白比作品长时先用 `work_update` 延长 `duration`。
- 只重做某一句：用 `text` 生成单句并 `place` 到原来的开始时间，再用 `audio_edit` 删除旧片段。

## 做法

1. 按句子分段，便于和画面对齐、单独替换。
2. 画面的关键动作对准每句的开始时间（`work_update` 的 `beats` 可以标出来）。
3. 有背景音乐时，在音乐轨加 `duck` 处理器（`"track": "<配音音轨 id>"`），说话时自动压低音乐。
4. 用 `preview_audio` 检查配音段的响度。

`rate` 0.5–2 调整语速。没有可用引擎时，请用户在 设置 → 语音 中下载本地模型或配置服务。
