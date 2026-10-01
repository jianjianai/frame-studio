# AI 制作工具链

V8 创作页默认使用增量实时预览，保存源码后更新；音频不再先整片生成并切块。弱网播放、不可变版本与正式导出规则见 [V8 实时预览](V8-LIVE-PREVIEW.md)。

本地 CLI、MCP、远程作品工具与 Codex／Claude 任务使用同一套创建及编辑契约和能力目录。默认创建空白 composition、24 秒、30 fps、静音；composition 只是基础容器，框架、素材和动画/音频能力由 AI 按任务自主选择，模板和目录顺序不表示推荐。画幅可用 width／height 成对传入，或通过 MCP 的 composition 对象传入。不能同时传两种画幅形式，脚手架拒绝覆盖已有项目。

## 接手与发现

| 入口               | 身份               | 先读上下文                                            | 能力发现                 | 参数发现                                |
| ------------------ | ------------------ | ----------------------------------------------------- | ------------------------ | --------------------------------------- |
| 本地 CLI           | 工程 slug          | film context <project> --json                         | film capabilities --json | film describe <command> [action] --json |
| 本地 MCP           | 工程 slug          | frame_workspace_context → frame_project_context       | frame_capabilities       | frame_help → frame_tool_describe        |
| 平台 CLI           | 作品 UUID id       | platform workspace_context → platform works_context - | platform capabilities -  | platform describe <operation>           |
| 平台 MCP           | 作品 UUID id       | frame_workspace_context → frame_works_context         | frame_capabilities       | frame_tool_describe                     |
| Codex／Claude 任务 | 当前任务绑定的工程 | node scripts/work-tool.mjs context                    | work-tool capabilities   | work-tool help --json 与 film describe  |

能力查询只读，无需先创建工程。本地与平台 MCP 的 `frame_capabilities`、CLI 的 `film capabilities` 和 Agent 的 `work-tool capabilities` 共用目录，包含 visual、media、animation、audio 四类；可以用 category/query/id 筛选并直接取得接入与限制信息，完整指南见 [CAPABILITIES.md](CAPABILITIES.md)。

```sh
pnpm --silent film capabilities --json
pnpm --silent film capabilities --category visual --json
pnpm --silent film capabilities --category audio --json
pnpm --silent film capabilities --query "morph" --json
pnpm --silent film capabilities --id remotion --json
node scripts/work-tool.mjs capabilities '{"category":"animation","query":"morph"}'
```

MCP 同样传入 `{"category":"animation","query":"morph"}` 或 `{"id":"remotion"}`。category 每次传一个分类；query 不区分大小写；id 读取精确能力详情。平台 CLI 的 `-` 从 stdin 读取 JSON；作品请求包含 id，能力请求可传上述筛选或 `{}`。按候选能力的参考入口读取指南，无需每次加载全部文档。旧 `film composition engines` / `frame_renderers` 只覆盖原有视觉适配器目录，不含动画辅助库与音频；Agent `work-tool engines` 发现已配置的语音服务与声线，不能用它推断视觉框架是否可用。

CLI 命令前加 pnpm --silent，避免 pnpm 日志混入 JSON。film help --json 返回命令目录；film composition <project> edit --help --json 等逐命令帮助会返回对应选项和请求 schema，无需已有工程。远程 platform describe 查询正在运行的服务器，应同时核对 workspace_context 的 platformVersion 和健康接口的 revision。

film reference --json、work-tool reference、frame_read_reference 和远程 frame_authoring_reference 使用同一文档目录，包含 capabilities、composition、remotion、audio-v7 和 creator-workflow。省略远程参考名称返回目录；本地 MCP 可通过 workspace_context 的 references 查看名称。

film context 与 frame_project_context 默认返回精简接手信息，完整可编辑文档用 audio／composition get 读取；context --detail 或 MCP detail:true 可显式包含整份文档，film inspect 保留完整静态数据。

上下文的 entrypoints 和 authority 指明权威文件及完整 SHA-256。声明 loadAudioDocument 的工程以 audio.json 为准，audioTracks 返回当前文档的通道摘要；project.ts 中遗留的音轨配置不能作为编辑依据。visual.json 拥有可编辑 Canvas 合成片段；Remotion 的 authority.visual 指向 React 根，canvasComposition 是可选子文档，只有被 FrameScene 实际连接才会显示。beats 只是审片标记。损坏的任务元数据或文档会给出 needs_repair 及诊断，保留修复入口。

## 修改与恢复

整批文件修改采用 changes: [{path, expectedSha256, content}]，局部补丁采用 changes: [{path, expectedSha256, replacements: [{find, replace, count}]}]。本地 CLI 的 edit／patch 和 MCP 的 frame_edit_files／frame_patch_files、远程 frame_works_edit／frame_works_patch_batch 共用 schema。content:null 删除，expectedSha256:null 新建；find 必须匹配 count 次，默认一次。旧远程单文件 works_patch 的 edits／oldText 形式继续兼容，通过 describe 获取其实际输入。

audio／composition edit 的 schema 通过 film describe audio edit --json 等查询；对应 MCP 通过 tool_describe 查询。音频迁移时 expectedSha256:null，还需本次读取的 projectSha256。已声明文档的修改使用文档哈希。JSON 中的 dryRun:true 与 --dry-run 都会保留；错误类型、数字范围或与动作无关的选项在写入前拒绝。--input 文件及 stdin 限制为 1 MiB，解析错误不回显请求内容。

VERSION_CONFLICT 要重新读取哈希并合并当前修改；PROJECT_BUSY 要查询活动操作，再等待或仅取消自己的任务。失败的受控批次会回滚，遗留事务有独立恢复入口。工具不会自动重放写入、素材生成或语音请求。

## 任务、审片与交付

本地 job start 创建持久后台任务，status 支持 --wait-ms 0..20000；job wait --deadline-seconds 20 给出终态或 timedOut:true。等待超时不取消任务；退出码 2 表示仍在运行，退出码 1 表示失败、取消或状态不可确认。远程 works_task 与 task_status 的任务同样在断开后持续运行；终态仍需读完剩余事件。requestKey 只复用于相同请求。

validate、playback、build 等含输入清单的 CLI 输出默认保留 fingerprint、fileCount 和完整 report 路径，逐文件哈希保存在项目 exports/reports 或原始报告中。--detail 返回完整清单。审片图像和视频属于工程 exports，过程记录属于 records。

先做结构／类型／工程测试，再检查真实播放、冷跳转、倒退与变速，查看带时间标记的 frame／storyboard。声音修改需审查有关片段；用户要求成片时再 export／verify。技术检查、浏览器构建和文件路径不代表画面已查看或音乐已试听；分别记录视觉、听音和编码验收。

实时播放等待生成器准备及 createAudio 返回的 ready 完成；构建音轨期间冻结所拥有的 AudioContext，所有音轨和画面共用未来启动锚点。暂停和新跳转取消旧等待，离线渲染仍使用同一音轨调度接口。生成器不应创建自己的时钟，应支持绝对时间、任意片段、变速与资源释放。
