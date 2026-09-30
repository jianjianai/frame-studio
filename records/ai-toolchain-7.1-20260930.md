# AI 创作工具链 7.1.1 验收记录（2026-09-30）

## 范围与基线

用户授权维护 Frame 公共 AI 创作能力、提交推送 main，并发布生产。开发基线为 cbb0e315aa2ec7b170a0ca136ebd38a035b9c4b3；部署前生产为 8abdc083143ea8c80b1045e3ddf975bb1edb7e57。没有改动用户作品或账户凭据。

## 实现

- 本地 CLI、MCP、远程作品 API、Codex/Claude 任务共享创建契约：空白 composition、24 秒、30 fps、静音，成对尺寸与组合参数互斥。
- 共享源文件批量编辑/补丁及音视频文档编辑 schema；CLI describe 与逐命令 help、MCP tool_describe 返回实际输入定义；只读 MCP 不发布写工具。
- 固定参考文档目录覆盖 audio-v7、composition、creator-workflow、toolchain。上下文明确源文件、完整 SHA-256 与权威文档；默认精简，完整内容显式获取。
- CLI JSON 文件和流式 stdin 有 1 MiB 上限；错误不回显原始 JSON；数字范围与无关参数提前拒绝；dryRun 不再被缺省 CLI 参数覆盖。
- 后台任务支持有界等待、终态退出码与下一步提示；大报告保留完整磁盘证据，终端只返回摘要及路径。
- 远程合成编辑复用公共文档事务、版本检查与缓存失效；只读请求对短暂仓库占用有限等待，写请求不自动重放。
- 播放器等待同步生成与异步 ready，冻结自身 AudioContext 并使用统一声画启动锚点；暂停/跳转取消旧等待，有限音符按音频时间释放。
- pnpm 脚本不自动重装共享只读依赖。开发和镜像构建显式 install --frozen-lockfile，film doctor 检查实际依赖。设置依据：[pnpm Build Settings](https://pnpm.io/settings/build#verifydepsbeforerun)。

## 已完成的实测

- CLI/MCP/Agent 契约回归：默认创建、尺寸冲突、参考目录、精确 schema、只读边界、文档权威性、损坏文档修复入口、dryRun、异步 JSON stdin、完整报告、持久任务等待。
- 真实 Chromium 音频回归：同步生成器各耗时 180 ms 后仍共享启动锚点；等待 ready；900 ms 准备不提前清理短音符；暂停取消；0 秒/19 秒冷启动、倒退跳转及 2 倍速。
- Codex 0.158.0 与 Claude Code 2.1.283 原生进程协议测试：双向问题、人工回答、同轮后续命令与恢复会话。模型服务使用本地确定性夹具；这不代表线上订阅账户可用性。
- 定向合成 GUI、远程工具与音频 GUI：9/9 通过。
- 独立真实影片：24 秒、640×360、30 fps、720 帧 H.264 与 AAC 立体声 48 kHz；完整 FFmpeg 解码成功。先验收旧 PCM 双轨冷启动，再迁移至双轨/双片段 audio.json 与双片段 visual.json；渲染前后输入指纹一致。
- 已查看 0、5.5、11.5、17.5、23.967 秒组帧：画面与字幕可见，无空白/丢帧。未声称进行人工听音验收。
- 普通开发用户 UID 10001 执行 pnpm --silent film doctor --json 成功。
- 最终 pnpm verify 退出 0：Vitest 81/81，MCP 81 通过、1 项可选音色库测试跳过，服务端 184 通过、5 项需要 Docker socket 的用例跳过，失败 0。日志 .cache/ai-tooling-verify-release-ready.log。
- 推荐远程补丁入口调整为 works_patch_batch 后再次执行作者契约回归，3/3 通过；最终候选将验证冻结提交的全部代码。

完整影片证据位于开发工作区忽略缓存 .cache/ai-tooling-acceptance/2d122ae2-6b72-4885-8673-a45001192a57/（summary.json、storyboard.png、acceptance.mp4）。测试夹具不进入生产作品。

## 发现并修正的问题

最初全量检查暴露合成 GUI 在原子写入间读取产生 FILE_CHANGED；首次读锁修复因非阻塞数据库锁产生 Repository is busy。最终让读写使用相同源文件域，并仅对短暂读锁竞争有界等待，定向 9/9 通过。CLI stdin 用同步读取时出现 EAGAIN，已改成有界异步流式读取。以上失败没有被当作通过记录。

## 发布方式

冻结明确提交的源码，以提交 SHA 标记不可变镜像；隔离 PostgreSQL 与真实 Docker 执行器执行 verify:release 和 test:workspace。通过后推送镜像，检查活动任务，只切换 studio/controller。上线后检查健康、真实 HTTP MCP、原生 CLI、桌面/手机工作台、既有作品预览以及源码/素材未变。

遵守用户约定：不创建数据库或内容备份；保留原镜像用于回退。本次跨版本迁移为新增表/列/通知触发器，不删除业务数据。生产结果另行补充。

## 首次生产验收与 7.1.1 补充修复

7.1.0 提交 eb3d021df1bd56378fef301808e99815115daf08 已推送并通过不可变候选门禁：Vitest 81、MCP 81、服务端 188 项通过，2 项可选 GeneralUser 音色包测试跳过；真实 Docker Codex/Claude、真实 HTTP MCP → Docker 成片 → CLI 下载通过；工作台 27 项检查通过。镜像 digest 为 sha256:199cb80ff51f712fa21624aa3f05a928645c1b06ac3ea984f1a6e5960f5372e7。

第一次生产切换仅更新 Studio/Controller，健康与就绪通过，未登录 API 返回 401；线上 MCP 87 工具、文档、24 秒默认值及全部未删除作品上下文通过。桌面/手机工作台、播放、模型选择、素材面板、草稿保留、设置页均通过，pageerror 为 0。现有 Codex 官方账户 20x 仍为 expired/configured:false，需要本人重新登录；未修改凭据或声称其线上模型调用成功。

既有作品预览验收发现 the-learning-machine 的大文件音频触发有界缓存回读失败：buildPreviewAudio 的本地静态服务器始终返回 200，未实现 Range。已用 3.84 MB WAV 在真实 Chromium 中“37 秒 → 0 秒 → 20 秒 → 1 秒”重现同一错误。修复为真正的流式 206 范围响应，支持开放/后缀范围、HEAD、长度及 416；取消请求释放文件流，同时限制方法和实际文件路径。没有放宽音频内存预算或把整个素材常驻内存。

新增两个回归测试在修复前均失败，修复后连同音频 V7/压缩预览回归共 8/8 通过，0 跳过。日志为 .cache/toolchain-range-before.log 与 .cache/toolchain-range-after.log。版本升级至 7.1.1，最终冻结候选门禁和既有作品验收将继续完成。

### 回退兼容性纠正

等待 7.1.1 候选期间尝试回切原 8abdc08 镜像，以恢复旧作品预览；旧程序的迁移防护拒绝已有 0007-creation-workflow 等新迁移，造成短暂 HTTP 503。对“新增迁移即允许回退”的判断有误。随后终止本次回退进程并恢复 eb3d021（7.1.0），Studio/Controller 均重新健康，公开 healthz/readyz 恢复。数据库迁移记录、作品和凭据未作降级或删除。

7.1.1 与 7.1.0 使用同一迁移清单，因此最终发布以 eb3d021 为兼容回退基线，不能再将 8abdc08 作为当前数据库的可运行回退镜像。已在 OVH 开发/发布说明中补充迁移清单核对与全作品媒体验收要求。

## 最终交付：7.1.1

- 功能提交：bdb27f4c09371a22bb010b2eae22264ee488f020，已推送 main；此前主优化提交为 eb3d021df1bd56378fef301808e99815115daf08。
- 生产地址：https://frame.nerviloom.com 。运行版本 7.1.1，revision 与功能提交完全一致。
- 不可变镜像：ghcr.io/jianjianai/frame-studio:sha-bdb27f4c09371a22bb010b2eae22264ee488f020；发布 digest：sha256:270cb9b55032e4c8ce9d11a0c84b38c994ebf3873e41367386b7808962ae7622。
- 最终冻结源码候选执行 pnpm verify:release、pnpm test:workspace，均退出 0。Vitest 81 通过，MCP 83 通过，服务端 188 通过，合计 352 项通过、0 失败；另有 2 项依赖缺席可选 GeneralUser 音色包的测试跳过。工作台 27 项检查通过，errors 为 0；此套界面测试使用真实 UI/播放器/WebM 和模拟 API 状态。
- 真实 Docker 内 Codex/Claude 执行、双向问答、校验与发布，以及 HTTP MCP → 源码批量安装 → Docker 帧图/视频渲染 → CLI 等待/下载链路通过。正式候选中的输出为 640×360、24 fps、48 帧、2 秒、立体声；完整 24 秒影片证据见前文。
- 生产再次验证 87 个 MCP 工具、共享创建默认值、参考文档、当前全部作品上下文以及原生 Codex/Claude 版本；只读、无网络、UID 1000 镜像内 film doctor 通过。开发环境 UID 10001 的 doctor、help 与显式冻结依赖安装也通过。
- 最终生产 healthz=ok、readyz=ready，未登录 /api/me=401；Studio/Controller 均健康。只切换这两个服务，数据库、Speech 和开发容器未重启；Compose 与凭据配置保持原状。
- 当前 5 个活动作品（paper-wings、work-39d8b371、tiny-seed、the-learning-machine、sunny-rail）全部取得与当前源码/运行时匹配的预览，previewVersion=10，并在真实生产浏览器逐一通过就绪、跳转、播放/暂停检查。此前失败的 the-learning-machine 已通过重建与实际播放。
- 生产桌面/390px 手机界面、模型选择器、素材面板、草稿保留、设置页面通过，pageerror 为 0。已查看最终大文件作品桌面画面与手机对话截图；画面、字幕、时间线和输入控件可见。
- 最终部署前后 7 条作品记录及源码哈希、28 条素材记录完全一致，活动任务为 0。与最初基线相比，work-05636593 于验收期间被其他操作移入回收站；保留了该当前状态，其余 6 个作品源码与全部素材记录一致，没有擅自恢复被删除作品。
- 官方 Codex 账户 20x 当前 expired、configured:false、enabled:false。用户需要重新登录并启用该提供商；原生协议夹具测试不等同于此生产账户已能调用在线模型。
- 本次未创建生产数据库/内容备份，未降级数据库或删除迁移记录；保留现有镜像。两轮候选的专属容器、网络及测试口令文件已清理，验收证据保留。

最终候选日志与构建证据位于主机 /opt/frame-toolchain-bdb27f4-20260930/；工作区证据为 .cache/toolchain-7.1.1-*、.cache/toolchain-production-rebuild.json 与 .cache/toolchain-production-preservation.json。功能镜像固定于上述提交，后续验收说明提交仅更新文档。
