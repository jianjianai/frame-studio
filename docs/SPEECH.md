# 项目语音合成

每个作品在 `production/speech.json` 选择自己的合成器、声线和角色。公共依赖由 pnpm 管理，项目不需要安装 Python 或修改根依赖；原有项目 `.mjs` 合成器接口继续兼容。

## 设计与边界

- 内置 Edge、OpenAI/兼容 Speech API、Azure Speech、MiniMax、豆包、ElevenLabs 和可选 Qwen3 bridge；自定义提供器保留项目内 `synthesize({text,voice,settings,signal}) -> Uint8Array` 接口。
- CLI 和 MCP 共用配置、校验、音频缓存、字幕和任务执行流程。初始化只建立配置，不联网、不生成声音、不覆盖现有文件。
- 角色可以指定不同提供器和声线；台词可逐句覆盖。默认严格检查绝对时间，也支持按实测时长顺序排列对白；不自动裁切或加速语音。
- 凭据只从环境变量、根 `.env` 和当前项目 `.env` 读取，不写进台词、配置、缓存键、输出或日志。兼容服务地址通过环境变量指定。
- 合成在后台 Worker 中运行，支持超时和取消；失败不切换服务或声线，不自动重试可能已经计费的合成请求。
- 生成 WAV、逐句时间线、字幕和可配置到工程的音轨信息。现有工程元数据由作者明确接入，避免覆盖镜头、字幕或其他音轨。

## 统一能力与平台接口

平台设置页、作品配音、平台 MCP/CLI 与项目旁白共享 `scripts/tts-capabilities.mjs` 的能力定义，HTTP 请求统一由 `scripts/tts-adapters.mjs` 映射。Edge/Azure 和可信项目自定义代码继续走原有 Worker。内置 Kokoro、Melo、Piper 保留原服务、声线和模型安装流程，不新增模型下载。

平台操作可从 `/api/actions/<name>`、MCP `frame_<name>`、`pnpm film platform describe <name> --json` 发现具体 schema：

| 操作                               | 用途                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `speech_providers`                 | 不联网的提供商预设、已核实模型及默认能力                                  |
| `engines_list`                     | 已配置引擎、具体 model/voice 能力和凭据存在性，无密钥                     |
| `engines_discover`                 | 已配置引擎目录；ElevenLabs 支持 cursor/search；不创建或克隆音色           |
| `speech_test`                      | 24 小时临时试听；接受旧 text/voice/speed，以及 options/fallback/requestId |
| `works_speech` / `speech_generate` | 同样的表达 schema，用于正式作品 / 素材合成                                |
| `works_speech_adopt`               | 将已确认试听的原始音频直接采用，零次重新合成                              |
| `speech_status` / `speech_cancel`  | 查询或取消本次 requestId，终止本地等待和 HTTP 连接                        |

平台调用保留旧参数。扩展表达统一放在 `options` 内；项目 JSON 的 `settings` 仍为扁平字段，CLI `--options` 会转换为这个格式。未填控制使用服务默认值，speed 默认 1。能力由 provider、model 和 voice 共同决定；未知模型不获得猜测性的扩展能力。

```json
{
  "engine": "已配置引擎 UUID",
  "text": "重庆，新的旅程，从这里开始。",
  "speed": 0.95,
  "options": {
    "language": "Chinese",
    "emotion": "calm",
    "pronunciation": [{ "word": "重庆", "phonetic": "(chong2)(qing4)" }],
    "pauses": [{ "after": 3, "seconds": 0.5 }]
  }
}
```

上例适用于 MiniMax 支持的模型。after 是原文 UTF-16 字符偏移（重庆逗号之后为 3），不接受重复、末尾、越界或拆开 emoji 的偏移；适配器按原文偏移插入提供商真实停顿标记。发音字典按服务格式填写，不自动推测人名读音。

不支持的控制默认报 `TTS_CAPABILITY`，在请求发出前失败。平台明确指定 `fallback: "omit"` 才会丢弃不支持的项，并返回 `warnings` 和实际 `applied`；从不自动切换模型、音色或付费服务。项目旁白保持严格失败，不隐式降级。UI 仅显示当前模型支持的控制；更换音色后遗留的不支持项会提示清除。

