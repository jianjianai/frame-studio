# 项目语音合成

每个作品在 `production/speech.json` 选择自己的合成器、声线和角色。公共依赖由 pnpm 管理，项目不需要安装 Python 或修改根依赖；原有项目 `.mjs` 合成器接口继续兼容。

## 设计与边界

- 内置 Edge、OpenAI/兼容 Speech API、Azure Speech；自定义提供器保留项目内 `synthesize({text,voice,settings,signal}) -> Uint8Array` 接口。
- CLI 和 MCP 共用配置、校验、音频缓存、字幕和任务执行流程。初始化只建立配置，不联网、不生成声音、不覆盖现有文件。
- 角色可以指定不同提供器和声线；台词可逐句覆盖。默认严格检查绝对时间，也支持按实测时长顺序排列对白；不自动裁切或加速语音。
- 凭据只从环境变量、根 `.env` 和当前项目 `.env` 读取，不写进台词、配置、缓存键、输出或日志。兼容服务地址通过环境变量指定。
- 合成在后台 Worker 中运行，支持超时和取消；失败不切换服务或声线，不自动重试可能已经计费的合成请求。
- 生成 WAV、逐句时间线、字幕和可配置到工程的音轨信息。现有工程元数据由作者明确接入，避免覆盖镜头、字幕或其他音轨。

## 最快开始

在仓库根目录运行，把 `my-film` 换成作品 ID：

```powershell
pnpm film speech my-film init --provider edge
pnpm film speech my-film status --json
pnpm film speech my-film voices --locale zh-CN --json
pnpm film speech my-film say --text "你好，这是本项目的语音试听。" --json
pnpm film narrate my-film --input production/narration.example.json --json
```

`init` 原子创建 `production/speech.json` 与 `production/narration.example.json`，任一目标已存在就拒绝整批覆盖。已有配置用普通编辑工具按版本修改。默认选择 Edge 晓晓；可以添加 `--voice zh-CN-YunxiNeural` 改用云希。不安装 Python，不改其他作品。

临时试听也可直接显式选择公共合成器，无需先初始化：

```powershell
pnpm film speech my-film say --provider edge --voice zh-CN-YunxiNeural --text "这是一句试听。"
```

每次成功返回独立版本的 `voicePath`、`captionPath`、`manifest`、`audioTrack`、`subtitles` 和逐句测量数据。WAV 可直接播放。将返回的音轨信息加入该作品 `project.ts` 的 `audioTracks`，按作品需要合并字幕；重复调用使用缓存，不自动改写场景或工程元数据。

## 提供器和角色配置

下面的 `production/speech.json` 同时配置三个公共合成器。未使用的云端提供器不要求先填写密钥：

```json
{
  "version": 1,
  "defaultProvider": "edge",
  "providers": {
    "edge": {
      "type": "edge",
      "voice": "zh-CN-XiaoxiaoNeural",
      "settings": { "rate": "+0%", "pitch": "+0Hz", "volume": "+0%" }
    },
    "expressive": {
      "type": "openai",
      "model": "gpt-4o-mini-tts",
      "voice": "coral",
      "apiKeyEnv": "FILM_OPENAI_API_KEY",
      "settings": { "speed": 1, "instructions": "用自然、清晰的普通话讲述。" }
    },
    "azure": {
      "type": "azure",
      "voice": "zh-CN-XiaoxiaoNeural",
      "apiKeyEnv": "FILM_AZURE_SPEECH_KEY",
      "regionEnv": "FILM_AZURE_SPEECH_REGION"
    }
  },
  "speakers": {
    "narrator": { "provider": "edge" },
    "robot": { "provider": "edge", "voice": "zh-CN-YunxiNeural" },
    "guide": { "provider": "expressive" }
  }
}
```

选择优先级：句子的 `provider` → 角色的 `provider` → 台词清单的 `provider` → 项目 `defaultProvider`。声线和参数按“提供器默认值 → 清单 → 角色 → 句子”覆盖；参数逐字段合并。一个清单可以混用不同提供器，但不在失败时自动切换。

