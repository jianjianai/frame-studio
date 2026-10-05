# speech：配音

- `speech_voices`：列出可用引擎和声音。引擎：`edge`（在线、免费，中文常用 `zh-CN-XiaoxiaoNeural` 女声、`zh-CN-YunxiNeural` 男声）、`openai`（用户配置的 OpenAI 兼容接口）、`local:<模型>`（用户安装的离线模型，声音 id 是数字）。
- `speech_synthesize`：把一段文字生成到 `public/voice/`，返回地址和时长。传 `place: { start: 秒, track: "配音" }` 直接放到时间轴。

## 做法

1. 按句子分段生成，每句一个文件，便于和画面对齐、单独替换。
2. 根据返回的 `duration` 安排后续句子的 `start`，句间留 0.2–0.5 秒。
3. 同步更新 `project.ts` 的 `subtitles`，让字幕与配音时间一致。
4. 有背景音乐时，在音乐轨加 `duck` 处理器（`"track": "<配音音轨 id>"`），说话时自动压低音乐。
5. 用 `preview_audio` 检查配音段的响度。

`rate` 0.5–2 调整语速。没有可用引擎时，请用户在 设置 → 语音 中下载本地模型或配置服务。
