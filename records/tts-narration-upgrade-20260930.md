# TTS 旁白升级交接：项目主要审核并发布

本聊天完成开发和提交；是否合并、发布及云端付费验收由发起方交接到【项目主要审核并发布】后决定。本聊天没有合并 main、发布生产、删除分支/工作树、创建账号或新增外部凭据授权。

## 基线与隔离

- 仓库：jianjianai/frame-studio；原工作树 `/home/agentdock/AgentDock/frame-studio`。
- 实际基线：fetch 后 origin/main 的 `c115a225df9563d85dae5cd7e3d35fc744572e31`，Frame Studio 7.6.0。
- 分支：`feat/tts-narration-20260930`。
- 本次独立工作树：`/home/agentdock/AgentDock/frame-studio-tts-narration`。
- 提交 SHA：本说明与实现一起提交；审核前以 `git rev-parse HEAD` 核实完整 SHA，聊天最终交接也提供 SHA。
- 原工作树与 performance 工作树均未用于修改；共享依赖仅只读复用，测试数据库使用各自临时 SQLite，未使用其他聊天的共享测试 PostgreSQL。

## 实现与审查入口

1. `scripts/tts-capabilities.mjs`：浏览器/平台/项目 Worker 共用严格 schema、提供商预设和 model/voice 能力。默认 1×，未知扩展能力不猜测；无能力项请求前拒绝，平台显式 fallback=omit 才降级并返回 warnings/applied。同名 .d.mts 为 TypeScript 消费方提供契约。
2. `scripts/tts-adapters.mjs`：统一请求映射、音频响应/大小限制、MiniMax 服务级错误、豆包 fragmented SSE 与完成标记、取消/超时及错误脱敏。合成不自动重试、不跟随重定向、不自动切换提供商。目录仅明确 429/503 拒绝后重试一次。
3. `server/speech.mjs` / `server/work-operations.mjs`：保留 text/voice/speed，增加 options/fallback/requestId，提供目录/进度/取消操作，试听和正式合成应用相同参数；采用试听仍是原始音频复制，不重新合成。
4. `studio/speech.jsx` / `studio/voice.jsx`：提供商预设、音色发现与分页、模型目录、能力提示、自然中文/电影旁白指令、支持的情感/发音/停顿/前后文设置。无能力控制不显示；进度显示真实阶段和字节，支持取消，设置改变后旧试听不能直接采用。390px 布局测试通过。
5. MCP、平台 CLI、任务工具及项目 CLI：同一能力与请求映射；本地 frame_narrate 的 text 调用接受 speed/options，plan 仍使用扁平 settings；目录分页保留 cursor/search。任务 engine_test 和 speech 返回实际 applied/warnings/requestId。CLI 进度在 stderr，stdout 保持 JSON。
6. `scripts/mcp/workspace.mjs`：修复项目根私有 .env 导致本地 MCP 无法启动旁白的原有阻断，仅内部目录验证允许正规文件；文件读取/搜索工具仍拒绝 .env，软/硬链接仍拒绝，内容不进入 context/fingerprint。
7. `server/app.mjs` / `server/agent-tools.mjs`：本地模式采用/导入语音保留本地文件所有权，避免非特权进程执行 Docker 专用 chown；普通 Docker 模式原有所有权处理保持。
8. `speech/qwen3_bridge.py`：可选独立 FastAPI bridge，仅接用户预装 CustomVoice 权重和官方 Python API；无平台重量依赖，无声音克隆/创建接口。没有安装权重、GPU或模型依赖。

## 提供商范围与迁移

| 引擎                  | 本次实现与限制                                                                                   | 实际验证                                            |
| --------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Kokoro / Melo / Piper | 保留模型安装、音色和基础 Speech 协议                                                             | 当前已就绪本地服务短句实际通过                      |
| compatible            | 原 text/voice/speed 协议，扩展表达不推断                                                         | HTTP 测试服务 + 旧链路回归                          |
| MiniMax               | 文档列出 2.8/2.6/02/01 模型；情感、pitch、language_boost、带调拼音、显式停顿；目录仅查询系统音色 | 官方文档 + 本地 HTTP 协议测试；无云合成             |
| 豆包                  | 新 X-Api-Key + resource ID SSE 接口；语速、pitch；只对已核实默认 2.0 系统音色暴露 context_texts  | 官方索引/第一方示例 + fragmented SSE 测试；无云合成 |
| ElevenLabs            | 合成 v1、分页音色 v2、TTS 模型目录；v2 系列前后文/已有字典/停顿；v3/v4 正文标签提示              | 官方文档 + 协议测试；无云合成                       |
| OpenAI                | mini-tts 及核实快照指令/模型音色，tts-1/hd 不支持指令                                            | 官方文档 + HTTP 测试服务；无云合成                  |
| Qwen3                 | Frame 自有 HTTP bridge；1.7B CustomVoice 指令，0.6B 无指令，均无原生 speed                       | 协议映射与 Python 语法检查；无真实模型推理          |

Eleven v4/v4_turbo 已取消 speed/style，本次不发送；v3 stability 仅 0/0.5/1。豆包旧 appid/token 协议、复刻音色表达和未核实的其他 2.0 音色指令未实现，目录没有核实的公共协议时明确保留手动输入。

无 provider 的旧平台引擎保持 compatible，不按 URL 自动迁移。原 provider/原地址改名或改 model/voice，省略 apiKey 仍保留；换 provider 或地址必须明确新 apiKey 或空字符串清除，防止把旧凭据转交给新服务。UI 切换目标时留空会清除。ElevenLabs 可先保存没有默认音色的已有配置，再发现账号目录，选择音色前不能合成，避免要求用户先猜音色 ID。旧项目 openai + baseUrlEnv 保持基础 compatible 能力；新的无鉴权兼容服务可用 type=compatible，不强制占位密钥。Edge、Azure、可信 .mjs custom 接口继续兼容。