| 提供器 | 参数与用途 |
| --- | --- |
| `edge` | 无需服务密钥；中文便捷配音。`rate`、`volume` 使用带正负号的百分比，`pitch` 使用带正负号的 Hz；不支持情绪 SSML。依赖在线 Read Aloud 服务，不能当作官方 SLA。 |
| `openai` | 官方 SDK；指定 `model`、`voice`，可用 `speed` 0.25–4、`instructions`。参数支持情况取决于模型；例如旧 `tts-1` 系列不支持 instructions。 |
| `azure` | 官方 SDK；需要密钥和区域。支持 rate/pitch/volume，以及声线支持的 `style`、`styleDegree`、`role`。不支持的声线/风格由服务报告失败。 |
| `custom` | 项目自己的 `.mjs`，可以连接其他云端服务或本地模型。 |

每个提供器可设 `timeoutMs`（1000–120000，默认 120000），以及 `cacheRevision`。当自定义服务换模型权重或后台行为发生变化但接口/声线名未变时，主动更新 `cacheRevision`，使相应句子缓存失效。

`voices` 对 Edge/Azure 实时查询，支持 `--locale`、`--limit`（最多 200）、`--offset`。OpenAI 返回文档中的内置声线清单，不表示每个模型都支持所有声音；兼容服务和自定义提供器的声线由服务自身定义。

## 凭据与本地模型

可以在被 Git 忽略的 `projects/my-film/.env` 填入：

```dotenv
FILM_OPENAI_API_KEY=填写自己的密钥
FILM_AZURE_SPEECH_KEY=填写自己的密钥
FILM_AZURE_SPEECH_REGION=填写资源区域
```

优先级为进程环境变量 → 当前项目 `.env` → 仓库根 `.env`。只读取当前项目，不把值写回 `process.env`，因此多个项目可使用同名变量和不同账户。配置里只保存变量名，不接受明文 apiKey、Authorization、headers 或服务地址。服务端状态只返回变量名和是否已配置；`status` 不请求服务，不证明账户余额或在线可用性。

兼容 OpenAI `/audio/speech` 的服务使用同一个 `openai` 提供器，额外设置 `baseUrlEnv: "FILM_TTS_BASE_URL"`，在项目 `.env` 中设置实际地址，例如 `FILM_TTS_BASE_URL=http://127.0.0.1:8880/v1`。地址支持 HTTPS 或本机 HTTP，不含 URL 用户名、密码或查询参数。无鉴权的本地兼容服务也需为对应 `apiKeyEnv` 填一个非空占位值。`model` 和 `voice` 必须使用该服务实际支持的标识。

`init --provider openai|azure|custom` 可以生成对应模板。填写云端凭据后，执行 `say` 才会提交文本并可能产生服务费用；配置检查、初始化与缓存命中不会调用合成服务。合成失败没有隐式重试，避免请求已计费但响应丢失时重复提交；人工重试前先检查服务情况。

## 台词、时序与缓存

实测时长自动排列对白：

```json
{
  "mode": "sequential",
  "start": 0,
  "gap": 0.25,
  "sentences": [
    { "id": "hello", "speaker": "narrator", "text": "欢迎来到我们的故事。" },
    { "id": "reply", "speaker": "robot", "text": "我已经准备好了。", "gapAfter": 0.5 },
    { "id": "next", "speaker": "narrator", "text": "那就一起出发吧。" }
  ]
}
```

`sequential` 不接受句子的 `start`，根据实测长度加间隔计算下一句。`gapAfter` 只控制该句到下一句的停顿，片尾不追加间隔。

保持既定镜头时序时用默认的 `mode: "absolute"`，为每句填写 `start`，可加 `budget` 限制句长、顶层 `duration` 限制总长。超时不会静默截断或加速。默认拒绝重叠；确实需要两人同时说话时显式 `allowOverlap: true`，字幕与播放器呈现需要作者审看。

