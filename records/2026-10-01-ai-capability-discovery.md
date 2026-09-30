# AI 能力发现与中立新工程模板

日期：2026-10-01（UTC+08）。基线：`76e689c4c12f12cd040758f11d31664931955ed7`。工作树：`/home/agentdock/AgentDock/frame-studio-ai-capabilities`，分支：`feat/ai-capability-discovery-20261001`。按本次明确要求创建隔离工作树；未混入 main 或其他聊天工作树的改动。

## 行为

- 默认仍为透明、无片段的空白 composition。明确传 renderer 才创建该框架示例；当前工程 renderer 以 context 为准。文档、模板和任务提示不规定艺术内容，也不将目录顺序当作选型优先级。
- `src/contracts/capabilities.mjs` 提供单一结构化目录：visual 7、media 4、animation 2、audio 16，共 29 项。视觉与音频适配数据取自运行注册表；辅助库、纯色源及实际加载入口单独描述。音频处理器目录与实际 schema 的集合和顺序在启动时校验。
- CLI `film capabilities`、本地/平台 MCP `frame_capabilities`、无凭据 Agent `work-tool capabilities` 共用严格 category/query/id schema。可在创建前查询；精确 ID 返回接入路径、签名、要求和 reference。英文 morph 与中文路径形变均能命中 Flubber。help 能搜索真实 `frame_` 工具名。
- 工程/工作区 context 仅带完整分类摘要（2,797 字节），按需查询详情（完整目录 25,106 字节）。损坏的工程元数据仍保留目录和修复入口。新建 README 的全目录由同一源生成；前 4,000 字节保留快速接手、权威文件和关键混用边界。
- Remotion 是 React/DOM 根。保留 loadVisual 不证明子文档已连到根；authority.visual 始终指向 React 入口，canvasComposition 单独说明可选 Canvas 子文档及 FrameScene 连接要求。迁移、素材接入和任务提示保持一致。
- 音频素材先读取权威 audio.json 与版本；旧工程迁移使用 expectedSha256:null 和 projectSha256。模型走真实加载器，SoundFont/MIDI 走真实生成模块，字体等待加载，JSON 需验证为自包含 Lottie，未知格式先确认适配接口。导入不自动改变播放内容，不添加额外服务器扫描。
- Three 的 GLB/glTF、Draco/Meshopt/KTX2、骨骼时间和 bloom 帮助入口可查询；后处理必须项目自己接入渲染，不声称 build 中创建 composer 会自动生效。本地/平台 MCP 的正文工具名与 name 要求分别写清。

## 验证

测试在独立容器与临时 PostgreSQL `frame_test_capabilities` 中进行，候选源代码来自本工作树，依赖只读共享且 Vite 缓存独立。未使用生产数据库。

- `pnpm verify` 的 verify:core 阶段通过：工程/平台检查、两类类型检查、单元、全量 MCP、播放器和工作台构建。该轮 MCP 119 通过、1 个可选采样库用例跳过。
- 最终修订后再次运行 typecheck、typecheck:platform、全量单元 111/111 和相关 CLI/MCP 接手与 Remotion 测试 8/8，均通过。
- 新能力目录回归 28/28、素材权威及格式接入回归 17/17、真实工程与跨端目录/迁移回归 5/5，均通过。
- 第一轮服务端执行期间，SoundFont 提示改为准确的“loadAudio 加载模块导出 generators”，旧精确措辞断言已进入运行，导致该断言失败。已改为真实注册语义断言并通过专项复测。定稿后完整重跑 `pnpm test:server`，退出码 0：294 项，288 通过，0 失败，6 跳过；跳过项为 4 个真实 Docker/CLI 执行器用例、Windows 本地模式和用户未提供的 GeneralUser 采样库。两类维护子门禁均已通过，未将首轮失败描述为一次全绿验收。
- `git diff --check` 通过。文档相对引用和公开入口经独立只读审查。

## 边界

本次为独立分支代码优化，不代表生产服务已升级。客户端缓存的旧 connector schema 不能靠服务器文档强制刷新；context 提供当前能力和 live describe 入口。标准维护校验不是带 Docker executor 与 Windows 平台的 release gate，也不声称全部用户素材、第三方插件或任意 GPU/编解码环境自动可用。
