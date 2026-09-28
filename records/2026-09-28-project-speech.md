# 项目独立语音合成与公共适配器

基线：`1433791`。本次为公共工作台维护，没有改写现有作品源码、音轨、配置或私有凭据。

## 实现

- pnpm 固定公共依赖 `msedge-tts@2.0.8`（MIT）、`openai@7.23.0`（Apache-2.0）和 `microsoft-cognitiveservices-speech-sdk@1.51.0`（MIT）。MsEdgeTTS 随包已有 dist，安装脚本仅调用 `npx only-allow pnpm`；在 pnpm allowBuilds 中显式禁用该安装脚本，冻结安装验证通过。
- 项目 `production/speech.json` 独立配置提供器、声线、角色与缓存修订；环境按进程、项目 .env、根 .env 优先级读取，不改进程全局环境。兼容项目自己的 .mjs 接口，不需要迁移旧作品。
- CLI speech init/status/voices/say 与既有 narrate 共用域实现；初始化拒绝覆盖，AI 上下文和新工程模板指向语音指南。
- MCP 新增 frame_speech_status、frame_init_speech、frame_list_voices、frame_read_speech；frame_narrate 可接完整清单或单句试听，现共 38 个工具。
- 逐句实测顺序对白、角色覆盖、绝对时序及显式重叠；标准化 48 kHz 双声道 WAV，缓存内容校验、有限大小、项目锁和原子发布。只返回工程接入信息，不自动重写 project.ts。
- 提供器运行在可终止的 Worker 内，限制结果大小和时长，取消/超时终止不响应 signal 的模块；无隐式重试或切换。内置 SDK 错误只返回分类/HTTP 状态，不返回上游响应、凭据或 URL。
- 原生 MCP 音频回读，远程认证 Range/HEAD 下载仅允许版本化语音包的三种已知文件，保持源码/私有配置边界。

## 实际验证

- `pnpm install --frozen-lockfile`：通过。
- 旧逐句旁白缓存/字幕测试：通过，兼容原项目 .mjs 提供器。
- 新增 10 项专项测试通过：项目配置和不覆盖、只读/allowlist、私有环境隔离、缓存声线/代码变化、标准化和字幕、多角色时序/预算、OpenAI SDK 真实本机 HTTP 请求/429 无重试/重定向拒绝/大小限制、Worker 取消/超时、真实 MCP job 与原生 WAV、CLI 合成、认证 HTTP Range/HEAD、MCP 取消释放项目锁。
- 实际在线 Edge 声线查询成功；zh-CN 前缀返回 8 个声线（含地区声线）。
- 实际 Edge 晓晓合成中文测试句成功：7.68 秒、48 kHz、双声道 WAV，SHA-256 `8cb97c1ff9c6c173c8d1293f2efbadeec98d0fd8346aaa32748ca961abbc9584`。测试作品为独立 UUID fixture，已清理；试听 WAV 与测量记录留在忽略的根 `.cache/speech-verification/`。
- OpenAI 使用官方 SDK 连接本机模拟 Speech 服务，验证真实请求格式、鉴权头和 WAV 处理；没有声称已调用付费云端。Azure 官方 SDK 已接入，实际账号/服务调用未验证。本次没有用户的这两类凭据，也没有代为设置。
- 完整 `pnpm verify` 退出码 0：5 个项目结构检查无错误/警告、类型检查、111 项单元测试、58 项 MCP 测试、生产构建及 22 项浏览器测试全部通过，共 191 项测试。浏览器使用独立端口 5197，用时 3.2 分钟。
- 最终工具发现返回 38 个工具，包含五个语音相关入口；`git diff --check` 通过。

## 公网服务状态

发现先前后台 MCP 实例 PID 19236 已退出，8787 没有监听，公网健康检查返回 530；保留的 server.lock 仍指向该旧实例。尝试执行“确认进程退出和端口空闲后清理失效锁，并隐藏启动 MCP”的操作，被自动审批拒绝，工具仅返回 blocked by policy，未提供更细原因。被拒绝的命令没有执行，未删除锁、未修改 OAuth 数据或凭据、未启动新服务。代码和本机/隔离 HTTP 验证已完成，公网激活尚未完成。

声线可用性、合成质量和服务授权由实际提供器决定；生成、解码与时间线通过不等同于艺术听感审查。外部客户端能否消费原生 MCP 音频取决于其音频输入支持。
