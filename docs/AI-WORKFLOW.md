# AI 视频制作：工具与上下文

统一参数、权威文档、能力发现、错误恢复和任务等待见 [AI 制作工具链](AI-TOOLCHAIN.md)。

本文说明工具用途和检查方式，不规定影片内容、风格或音乐标准。每次任务的要求记录在目标项目内，不追加为全仓规范。

完整的命令行制作流程、局部编辑与版本恢复、单项目执行、声画审片、后台任务、分段导出及旁白入口见 [AI-PRODUCTION.md](AI-PRODUCTION.md)。新接手任务优先使用那里的命令配方，以下基础入口继续兼容。

支持 MCP 的客户端可使用 [FRAME MCP](MCP.md) 完成项目上下文、带哈希校验的批量编辑、检查、PNG 回读与异步导出。统一启动入口是 pnpm --silent film mcp，直接客户端配置建议使用 node 与脚本绝对路径。

外部客户端使用 [远程 MCP 接入](MCP-REMOTE.md)：`pnpm film mcp-remote init|check|serve`，支持内置 OAuth、Bearer token 和环境文件中的 Cloudflare Tunnel 配置。命令行制作功能独立可用。

外部素材使用 [素材传输](ASSET-TRANSFER.md)：`pnpm film asset <id> upload <file> --license "来源许可"` 原样导入，添加 `--remote` 可上传到 `.env` 中配置的服务器；支持断点续传、URL 拉取、完整性校验和自动登记，不需要 MCP 客户端。

## 接手项目

语音合成与人物对白见 [SPEECH.md](SPEECH.md)：`film speech <id> init|status|voices|say`，以及 `film narrate <id> --input production/narration.json`。每个项目可选择公共合成器或自己的适配器；MCP 对应 frame_speech_status、frame_init_speech、frame_list_voices、frame_narrate、frame_read_speech。

在仓库根目录运行：

```powershell
pnpm film help
pnpm --silent film capabilities --json
pnpm --silent film list --json
pnpm --silent film context tiny-seed --json
pnpm --silent film inspect tiny-seed --json
```

`list` 给出实际注册项目；`inspect` 给出静态元数据、场景/声音入口、素材清单、音轨、说明、输出目录与独立记录目录；`context` 再附上接口和工具使用提示。它们只读，不导入或执行项目代码。JSON 包含 `schemaVersion`；使用 `pnpm --silent` 保持标准输出可被机器直接解析。未知项目或命令退出非零，JSON 模式返回 error。

能力发现无需已有项目。先按内容查询 `film capabilities --category visual --json`、`--category media`、`--category animation` 或 `--category audio`，再用 `--query <关键词>` 缩小范围、`--id remotion` 等读取精确接入信息。本地及平台 MCP 使用 `frame_capabilities`；平台内 Agent 使用 `node scripts/work-tool.mjs capabilities '{"category":"visual"}'`。它们共享能力目录，参考指南为 [CAPABILITIES.md](CAPABILITIES.md)，不因目录顺序、示例框架或默认容器而预选技术。

读根 AGENTS.md、NEW-PROJECT-STANDARD.md、AUTHORING.md 和项目 README，记录开始时的 HEAD 与 Git 状态。只修改 `projects/<id>/`，公共代码可只读使用。公共引擎、依赖和其他工程的修改属于单独授权的工作台维护。

## 创建完整工程

```powershell
pnpm film new my-film "我的动画" --duration 12 --fps 24
pnpm film check my-film --strict --json
```

默认创建不预选引擎的空白合成（composition），只是基础容器。显式模板可选 canvas、pixi、three、babylon、remotion；视频、图片、图像序列和 Lottie 可作为合成素材，GSAP/Flubber 等动画库和各类音频能力通过完整目录发现。通过 `pnpm --silent film capabilities --json` 查询能力，通过 `pnpm film composition <id> --json` 读取可编辑片段，接口见 [COMPOSITION.md](COMPOSITION.md)。Remotion 以 React/DOM 为根，`FrameScene` 可嵌入其他兼容场景；不能把 DOM 当作 Canvas 合成图层，见 [REMOTION.md](REMOTION.md)。默认 24 秒、30 fps、静音。`--audio generated` 自动连接模板生成器，也可保留默认 silent 后自行添加多音轨。创建会同时准备代码、封面、说明、私有测试和独立记录目录，再一次性注册；不会覆盖已有项目。原 `pnpm animation:new` 保持兼容。

`project.ts` 保存可静态读取的元数据和时间标记；`scene.ts` 是绘制入口。复杂项目可在本目录拆分 shots、characters、motion 等模块，无需修改公共注册表。素材在 public，原始材料与许可在 production，项目脚本与测试在 scripts、tests。新增脚本在 README 声明输入、输出和覆盖行为。

