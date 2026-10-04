# Frame Studio 8.3.2 · AI 工作台与单一工作区

本次依据 `docs/AI-WORKBENCH.md` 完成平台维护，开发位于 main，目标为本机 `/opt/stacks/frame` Docker 生产栈。本文随实际验收和切换结果更新；尚未填写的结果不代表通过。

## 实现与需求核对

| 需求 | 实现和验证入口 |
| --- | --- |
| 最近作品、仓库与分页、新建空白作品、完整名称删除与恢复 | `library` / `work-library` / `workbench-browser`；卡片菜单仅重命名、删除，重命名保留并发版本检查 |
| 独立作品页、左右播放器/Paseo、窄屏侧层与键盘操作 | `workspace-review` / `review-layout` / `review-work-tools`；关闭面板保留已挂载官方会话 |
| 一个权威作品工作区、多个 Agent/标签共用一个运行环境 | `paseo-work` / `paseo-manager` / `paseo-workflow-browser`；canonical 目录及 Git common/index/HEAD 双路径挂载，历史草稿仅保留核对 |
| 编辑/AI/CLI/MCP/预览同一版本 | mode-aware 全作品 `sourceRevision` 与实际编译 `compiledRevision`；真实 Git linked-worktree Docker 验证 |
| 日常验证原位执行、报告过时和取消恢复 | `paseo-validation` / `paseo-workspace`；controller 在同一个作品环境执行范围、结构、测试、类型、真实画面和短音频检查，不复制候选、不应用覆盖源码 |
| 导出接受时冻结、排队/编码期间继续编辑 | `export-workspace`；准确源码、原始素材、执行位、参数、运行时及固定 image 在接受时记录；A→B 两种时机回归 |
| 导出任务完成及异常清理、仍能下载 | 终态精确容器身份检查、工作区清理标识/错误恢复、孤儿 admission journal；保留成片与诊断，清除源码、编码缓存和容器 |
| 公共引擎与依赖固定只读复用 | `shared-runtime-input` / `executor-shared-runtime` / `paseo-runtime-layout`；仅小 HTML 入口独立复制，无新 Git index；真实 new/frame/storyboard/build/render |
| 旧 FRAME AI 全部退役、旧聊天不保留 | 0010 迁移删除旧聊天、旧 AI 任务及专用问答/通知/令牌；按 migration journal 定向清理文件/已退出容器；官方 Paseo 会话、作品、素材、Git 保留 |
| 独立 Paseo 标签、原生消息与不伪造播放器引用 | `paseo-session-ui` / 完整 native workflow；同 daemon 和 Agent，实际发送/回执 UUID；独立页面没有时间/选段/素材上下文 |
| 已发送引用可点击定位，版本变化明确提示 | 官方 message pill 使用持久 externalResource URL；共享 `frameReviewUrl` 保留 time/range/source/compiled；同版定位，版本不同须用户选择当前版定位，不静默重解释 |
| 后台项目聚合并停止原生 AI/终端 | 原生状态徽标、停止条件、作品批量查询；LISTEN/NOTIFY 订阅 bindings，读取复用近期观察，写操作仍实时核对活动 |
| 提供商、模型、设置、密钥、并发保存与官方 profile | `provider-settings-browser` / `provider-lifecycle` / `codex-model-catalog` / `paseo-credentials`；旧单例凭据幂等迁移，旧 AI 专用设置入口移除 |
| 冻结素材引用保留原件 | `paseo_message_assets` 外键 pin 和资产索引；同事务锁定校验，永久删除明确拒绝，消息/作品删除释放 pin，不复制大型素材 |
| 引用/过时缓存清理与成片到期保护 | `live-review-snapshot` 统一新旧 key，compiled 精确保护；`retention` / `artifact-leases`，不扫描删除未知目录 |
| 作品独立分支、同步隔离、版本差异和只读历史预览 | `workbench` / `source-control` / `version-review` / `v5-work-undo`，保留现有业务能力 |
| 音画绝对时钟、媒体三模式、弱网/缓存/取消、MP4/WebM | 单元/MCP/播放器/browser-export/media/cache 回归；WebM 记录实际锁定的已显示来源 |
| 素材动作区分、试听原字节采用、弹窗与未保存输入 | `review-flows` / `speech` / `audio-editor-controls`；未应用 JSON 和未保存表单阻止误导出并保留输入 |
| 管理员密码、会话撤销、实时订阅恢复 | `api` / `realtime-oauth` / `v5-realtime`；沿用部署入口/TLS 策略，无新强制域名或 TLS 配置 |

## 验证

