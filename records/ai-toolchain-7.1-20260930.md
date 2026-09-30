# AI 创作工具链 7.1 验收记录（2026-09-30）

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
