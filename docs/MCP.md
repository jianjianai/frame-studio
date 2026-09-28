# FRAME MCP：AI 动画编辑服务

本地 stdio 和远程 Streamable HTTP MCP 共用现有工程源码与 film 工具。场景、音轨、字幕和镜头标记仍是项目文件，播放器与导出继续使用同一绝对时间接口。MCP 提供可验证的编辑工作流，不另造一套时间轴或渲染引擎。外部 AI 的 OAuth、Bearer token 和 Cloudflare Tunnel 配置见 [远程接入](MCP-REMOTE.md)。

编辑、检查点、审片、交付验证、旁白与正式导出同时提供命令行入口，详见 [AI 制作工作流](AI-PRODUCTION.md)。MCP 和 CLI 共用项目服务与制作模块。

## 启动与接入

在这个 checkout 安装依赖：pnpm install --frozen-lockfile。客户端启动命令使用 node，参数使用 scripts/mcp.mjs 的绝对路径。根目录从脚本位置确定，不取客户端工作目录，不允许模型切换工作区。

通用 MCP 客户端配置（将路径替换为实际 checkout）：

    {
      "mcpServers": {
        "frame": {
          "command": "node",
          "args": ["C:/path/to/frame-studio/scripts/mcp.mjs", "--project", "my-film"]
        }
      }
    }

可重复指定 --project，将会话限制在这些项目（包含允许新建的 id）。不指定时允许访问这个 checkout 的全部项目。--read-only 只提供读取和结构检查；预览会执行项目代码并产生文件，因此不在只读工具集中。--job-timeout-seconds 默认 600，可设 1–3600。直接运行 pnpm --silent film mcp 同样可启动；协议 stdout 只输出 JSON-RPC，诊断走 stderr。