## 预览、定位与导出

```powershell
pnpm film storyboard my-film
pnpm film storyboard my-film --times "0,2,5" --width 480 --force
pnpm film frame my-film --frame 48 --width 1280
pnpm film frame my-film --time 2.5 --width 1280
pnpm film render my-film --start 0 --end 3 --width 1280
pnpm film render my-film --width 1920
pnpm film poster my-film
```

- storyboard 一次启动场景，按指定时间生成带秒数/帧号的 PNG 拼图和 `.png.json` 清单。默认取开头、各 beats 标记和最后一帧；最多 48 个时间点，较长项目用 `--times` 选子集。PowerShell 的逗号列表必须加引号。
- frame 的帧号从 0 开始，默认项目 fps；`--fps` 可覆盖，`--time` 直接指定秒数。不会播放整个片段后截图。
- render 是逐帧 MP4，默认项目 fps，可显式覆盖。默认 CRF 18、H.264 + AAC，保存 `.render.json` 并核对视频尺寸、帧数和音频流。
- poster 明确更新本工程封面。封面时刻由项目可选 `posterTime` 控制，默认片长中点，公共脚本没有作品专属时刻表。
- 浏览器“逐帧导出 · WebM”可选择分辨率、帧率；独立场景使用 high 细节，逐帧编码，OfflineAudioContext 离线混音，最后封装。编码速度和预览 FPS 不改变帧序。当前混音设置作用于浏览器导出；命令使用元数据音量。

输出默认在本项目 exports；`--out` 必须位于本项目。普通输出不覆盖，明确 `--force` 才替换。storyboard / frame 不需要 FFmpeg；命令视频需要 FFmpeg 与 FFprobe。浏览器先真实试编码，缺少可用编码器会明确失败，不退回实时录屏；后台可能变慢，关闭或离开项目会取消。浏览器内存模式上限 256 MiB，支持文件选择 API 时可勾选直接落盘；正式长片优先使用 `film export` 的分段恢复与完整媒体验证。

## 素材、检查和记录

```powershell
pnpm film import my-film "D:/assets/voice.wav" --license "作者、来源和授权"
pnpm film doctor
pnpm film check my-film --strict --json
pnpm film scope my-film --base <开始任务时的提交> --json
pnpm film operation my-film --json
```

import 只写本项目素材和索引；名称冲突时生成新文件。check 只检查文件、静态接口和时间范围，不代表画面或声音符合本次任务。单项目 context/check 不依赖其他项目元数据正常。scope 检查 Git 中提交以来及暂存、未暂存、未跟踪文件，发现越界即失败，不撤销修改；共享 checkout 无法识别作者，并行任务应使用独立 checkout。

scope 的 JSON 报告分别列出本工程、其他工程和公共文件的变更数量与有限路径样本，使用 `--limit 5` 可进一步缩短输出。范围不通过退出 1，检查无法执行退出 2；其他项目的现有变更不等于当前项目结构错误，结构检查与预览仍可独立运行。

项目被占用时，`operation` 返回关联任务、开始时间、进程存活状态和恢复条件。先查询或等待正在执行的任务；只有报告 `recoverable: true` 时才用 `pnpm film operation my-film --recover <返回的 lockId> --json` 恢复精确匹配的遗留锁。命令不会终止其他进程，也不会清除未完成的编辑事务或状态未知的崩溃任务。完整条件见 [MCP 操作与恢复说明](MCP.md#连续工作检查与图片兼容)。

核对画面优先使用分镜拼图和关键帧；验证声音/同步时渲染所需短片段。只有本次任务需要时才全片导出或重复测试。项目测试只放本项目 tests；公共功能修改运行 `pnpm verify`。在项目 records/ 内单独保存修改记录、实际检查报告和审查结论，区分代码完成、导出完成和视觉/声音已核对。README 只保留使用说明与记录入口，production/brief.md 只保留需求和设计。仓库公共维护记录统一归档到根 records/，不与 docs/ 使用文档混放。

旧的 animation:new、project:check、project:scope、posters、frame、render、assets:import 等命令保留；`film` 是统一入口，不维护另一套实现。共享渲染会话位于 scripts/render-session.mjs；浏览器与命令视频共用 src/engine/export-plan.mjs 的帧数计算。

## 浏览器导出实现依据

编码与容器封装采用固定版本 Mediabunny，按其 [媒体写入接口](https://mediabunny.dev/guide/writing-media-files) 与 [Canvas / AudioBuffer 数据源接口](https://mediabunny.dev/guide/media-sources)等待编码器接收每一帧。输出按整数帧序给时间戳，音频以小片段交错编码，取消或错误时释放场景、音频和编码器。