每句可指定已有项目音频 `audio: "production/intro.wav"`，无需调用合成器。所有音频统一转换成 48 kHz、双声道、16 位 PCM WAV。最多 200 句，每句文字最多 4096 字符，总时长最多一小时。合成原始结果上限 32 MiB，单句标准化结果上限 128 MiB。

缓存位于本项目 `.cache/narration/`。文本、声线、参数、实际模型/服务地址、适配器及其依赖内容、公共实现版本和原音频内容参与指纹；密钥不参与。只重新生成失效句子，已完成句子在后续失败时保留，重试可复用。换镜头起点或停顿不会重复请求同一句音频。旧版缓存保留，但升级后的标准化流程首次会生成新的缓存键。

输出位于 `public/narration/<version>/`：`voice.wav`、`captions.srt`、`timeline.json`。时间线包含说话角色、提供器、声线、实测起止时间和音频指纹；密钥和私有服务地址不写入输出。生成后普通播放完全使用本地文件。

## 自定义合成器兼容

旧清单 `provider: "scripts/narration-provider.mjs"` 仍有效；也可在 speech.json 注册：

```json
{
  "type": "custom",
  "module": "scripts/narration-provider.mjs",
  "dependencies": ["scripts/voice-options.json"],
  "voice": "my-voice",
  "cacheRevision": "model-v1"
}
```

模块导出 `synthesize({text,voice,settings,signal})`，返回 WAV `Uint8Array`。它在独立 Worker 中执行，`process.env` 是本次项目环境快照。不要依赖上一次合成留下的模块状态；需要跨调用资源时由项目明确管理。遵守 `signal` 可以更快释放资源，超时或取消时工作台也会终止 Worker。Worker 不是操作系统安全沙箱，自定义模块仍属于可信项目代码。

## MCP 与审听

1. `frame_speech_status`：检查项目配置与缺失变量。
2. `frame_init_speech`：建立独立项目配置，拒绝覆盖。
3. `frame_list_voices`：查声线；Edge/Azure 会联网。
4. `frame_narrate`：传 `input` 使用台词清单，或传 `text` 生成单句试听。`input` 与 `text` 互斥；单句可额外指定 provider、speaker、voice。
5. `frame_job`：查询句子进度和 `result.json`；`frame_cancel_job` 取消自己启动的任务。
6. 从结果读取 `version`，调用 `frame_read_speech`。默认返回文件信息；`name` 可以是 `voice.wav`、`captions.srt`、`timeline.json`。

支持音频输入的 AI 客户端可请求 `inlineAudio: true`，以原生 MCP WAV 音频回读，最多 6 MiB；较长成片使用认证下载。远程链接复用 OAuth/Bearer 和项目授权，支持 HEAD/Range，不开放源码或 `.env`。拿到路径或测量结果不等于已经完成听感审查。

CLI 可使用原有 `film job` 启动可查询/取消的后台 `narrate` 任务。同步 `film narrate` 和 `film speech ... say` 支持 Ctrl+C；MCP 沿用会话任务和项目锁。项目之间可以并行，同一项目的编辑、渲染与合成串行执行。

使用 OpenAI 语音时应按其服务要求向听众清楚标明 AI 合成声音；其他服务遵守相应账户条款。工作台不会自动更改影片署名或许可。

## 上游依据

- [MsEdgeTTS 项目及 MIT 许可](https://github.com/Migushthe2nd/MsEdgeTTS)：Edge Read Aloud 的社区客户端，并非 Azure 官方商业服务；依赖在线服务可用性。
- [OpenAI Speech 官方指南](https://developers.openai.com/api/docs/guides/text-to-speech)：语音生成接口及 WAV 输出；使用 `openai` 官方 SDK。
- [Azure Speech JavaScript SDK](https://github.com/microsoft/cognitive-services-speech-sdk-js)：正式 Azure 语音服务；需要用户自己的服务凭据。