正式说明、官方链接、中文/电影旁白示例、API 与迁移细节见 `docs/SPEECH.md`；工具上下文另更新 `docs/MCP.md`、`docs/AI-PRODUCTION.md`、`docs/CREATOR-WORKFLOW.md`。官方协议核实日期为 2026-09-30。

## 验证证据

- 54 项核心聚焦测试全通过、0 skip：适配器单元、旧项目语音、平台真实 App/SQLite/HTTP/MCP、workspace 私有文件边界、已有试听采用、模型下载与任务工具单元。
- 2 项真实 Chromium 浏览器测试通过：原内置模型下载交互；新表达能力、指令实际映射、取消、v4 禁用控制、390px 布局。
- 最后扩展平台集成再次通过，真实调用任务 `/api/agent/action`，验证最终 speech 返回 applied/warnings/requestId。
- `pnpm typecheck`（含正/负 TTS 编译契约）、`pnpm typecheck:platform`、`pnpm check:platform`、Studio Vite 构建通过。
- `python3 -m py_compile speech/qwen3_bridge.py`、相关 Node syntax、`git diff --check` 通过。
- 未运行全库 verify/生产发布检查；本次验证聚焦 TTS 及所改边界，不将其视为整个平台发布验收。

测试在现有工具镜像 `sha256:43b5807e9a4db3f1265512f3f95df171091b774641acc1df495dc4cd42148470` 中运行。普通测试 --network none，依赖只读挂载，独立端口/临时数据库；FFmpeg 与 Chromium 使用镜像中已有工具。AgentDock 原生缺 FFmpeg，初轮旧旁白失败已在正确镜像重跑通过；只读 node_modules 导致 Vite 默认 config loader 缓存写入失败，改用 --configLoader runner 构建通过。类型负例在 Prettier 换行后调整了 @ts-expect-error 行定位并重新通过。

主要命令（在本工作树、上述隔离工具镜像内）：

```sh
pnpm typecheck
pnpm typecheck:platform
pnpm check:platform
pnpm exec vite build --config studio/vite.config.mjs --configLoader runner
node --test tests/desktop/tts-adapters.test.mjs tests/mcp/tts-adapters.test.mjs tests/mcp/speech.test.mjs tests/mcp/workspace.test.mjs tests/server/frontend-review.test.mjs tests/server/model-downloads.test.mjs tests/server/agent-toolkit.test.mjs
node --test tests/desktop/tts-expression-ui.test.mjs tests/desktop/speech-ui.test.mjs
python3 -m py_compile speech/qwen3_bridge.py
```

镜像中浏览器使用自己可写的 XDG_CONFIG_HOME/XDG_CACHE_HOME（/tmp），没有改共享浏览器配置。日志在本工作树 `.cache/tts-upgrade/`：`focused-final.log`（54）、`build-ui-final.log`（类型/构建/13 项含重跑旧旁白与 2 浏览器）、`agent-bridge.log`（最后扩展集成）、`discovery-final.log`（最后默认音色发现流程、构建/类型与 3 项集成/浏览器重验）。重复运行不重复累计测试数量；唯一案例共 56 项。

### 真正的本地服务验证

只读检查当前生产配置，仅 3 个内置引擎且无外部密钥；检查没有输出或复制凭据。通过本次 adapter 连接既有 speech 服务，仅合成短句，不创建平台资产或写生产数据库。FFprobe 全部成功：

| 模型 / voice              | 实际输出                                 | 时长     |
| ------------------------- | ---------------------------------------- | -------- |
| Kokoro builtin / zm_yunxi | 24 kHz、mono、PCM16 WAV，201644 bytes    | 4.200 秒 |
| Melo melo / 0             | 44.1 kHz、mono、PCM16 WAV，298028 bytes  | 3.379 秒 |
| Piper piper / 0           | 22.05 kHz、mono、PCM16 WAV，122924 bytes | 2.786 秒 |

Melo 首次探测误用 ZH 声线得到 HTTP400，按实际目录改为 0 后成功。音频仅证明真实合成与可解码性；未开展主观听音评审，不能据此宣称电影旁白品质已验收。云适配器所有测试均为 mock fetch 或本地 HTTP 服务，不能算真实云提供商验证。

## 待验项、风险与审核建议

- MiniMax、豆包、ElevenLabs、OpenAI 未配置，因此未验证账号地区/资源权限、余额、具体音色可用性、云音频/配额行为及中文听感。不新增账号、授权或付费交易来补验。后续仅在已有且获授权账号上按短句逐家验收。
- 豆包动态官方页面读取受限，按官方检索片段和 ByteDance 示例交叉核实；上线前重点实测 SSE 完成码、context_texts、pitch 和资源权限。其未知音色指令保守关闭。
- Qwen 未实测 GPU/权重/依赖组合；bridge 默认 loopback、无自带鉴权，仅适合现有受控网络。HTTP 取消不保证终止 GPU 推理。
- requestId 状态为本进程内存、10 分钟、最多 8 个活跃任务；非持久幂等与跨实例队列。超时/断线结果未知、已接受请求仍可能收费。多副本使用前需要粘性路由或另做持久请求管理。
- speech_status succeeded 是合成完成；采用/素材保存成功以原操作最终返回为准。不要因连接断开立刻重复合成。
- 自由表达指令、音频标签、情感、发音/停顿效果最终取决于模型/音色和正文，需要代表性中文样稿审听；本次没有宣称听感评分提升。
- 合并前检查远端 main 变化以及可能与其他聊天在 speech/UI/工具 schema 的冲突，按仓库发布流程复核。此交接仅提供可审核分支，不自行合并或发布。
