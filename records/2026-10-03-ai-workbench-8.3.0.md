# Frame Studio 8.3.0 · AI 工作台与单一工作区

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

实际生产版本、镜像、旧数据清理、健康和功能验收：待记录。

## 后续优化候选

以下兼容项不为本次任务擅自删除，供用户决定：`tasks.execution` 当前没有新任务写入路径但历史诊断仍读取；历史 Paseo task 结果/逆向撤销链仍有兼容读取，日常创作已改用工作区和 Git 版本。可另立维护任务核对历史使用情况后简化。

旧聊天组件移除后，根包的 `react-markdown`、`rehype-highlight`、`remark-gfm` 已没有调用，可以独立清理包和锁文件；官方 Paseo 使用自己的 Markdown 依赖。本次未擅自进行这一依赖瘦身。`openai` 仍用于语音合成，不能按旧 AI 名称一并删除。

此外，旧 core 0001 迁移按 trigger 名称而非 schema/table 判断是否存在，在同一数据库第二个非 public schema 上可能漏建 trigger，导致后续迁移失败。当前生产使用 public schema，不受影响；本次新增 PostgreSQL 测试使用独立数据库或隔离的真实表结构，未擅自扩展生产迁移范围。