服务采用官方 @modelcontextprotocol/server 2.1.0，serveStdio 同时支持当前协议和旧客户端握手。依据：[官方 SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[stdio 服务说明](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server)。

## 建议的 AI 工作流

1. frame_list_projects，随后 frame_project_context，读取工程约定、README、静态元数据、音轨和 Git 基线。
2. frame_list_files / frame_read_file 定位源码；读取返回完整文件 SHA-256，即使只请求其中几行也一样。
3. frame_edit_files 一次提交关联文件的变更，旧文件必须提供刚读取的 expectedSha256；新文件使用 null。可以先 dryRun 查看变更摘要。
4. 实际编辑默认执行严格结构检查，失败恢复原内容；成功写入项目 records/mcp 的哈希审计记录。结构检查不等于类型、运行时或视觉验收。
5. frame_start_preview 生成关键帧或分镜，frame_job 查询状态，frame_read_artifact 将 PNG 直接返回给 AI。评估构图、遮挡、镜头衔接后继续迭代。
6. frame_check_project 返回结构检查及 Git 范围检查，两者单独报告。通过 CLI 运行项目相关单元/浏览器测试；不要把“检查通过”表述成“画面和音乐已验收”。
7. frame_start_render 导出短片段，核对后再请求全片。MP4 和 FFprobe 报告保存在项目 exports/mcp/<jobId>/。使用 frame_cancel_job 取消本会话的任务。

提供 frame_edit_animation 提示词和 frame://reference/* 只读资源，客户端支持 resources/prompts 时可直接发现。frame_read_reference 提供同样的固定文档读取能力，核心使用不依赖这些可选 UI 功能。

## 工具与边界

| 工具                               | 作用                                       |
| ---------------------------------- | ------------------------------------------ |
| frame_list_projects                | 静态发现项目；个别损坏项目单独报告         |
| frame_project_context              | 元数据、音轨、README、约定与 Git 基线      |
| frame_project_operation / frame_recover_operation | 查询占锁任务与恢复已确认退出的遗留锁 |
| frame_read_reference               | 读取固定的创作规范、接口与公共引擎类型     |
| frame_list_files / frame_read_file | 有界文件列表、UTF-8 分页读取及内容哈希     |
| frame_create_project               | 调用既有脚手架，拒绝覆盖                   |
| frame_edit_files                   | 批量新建、替换或删除文本；版本冲突拒绝写入 |
| frame_check_project                | 严格结构检查与独立 Git 范围结果            |
| frame_start_preview                | 单帧或最多 48 帧的分镜 PNG                 |
| frame_start_render                 | 复用现有逐帧 MP4 / 混音 / FFprobe 验证     |
| frame_job / frame_cancel_job       | 任务查询与取消                             |
| frame_read_artifact                | PNG 原生图像、JSON 报告或 MP4 文件链接     |
| frame_search / frame_patch_files | 字面搜索与带版本校验的局部替换 |
| frame_checkpoint / frame_history / frame_restore | 文本检查点、版本列表、预览/应用恢复 |
| frame_start_validation | 单项目类型、单元/浏览器测试、构建、工程验证任务 |
| frame_check_playback | 冷跳、指定片段播放、暂停、倍速的真实浏览器验证 |
| frame_start_review / frame_review_artifact | 冻结输入的片段审片包及图像/字幕/分轨回读 |
| frame_compare_reviews / frame_review_note | 同时间范围 A/B 页面与绑定时间、版本的审阅记录 |
| frame_start_export | 实际试编码、分段恢复、完整解码验收的正式导出 |
| frame_verify_delivery | 针对最终文件的计帧、解码、测量、抽帧与版本检查 |
| frame_import_asset | 导入已暂存在本项目内的二进制素材并记录许可 |
| frame_upload_asset / frame_asset_upload | 小文件原样上传、持久分块续传、校验登记与取消 |
| frame_fetch_asset / frame_read_asset | 后台公网 URL 拉取、已登记素材的元数据与字节读取 |
| frame_narrate | 根据项目显式配置逐句合成/复用音频、测时并生成字幕 |
| frame_speech_status / frame_init_speech | 项目独立语音配置、凭据存在性检查与不覆盖初始化 |
| frame_list_voices / frame_read_speech | 声线发现、语音/字幕回读与显式原生音频试听 |

MCP 文件读写只允许指定项目内部的普通文件，拒绝路径穿越、Windows 设备名/ADS、符号链接、junction、硬链接及隐藏目录。源码编辑仅接受文本格式；资产二进制使用现有 film import 命令导入，保留来源和许可。依赖、引擎和根配置由维护任务更改。

外部素材可通过新增上传、URL 拉取和原始 HTTP 分块入口传入工程；MCP、命令行共用同一实现，详见 [素材传输](ASSET-TRANSFER.md)。`frame_read_reference` 的 `assets` 返回该指南，项目上下文的 `assetTransfers` 返回当前格式和容量限制。

语音支持公共 Edge、OpenAI/兼容接口、Azure 和项目自己的合成器，详见 [语音合成](SPEECH.md)，也可用 `frame_read_reference(name="speech")` 读取。`frame_narrate` 可传台词文件 input，或单句 text；二者互斥。38 个工具共用 CLI 制作能力，生成结果经 `frame_read_speech(inlineAudio=true)` 可返回原生音频给支持听音的客户端。

每个文件最多 1 MiB，单次编辑最多 20 个文件、合计 2 MiB。dryRun 只验证路径、版本和变更摘要，不临时写文件，也不执行修改后检查。多文件提交不是跨进程文件系统事务；服务使用项目独占锁、逐文件原子替换、备份与失败回滚。崩溃遗留锁/事务会阻止后续写入，人工核对备份后恢复；不会自动删除未知锁或覆盖外部编辑。

预览、导出与源码编辑共用项目锁；每个服务最多同时运行两个渲染任务。任务立即返回 id，日志有长度上限，完成状态写入 job.json；服务重启后可查询已有结果，不属于当前会话的未完成任务报告 unobserved（原会话可能仍在运行），不按旧 PID 杀进程。取消、超时和正常断开只终止本服务创建的进程树；失败任务清理自身输出目录，保留状态及诊断。异常断电/SIGKILL 留下的现场需要人工核对。

产物记录保存完整输入指纹，覆盖项目源码、二进制素材、公共运行代码、制作脚本及依赖声明，查询时标明输入是否变化。正式场景页面基于冻结快照构建；依赖安装本身仍共享，任务期间不要更新 node_modules。PNG/JSON 回读有体积上限，MP4 返回本机文件信息及资源链接。WAV 默认返回路径，只有明确支持音频输入的客户端才请求 inlineAudio；返回文件不等于模型已经看过/听过。

frame_start_review、frame_start_export、frame_start_validation 等任务完成后，先读取任务 result.json，再按返回的目录/审片 id 访问产物。失败任务仍保留有界日志，不能将失败的工程检查当通过。检查点不覆盖二进制素材，恢复需要当前输入指纹且默认 dryRun；详情和容量限制见 AI-PRODUCTION。

## 工作区与执行边界

动画工程已经使用代码创作，文件级编辑可以同时处理 Canvas、Pixi、Three 和 Web Audio，保留 Git 审查。结构化元数据和预览工具降低模型理解成本，源码接口保留表现力。长任务采用显式 job 工具，使较旧 MCP 客户端也能查询和取消。

服务只应接入可信本地 checkout。项目渲染会运行浏览器代码，Vite、依赖和配置运行在本机权限下；路径检查和静态检查不构成操作系统沙箱。远程入口已提供单个工作区所有者的身份验证、授权和项目范围控制；多人不可信托管仍需额外的每任务容器/独立 checkout、配额、网络隔离和持久队列。

服务不接管模型 API、不自动提交/发布、不修改客户端的个人配置。远程认证配置保存在本机忽略的环境文件，OAuth 状态保存在私有目录；使用与验证记录见根 records。

## 连续工作、检查与图片兼容

`frame_check_project` 完成检查后返回普通结果：`status: completed`、综合 `passed`、`projectPassed`、`scopeVerified`，以及独立的 `structure` 和 `scope`。不合格报告不设置 `isError`；无法执行 Git 检查、参数错误等执行故障仍返回工具错误。结构通过时可以继续预览，不能把它说成范围检查或成片验收通过。

scope 保持严格判定，分类返回本项目变更、`externalWorkspaceChanges.projects` 和公共文件 `shared`，带总数、有限路径样本和截断标志。`attribution: unknown` 表示不能从共享 checkout 判断修改作者；不能忽略其他工程文件来伪造范围通过。CLI 使用 `pnpm film scope <id> --json` 获得同一报告，范围不通过仍退出 1，检查无法执行退出 2。

同项目的写入、验证、渲染串行执行。遇到 `PROJECT_BUSY`，读取 `error.details.activeOperation`，其中提供任务 ID、操作类型、开始时间、实例身份、存活判断、可取消状态和调用参数；也可调用只读的 `frame_project_operation`。`frame_job` 支持 `waitMs: 20000`，任务结束即返回，否则最多等待 20 秒，避免快速轮询。不能取消其他授权主体的任务。

`frame_recover_operation` 必须带查询返回的精确 `lockId`。仅恢复新格式、所有者和工作进程均已退出、没有未完成事务、关联任务已经结束（或没有关联任务）的锁。旧锁、PID 仍存活、状态未知、未完成崩溃任务均保留现场；不按锁龄自动删除。CLI 对应 `pnpm film operation <id> --json` 和 `pnpm film operation <id> --recover <lock-id> --json`。

PNG 回读与审片工具支持 `presentation`：

- `native`（默认）：先返回原生图片，再返回原图/显示图尺寸、SHA-256、体积与是否变换的元数据。
- `image-only`：仅返回原生图片，适用于混合内容被连接器遗漏的情况，不附加文本或下载链接。
- `metadata`：只返回源图信息，远程模式附加需要认证的下载入口。

`maxWidth` 默认 1600、可设 320～2048，同时约束显示图的最长边；内联 PNG 不超过 1 MiB，必要时进一步缩小。源图最多 32 MiB、4000 万像素，原文件不变。需要看细节时生成单帧或较少帧的分镜。报告中的 `visualInspection: not_confirmed` 不会因图片成功返回而自动改变，必须真实看图后记录审阅。