进度显示准备、连接、接收字节、验证等实际阶段，不虚构百分比。客户端生成唯一 UUID requestId 再合成，重复 ID 拒绝重新发起；服务状态最多保留十分钟，进程重启会丢失，不能当成账单或持久幂等保证。状态的 succeeded 表示音频合成完成，资产保存仍以原操作最终返回为准。取消不能撤销远端已接受的计费，也不能保证远端推理停止。合成无自动重试；超时/断线结果未知，先检查请求状态、素材和服务后台，再人工重试。目录只有明确 429/503 拒绝才重试一次，最长等待 5 秒。

## 中文与电影旁白的实际选择

| 适配器 / 模型                                    | 真实表达控制                                                                                 | 限制与默认                                                                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Kokoro / Melo / Piper / compatible               | text、voice、speed                                                                           | 保留原协议；不伪造情感、指令或发音字典                                                                                          |
| MiniMax speech-2.8-hd / turbo 等文档模型         | language_boost、emotion、pitch、拼音 tone 字典、显式停顿                                     | 默认 2.8-hd；2.6 才暴露 fluent/whisper；不映射 OpenAI 自由指令                                                                  |
| 豆包 seed-tts-2.0 / 1.0                          | speech_rate、post_process.pitch；已核实的 2.0 系统音色可用 context_texts                     | model 是资源 ID，新 X-Api-Key 协议；仅默认 zh_female_vv_uranus_bigtts 开放指令，其余音色先保守处理，旧 appid/token 协议暂不实现 |
| OpenAI gpt-4o-mini-tts / 文档快照                | instructions、speed 0.25–4、模型对应内置音色                                                 | 默认 cedar；tts-1/hd 没有 instructions，音色主要优化英语，中文先试听                                                            |
| Eleven multilingual_v2 / flash_v2_5 / turbo_v2_5 | speed 0.7–1.2、stability、similarity、style、最长 3 秒 SSML pause、前后文、已有字典 locators | 账号实时音色目录；中文长旁白先试听 multilingual_v2；字典使用已有 alias 规则                                                     |
| Eleven v3                                        | 离散 stability 0 / 0.5 / 1；正文音频标签；speed 0.7–1.2                                      | 没有本适配器的 SSML pause、自由 instructions、字典与连续性字段                                                                  |
| Eleven v4 / v4_turbo                             | stability、similarity；正文音频标签                                                          | 已取消 speed 和 style；保持 1×，不发送这两项；不支持 SSML break                                                                 |
| Qwen3 CustomVoice 1.7B / 0.6B                    | 语言提示；1.7B 可用 instruct                                                                 | 可选 Frame bridge；0.6B 无指令，两个模型都没有原生 speed 控制；无强制 GPU 依赖                                                  |

高质量中文旁白先选已配置账号的中文音色，使用一小段包含人名、多音字、数字和情绪转折的文本试听。把稿件写成自然短句，先校正重音和读音，再决定额外停顿。MiniMax 用 calm、字典和适量停顿；支持 instructions 的模型可在 UI 点“自然中文”或“电影旁白”，描述沉稳、克制、自然呼吸和关键轻重音。提示只是模型尽力执行的方向，不等于声音品质保证。

保持同一音色、模型和表达设置贯穿旁白。分句后通过 sequential 实测时长与 gapAfter 对齐；Eleven v2 可传 previousText/nextText 减少语气突变。避免每句都放长停顿或过强情感，确认试听后优先采用同一音频。审听音色、读音、节奏和情绪，再接入时间轴、字幕与音乐混音。

```sh
pnpm film speech my-film init --provider minimax
pnpm film speech my-film status --json
pnpm film speech my-film voices --json
pnpm film speech my-film say --text "重庆，新的旅程，从这里开始。" --speed 0.95 --emotion calm --language Chinese --options '{"pronunciation":[{"word":"重庆","phonetic":"(chong2)(qing4)"}],"pauses":[{"after":3,"seconds":0.5}]}' --json
# 指令只用于已确认支持的模型；不要向 MiniMax 发送这项。
pnpm film speech my-film say --provider expressive --text "风穿过山谷，新的故事开始了。" --instructions "用沉稳克制的普通话电影旁白，自然呼吸，避免广告腔。" --json
```