- 初轮完整 `verify:core` 在带 FFmpeg/Chromium 的一次性 Docker 工具环境中通过：179 单元测试；MCP 128 通过、1 项可选用户音色库跳过；播放器/工作台构建通过。本机直接运行曾因缺少 FFmpeg 失败，不能作为通过结果。
- 分项真实执行器测试 new/frame/storyboard/build/render 全通过；共享 build 约 2.9 秒、短 MP4 约 3.9 秒。canonical build 约 2.1 秒，原位验证五项实际通过。
- 旧候选迁移 guard 在 PostgreSQL 18 与 SQLite 验证：非空拒绝升级，run_id/revision/ledger 保留，空表才允许转换。
- 最终完整 `verify:core` 在音频缓存修复后重新通过：24 个单元测试文件、179 项测试；MCP 130 项通过、1 项可选用户音色库跳过；平台检查、两套类型检查、播放器及工作台构建通过。工程检查保留两个已有未注册目录警告，0 错误；本次没有修改视频项目目录。
- 工作区并发、启动与生命周期回归使用实际 PostgreSQL 准备锁、固定官方 daemon、实时预览和 iframe：35 项通过、0 跳过。三轮并发打开及控制器协调未新增 daemon、改变 Git index 或重写就绪工作区；布局准备先于服务代次登记，首个原生 RPC 成功后才发布就绪。
- 官方原生浏览器完整流程 1/1 通过、0 失败、0 跳过，约 42 秒：实际工具修改、Git、图片/短音频、原位五项检查、实时预览、消息引用点击、版本变化提示、第二 Agent 共用工作区、独立页再次发送、刷新无重放和精确 Git 恢复。使用官方 daemon/WebUI 和隔离模型协议服务；旧 worktree RPC 绕过已在共享服务端 workflow 修复，并真实验证拒绝。
- 六个真实 Docker 创作运行环境验收 1/1 通过、0 失败、0 跳过，约 51 秒：全部首次启动 generation=1，最多两个并发启动，无启动异常；双向共用 Git index、五项验证、预览源码/编译版本、原凭据、共享语音和其他作品隔离均通过。
- 真实导出组合验收 `export-workspace-docker` 1/1 通过、0 失败、0 跳过，约 26 秒；独立 PostgreSQL、HTTP CLI 和固定 Docker 执行器分别完成排队及实际 ffmpeg 编码时的 A→B 修改。下载 SHA 校验通过；30 帧及 360 帧 MP4 解码后，源码画面与原始 SVG 采样仍为红色 A，canonical 保持蓝色 B。任务仅保留 exports、源码/缓存/容器已清除，另一作品字节和 HEAD 不变；所有测试资源已回收。
- Remotion 音频缓存对公共输入的旧布局检查已重构为受控共享运行时标识，避免重复散列公共引擎；普通输入与项目媒体仍逐字节检查。新缓存回归通过，真实 Canvas/Remotion Docker build/frame/render、CLI 下载及视频/音频解码 2/2 通过。
- 服务端后半段 67 个文件完整重跑：238 项通过、0 失败、1 项可选用户音色库跳过，约 523 秒；真实 Canvas/Remotion 工具链、V8 实时/音频/弱网/缓存/取消、SQLite/PostgreSQL 永久删除和工作台浏览器均通过。
- 最终完整 `test:server:release` 通过：534 项、532 通过、0 失败、0 取消，约 926 秒。仅跳过 Linux 无法运行的 Windows 本机测试和明确可选的用户 GeneralUser 音色库；发布脚本确认没有其他跳过。实际固定候选镜像为 `sha256:d0cd225a3d5487b82777807c767c6558aa53d6bbfca402e1c73a9acccd66cf95`。

外部私人账号登录后的实际模型权限、多私人账号切换以及真实 GitHub push/pull/Releases 上传，不能由隔离模型服务/CLI fixture 证明。本次结果只记录确实执行的验收，不代替外部账户授权或业务成片审片。

## 生产迁移选择与切换

预检：25 个作品（8 个在用、17 个在回收站）、100 个素材，6 条旧 FRAME 聊天、12 个已结束旧 AI 任务；活动任务 0、旧 Paseo candidates 0、8 个原生工作绑定均停止、历史原生 worktrees 0。全部 canonical 项目及保留草稿均记录字节/执行位校验值；切换前再次核对活动状态。

7 个旧 Paseo 草稿与 canonical 项目字节/执行位一致。《折叠｜THE IMPOSSIBLE FOLD》的当前作品包含较新素材与交付记录，用户已选择采用当前作品、保留旧草稿待核对；不得覆盖当前作品。

8 个生产 native workspace 的 cwd / worktreeRoot / project.rootPath 都为 `/workspace`，没有原生 Agent 元数据；切换挂载可复用现存 workspace 身份。此结论来自实际持久元数据核对，不代表任意外部旧草稿/worktree Agent 已自动迁移。

