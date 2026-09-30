# FRAME Studio v7.6.2 Windows 控制中心发布

## 修改

延续 [Windows 控制中心返工](windows-control-center-20260930.md) 与 [v7.6.1 候选验收](windows-control-center-v7.6.1-20261001.md) 的完整范围：浏览器工作台，独立 Windows 控制中心，真实 Setup，SQLite、pnpm 依赖缓存、本机 Codex/Claude CLI 和自动更新。

v7.6.1 的英文 Windows CI 在旧 COM 自动化接口保存中文快捷方式时失败，安装正确回滚，正式发布被阻止。保留该标签，v7.6.2 改用显式 `IShellLinkW` 和 `IPersistFile` 保存快捷方式，编译明确使用 UTF-8。新增中文与 emoji 文件名、目标路径和参数的实际 Shell 持久化回归；安装验收要求控制中心和卸载的中文快捷方式存在。接口依据 [Microsoft IShellLinkW](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ishelllinkw)。

## 验证与发布

Unicode Shell 快捷方式回归通过。修复后的真实 Setup 安装、已安装本地工作台、失败修复、依赖复用、注册与中文快捷方式、保留数据卸载通过。浏览器创作、预览、Frame 与 Remotion 截图/MP4、原生控制中心生命周期、语音异常恢复、实际更新成功与失败恢复也通过；证据在 `.cache/desktop-product-smoke-fb42434f/screens/`、`.cache/desktop-update-smoke-1b608293/` 和 `.cache/windows-v762-{installer,product,update}.log`。

补充修复已停止的 `publish_failed` 记录阻止退出的问题：控制中心分别显示后台任务和待恢复结果，允许带着可恢复的失败记录退出，持续运行的任务仍保护重启。3 项桌面协议回归通过，包含真实 SQLite 关闭和重新打开后的失败记录保留。该修复后的候选为 `.cache/windows-v762-final/FrameStudio-v7.6.2-win-x64-Setup.exe`，1,659,024 字节。

准备推送时发现远端 main 新增并行审查后的性能与 TTS 功能（`f9a1209`），需合入后重新执行最终 Windows 与服务端验收。后续补充正式 CI、Release 资产及镜像摘要。本次不切换生产服务，不执行备份。

合入后 SQLite、语音适配、CLI 与桌面协议 7 项通过；语音界面实际浏览器 2 组通过。新增发布工作流的 Windows 语音界面与 SQLite 检查。新版边界测试在本机首次因文件符号链接权限失败，保持断言并在 Windows 无权限时使用实际目录联接；相关 IO 和缓存 14 项重新通过，0 跳过。语音测试夹具的 Windows Vite 冷启动曾超时，改为明确优化实际使用的依赖、隔离每次缓存并清理本次目录后通过，保留原导航和产品断言。

### 合入后的最终本机验收

`fcb1cb9d6fa89b19c5b9fe989a037abf969eb5bb` 候选真实 Setup 为 1,747,877 字节，SHA-256 `4b360b6b3766c89fccbc73791139254f2e861c2f35f3efcf0f836efd109f63f6`。安装、已安装工作台、失败修复、缓存复用、注册和中文快捷方式、保留数据卸载全部通过；浏览器创建、预览、Frame 与 Remotion 截图和 MP4、未保存输入与运行中任务保护、服务异常恢复、关闭控制中心后保持运行、端口冲突和重复启动全部通过。真实更新成功切换、旧应用保留、失败恢复、更新后启动及依赖复用通过。对应 `.cache/windows-v762-merged-{build,product,installer,update}.log`，截图在 `.cache/desktop-product-smoke-3876ba2f/screens/`，更新证据在 `.cache/desktop-update-smoke-411e9d1d/`。

全量本机检查中 93 项单元测试、115 项 MCP 检查和两套前端构建通过，MCP 有 1 项既有可选 SoundFont 跳过。`pnpm verify` 在服务端阶段因本机未配置隔离 PostgreSQL 的 `FRAME_TEST_DATABASE_URL` 返回非零，完整服务端门禁由 GitHub CI 执行，不把本机结果记为全量通过。

发布前远端已合入该候选并推送不可变标签 `v7.6.2`，实际源码为 `e7fcc28e1029889f412b6fe9194977dcdaef34f9`。相对本机候选仅补充部署示例版本和安装测试对中文安装目录、实际 Shell 快捷方式目标及参数的断言，没有应用源码差异。已快进同步 main，沿用 [Release 工作流 36751995846](https://github.com/jianjianai/frame-studio/actions/runs/36751995846)，不重建或移动该标签。

该次 CI 完整服务端门禁通过，英文 Windows 的依赖、真实安装和 Unicode 目标及参数检查、语音界面和 SQLite 检查通过。浏览器创建、预览、Frame 与 Remotion 导出通过后，重启检查读取的进程标识仍为 `6200`，断言失败。发布与镜像作业因此跳过，未生成正式 Release。原证据上传规则没有包含隐藏目录下通配匹配的文件，补充精确范围的隐藏文件上传和失败日志输出，重新执行同一不可变源码以定位重启原因；不把该结果记为发布成功。

同一源码的本机再次验收及 [CI 36753826247](https://github.com/jianjianai/frame-studio/actions/runs/36753826247) 完整 Windows 和服务端门禁通过，证据已下载到 `.cache/release-v762-ci-product/`。复查仍发现旧进程退出与新实例启动可能竞争共享完成状态，需要 [v7.6.3 后续修复](windows-control-center-v7.6.3-20261001.md)。本任务取消该复现运行，镜像与发布作业显示 cancelled。与此同时，原标签运行 `36751995846` 的第 2 次重试全部成功，已在 18:00:29 UTC 生成正式 v7.6.2 Release 和安装资产；这不是取消运行发布成功的证据。保留既有资产和标签，继续发布新的修复版本。