第二条 say 中 expressive 是下方项目配置的 OpenAI profile，不是提供商自动切换。平台 AI 可先读 `frame_speech_providers` 与 `frame_engines_list`，查询 `frame_engines_discover`，再用相同 options 试听和正式合成；项目 MCP `frame_narrate` 的单句 text 也接受 speed/options，JSON plan 仍用 settings。

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

| 提供器   | 参数与用途                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edge`   | 无需服务密钥；中文便捷配音。`rate`、`volume` 使用带正负号的百分比，`pitch` 使用带正负号的 Hz；不支持情绪 SSML。依赖在线 Read Aloud 服务，不能当作官方 SLA。 |
| `openai` | 官方 HTTP 适配器；指定 `model`、`voice`，可用 `speed` 0.25–4、`instructions`。参数支持情况取决于模型；例如旧 `tts-1` 系列不支持 instructions。              |
| `azure`  | 官方 SDK；需要密钥和区域。支持 rate/pitch/volume，以及声线支持的 `style`、`styleDegree`、`role`。不支持的声线/风格由服务报告失败。                          |
| `custom` | 项目自己的 `.mjs`，可以连接其他云端服务或本地模型。                                                                                                         |

每个提供器可设 `timeoutMs`（1000–120000，默认 120000），以及 `cacheRevision`。当自定义服务换模型权重或后台行为发生变化但接口/声线名未变时，主动更新 `cacheRevision`，使相应句子缓存失效。

`voices` 对 Edge/Azure 实时查询，支持 `--locale`、`--limit`（最多 200）、`--offset`。OpenAI 按具体模型返回文档声线；MiniMax 查询系统音色，ElevenLabs 查询账号音色与可见 TTS 模型，可用 `--cursor` / `--search` 继续分页；Qwen bridge 查询本地已加载模型。`source` 区分实时、文档与手动目录。没有完整语言元数据的目录不假装按 locale 过滤。兼容服务和自定义提供器的声线由服务自身定义。

## 凭据与本地模型

可以在被 Git 忽略的 `projects/my-film/.env` 填入：

```dotenv
FILM_OPENAI_API_KEY=填写自己的密钥
FILM_AZURE_SPEECH_KEY=填写自己的密钥
FILM_AZURE_SPEECH_REGION=填写资源区域
```

优先级为进程环境变量 → 当前项目 `.env` → 仓库根 `.env`。只读取当前项目，不把值写回 `process.env`，因此多个项目可使用同名变量和不同账户。配置里只保存变量名，不接受明文 apiKey、Authorization、headers 或服务地址。服务端状态只返回变量名和是否已配置；`status` 不请求服务，不证明账户余额或在线可用性。

兼容 OpenAI `/audio/speech` 的服务使用同一个 `openai` 提供器，额外设置 `baseUrlEnv: "FILM_TTS_BASE_URL"`，在项目 `.env` 中设置实际地址，例如 `FILM_TTS_BASE_URL=http://127.0.0.1:8880/v1`。地址支持任意域名或 IP 的 HTTP(S)，不含 URL 用户名、密码或查询参数。旧 openai 配置保留原凭据规则；新的 `type: "compatible"` 无鉴权服务可以省略 apiKeyEnv。设置 baseUrlEnv 的旧 openai 配置按 compatible 能力执行，不推断服务支持 instructions。`model` 和 `voice` 必须使用该服务实际支持的标识。

`init --provider openai|compatible|minimax|doubao|elevenlabs|qwen3|azure|custom` 可以生成对应模板。填写云端凭据后，执行 `say` 才会提交文本并可能产生服务费用；配置检查、初始化与缓存命中不会调用合成服务。合成失败没有隐式重试，避免请求已计费但响应丢失时重复提交；人工重试前先检查服务情况。

## 台词、时序与缓存

实测时长自动排列对白：

```json
{
  "mode": "sequential",
  "start": 0,
  "gap": 0.25,
  "sentences": [
    { "id": "hello", "speaker": "narrator", "text": "欢迎来到我们的故事。" },
    {
      "id": "reply",
      "speaker": "robot",
      "text": "我已经准备好了。",
      "gapAfter": 0.5
    },
    { "id": "next", "speaker": "narrator", "text": "那就一起出发吧。" }
  ]
}
```