不执行发布前备份，不重启 PostgreSQL、语音或代理等无关服务，不删除数据卷或已有备份/旧镜像。一次性迁移和验证容器在 Compose 栈外使用 `docker run --rm`。

首轮 8.3.0 已于本次任务上线，代码提交 `c56761229797ba517abb973089cc5fc284a3095d`；镜像 `sha256:e13d67b3e0e4706d9a0e3ea9fb4b0c051c635735fef3e22f8ed718df3e15e763`，运行时 `aec430ccdd5b93eca586add4055e79a950e4a0a5df263f9bb033497578d65dea` 与通过完整门禁的候选一致。公网健康正常，只有 studio/controller 切换，PostgreSQL 和语音未重启。

旧数据迁移在栈外一次性 `--rm --init` 容器完成：18 个精确清理身份出队、8 个旧会话目录移除；旧 FRAME 聊天、旧 AI 任务及附属表已清理，journal 为零。迁移后再次确认 25 个作品字节/执行位、8 份待核对草稿、Git HEAD 与 index entries、100 个素材元数据全部一致。旧 8.2.5 与退役后的 schema 不兼容，后续采用向前修复，不能直接启动旧程序。

8.3.0 生产验收时，官方 Paseo 独立页和原位五项验证通过，但普通 HTTP 播放器暴露既有 `crypto.randomUUID()` 安全上下文限制。HTTPS 正常不能代替用户允许的普通 HTTP 使用方式。因此继续修复到 8.3.1：共享安全 UUID v4 helper，以及复用既有增量 SHA-256 的音频/素材校验 helper；HTTPS 优先调用浏览器原生实现，HTTP 保持同样的完整校验，按 64 KiB 零复制视图计算并约每 8 ms 让出主线程、支持取消。没有增加强制 TLS 或域名配置。

8.3.1 的 FRAME 本轮 `verify:core` 已通过：179 项单元测试、MCP 130 通过 / 1 个可选用户音色库跳过、平台及两套类型检查、播放器与工作台构建。实际普通 HTTP UUID/播放器/表单/Paseo 引用回归和四组相关回归 12/12 通过；普通 HTTP SHA/音频与缓存边界 10/10 通过，32 MiB 校验保持 251 个心跳并可取消；原有音频/弱网/音色库/缓存回归 7/7 通过。普通 HTTP 自然缺少 `crypto.subtle` / 原生 `randomUUID`，测试没有模拟覆盖这些能力。

继续审查发现官方 Paseo 已为 HTTP 补齐 UUID，但 FRAME 消息指纹仍调用 `crypto.subtle`；生产只读探针确认发送前会失败，尚未发出付费消息。新增最小官方补丁 0009 将消息指纹改为原生优先，HTTP 复用 Paseo 锁文件中已有 `fast-sha256@1.3.0`；不复制算法或削弱冻结/投递去重校验。完整原生工作流改为真实普通 HTTP 主机名，最终结果以新官方 bundle 与完整服务端发布门禁为准。

新官方 bundle 的来源证明通过：Paseo 固定 commit 不变，包含 0001–0009；bundle fingerprint `396db87a49059d2f4e389bcef1d856753e7e8a6b00fd8765d853257900355589`，2019 个文件，73,407,847 字节。0009 官方指纹测试 6 项、app 类型检查及来源/构建验证 5 项通过。

完整真实 HTTP 原生工作流通过，40.7 秒、0 失败/跳过：官方 iframe 与独立标签页自然处于非安全上下文、`crypto.subtle` 不存在；真实图片上传/消息发送成功，观察到的原生图片 wire bytes 对应 Node SHA-256，冻结 intent_hash 精确一致。canonical 编辑、原位五项验证、消息引用定位、独立页继续/重载不重放、拒绝另建 worktree、共享 Git 恢复均通过。使用隔离 CLI 协议服务，未发送私人账户付费请求；临时 PG、浏览器、进程和独立测试 runtime 已回收，已有 runtime 保留。

8.3.1 代码提交 `249cd2f4358db854a5baec7ebda70b02c1cac944`；固定候选镜像 `sha256:9ad1afb1352c92a2abd8a99d0766644ae885307ccb5e6e6f364a05f91fea85b6`，运行时 fingerprint `ddbcc4d2714dd8e5a8d87bdc0c7ea6abaf77286cbc42bda19b05633b6c4f4b94`，Node 24.21.0。

首轮 8.3.1 服务端执行 542 项，539 通过、0 失败、3 跳过，910.7 秒；启动漏传 `FRAME_TEST_EXECUTOR_RUNTIME=1`，真实执行器复用检查没有执行，严格 release 脚本明确拒绝该跳过，退出 1，不能计为发布门禁通过。已补齐此独立开关并使用新空测试数据库重跑完整门禁；其余两项为 Linux 无法执行的 Windows 本机测试及明确可选的用户 GeneralUser 音色库。

8.3.1 最终严格服务端门禁通过：542 项、540 通过、0 失败、0 取消、2 个明确允许的跳过，884.6 秒。候选 9ad1afb 的相同字节镜像标记为正式 8.3.1，于 2026-10-04 UTC 替换 studio/controller；公开健康接口返回正确版本/提交，无关服务和卷保持原状。

8.3.1 生产实际普通 HTTP 验收通过：官方独立页冷启动与重复打开复用同一个 daemon/workspace；实时播放器、原位五项检查均成功；320×180、12 fps、3 帧 H.264 MP4 完成，下载 SHA 匹配，临时源、缓存与任务容器清理，成片删除由本次验收显式执行。实际公网 HTTPS 浏览器也验证播放器、官方 iframe 和自然原生 crypto 能力，0 页面异常。未发送私人账号付费消息；验收启动的 native daemon 已按精确代次、空闲条件停止。

发布后全量数据核对发现检查点范围缺陷：旧导入作品未提供 `.gitignore`，导出与原位验证并行时，自动检查点把本次验证的 55 个 `.cache/validation` JSON/Vite 依赖文件纳入提交，任务清理后变成 tracked deletions。所有作品源字节/执行位、保留草稿和素材均未变化。继续向前修复到 8.3.2，生成目录统一排除且提交限定作品源码范围，不依赖作品自己的忽略文件，也不吞并其他路径的暂存内容。

生产 sunny-rail 清理严格核对任务/native 空闲、作品锁、HEAD/parent、无已暂存内容及精确 55 个生成路径；只对这些缓存删除创建前向提交 `eff36d65cc125f62a9ae06c6e7577dbf2c1ed361`，没有 reset、重写历史或修改作品文件。其 tree 与原 HEAD `f54977d77cf89e5628434c3bc2cf3205ce915a61` 相同，stage hash 回到原值；25 个源码、8 份保留草稿、100 个素材元数据、全部 Git stages/status 再核对通过，另外 24 个作品 HEAD 不变。

8.3.2 将自动检查点和同步提交收敛到同一源码范围 helper，使用路径限定的 Git 提交保留外路径暂存项，拒绝当前源码存在不同 staged/working 版本。只排除源码库存已有的 `.git`、`node_modules`、`.cache`、`.history`、`exports`，没有扩大到 `records`、`build` 或制作源目录，也没有重写用户 `.gitignore`。源码管理与同步状态在 Git 列举阶段剪除未跟踪生成目录；已跟踪/暂存生成文件保持可见。

真实 Git 导出接受回归先在未修复的生产 8.3.1 镜像失败（缓存产生多余提交），再在新代码通过。独立审查实际验证无 ignore 的 2600 个缓存文件只显示 5 条真实变更、约 34 ms，不触发 2000 文件上限；有意跟踪但被 ignore 的普通源文件、制作源和外路径暂存项仍保留。

8.3.2 针对源码管理、source-index、素材引用缓存的生产同版本工具链回归 52/52 通过、0 跳过，6.05 秒；导出接受/取消/恢复全组 14/14 通过、0 跳过，1.1 秒。覆盖空检查点、首次提交、完整目录删除、同步范围与已暂存内容保护。

8.3.2 完整门禁、真实校验并行 Docker 导出、生产功能验收及本次临时资源清理：待记录。

## 后续优化候选

以下兼容项不为本次任务擅自删除，供用户决定：`tasks.execution` 当前没有新任务写入路径但历史诊断仍读取；历史 Paseo task 结果/逆向撤销链仍有兼容读取，日常创作已改用工作区和 Git 版本。可另立维护任务核对历史使用情况后简化。

旧聊天组件移除后，根包的 `react-markdown`、`rehype-highlight`、`remark-gfm` 已没有调用，可以独立清理包和锁文件；官方 Paseo 使用自己的 Markdown 依赖。本次未擅自进行这一依赖瘦身。`openai` 仍用于语音合成，不能按旧 AI 名称一并删除。

此外，旧 core 0001 迁移按 trigger 名称而非 schema/table 判断是否存在，在同一数据库第二个非 public schema 上可能漏建 trigger，导致后续迁移失败。当前生产使用 public schema，不受影响；本次新增 PostgreSQL 测试使用独立数据库或隔离的真实表结构，未擅自扩展生产迁移范围。

另有 `studio/paseo-chat.css` 中 `.paseo-history` 的窄屏规则已没有对应元素，可与后续样式瘦身一并处理；本次记录供用户决定。