`sequential` 不接受句子的 `start`，根据实测长度加间隔计算下一句。`gapAfter` 只控制该句到下一句的停顿，片尾不追加间隔。

保持既定镜头时序时用默认的 `mode: "absolute"`，为每句填写 `start`，可加 `budget` 限制句长、顶层 `duration` 限制总长。超时不会静默截断或加速。默认拒绝重叠；确实需要两人同时说话时显式 `allowOverlap: true`，字幕与播放器呈现需要作者审看。

每句可指定已有项目音频 `audio: "production/intro.wav"`，无需调用合成器。所有音频统一转换成 48 kHz、双声道、16 位 PCM WAV。最多 200 句，每句文字最多 4096 字符（平台临时试听保留原 4000 字符限制），总时长最多一小时。合成原始结果上限 32 MiB，单句标准化结果上限 128 MiB。

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

## 迁移、扩展与可选 Qwen3 bridge

既有平台行没有 provider 的，保持 compatible；不根据 URL 猜测或自动迁移。选择专用适配器后才开启已核实能力。ElevenLabs 可暂不填写默认音色，先保存已有服务配置，再发现账号音色；选择音色前禁止合成。其他提供商仍要求默认音色。改名、改默认模型/音色且地址与 provider 不变时，省略 apiKey 保留原密钥；更换 provider 或地址时必须明确新 apiKey，或空字符串清除。UI 留空会在切换目标时清除；服务端拒绝省略值而转交旧密钥。密钥仍存原有加密字段，不返回给 UI/AI。

旧项目 openai + baseUrlEnv 保持 HTTP 基础兼容，新项目推荐使用 type: compatible。Edge、Azure 和 .mjs custom 接口不变；HTTP 默认端点配置与模型目录来自共享 catalog。新增提供商应先在 capability schema 声明核实能力，再添加请求/响应映射和协议测试；不要添加任意 headers/options 透传。TypeScript 消费方使用同名 .d.mts 契约，运行时仍由严格 zod schema 校验。

Qwen3-TTS 不是一个已核实的官方通用 HTTP API。本仓库提供可选 `speech/qwen3_bridge.py`，实现 Frame 自己的 /v1/voices 和 /v1/audio/speech。仅加载用户已安装的完整 CustomVoice 权重，调用官方 generate_custom_voice；不提供声音复刻/创建接口。由维护者在独立 Python 环境安装匹配的 torch、qwen-tts、fastapi、uvicorn、soundfile 与完整模型资产，再运行：

```sh
python speech/qwen3_bridge.py --weights /path/to/preinstalled/CustomVoice --model-id Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice --device cuda:0
```

默认只监听 127.0.0.1:8012。平台或 Docker 使用时必须让已配置服务可达并沿用现有网络访问控制；本 bridge 不自带鉴权，不应直接暴露公网。不要为本改动新增账号或授权。下载模型/依赖不由平台自动执行，推理过程中应确保所需资产完整；HTTP 取消不能中断已经运行的 GPU 内核。未装权重/GPU时不能把 mock 协议测试称为真实 Qwen 验证。

## 官方核实依据

核实日期：2026-09-30。实现范围以这些文档中明确的字段为准，账号权限、地区和可见音色仍需已配置服务实际验证。

- [MiniMax 同步合成](https://platform.minimax.cn/docs/api-reference/speech-t2a-http) 与 [系统音色目录](https://platform.minimax.cn/docs/api-reference/voice-management-get)。
- [豆包单向流式 HTTP](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh) 与 [ByteDance 官方 SSE 示例](https://github.com/bytedance/agentkit-samples/blob/main/skills/byted-text-to-speech/scripts/text_to_speech.py)。文档动态页面读取受限时，以官方索引片段及第一方示例交叉核实；不推断旧协议兼容。
- [OpenAI TTS](https://developers.openai.com/api/docs/guides/text-to-speech) 与 [模型快照](https://developers.openai.com/api/docs/models/gpt-4o-mini-tts)。
- [Eleven 合成](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)、[v2 分页音色](https://elevenlabs.io/docs/api-reference/voices/search)、[模型列表](https://elevenlabs.io/docs/api-reference/models/list)、[v4 能力变化](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4)。
- [Qwen3-TTS 官方模型与 Python 接口](https://github.com/QwenLM/Qwen3-TTS)。
