# FRAME Studio v7.6.2 Windows 控制中心发布

## 修改

延续 [Windows 控制中心返工](windows-control-center-20260930.md) 与 [v7.6.1 候选验收](windows-control-center-v7.6.1-20261001.md) 的完整范围：浏览器工作台，独立 Windows 控制中心，真实 Setup，SQLite、pnpm 依赖缓存、本机 Codex/Claude CLI 和自动更新。

v7.6.1 的英文 Windows CI 在旧 COM 自动化接口保存中文快捷方式时失败，安装正确回滚，正式发布被阻止。保留该标签，v7.6.2 改用显式 `IShellLinkW` 和 `IPersistFile` 保存快捷方式，编译明确使用 UTF-8。新增中文与 emoji 文件名、目标路径和参数的实际 Shell 持久化回归；安装验收要求控制中心和卸载的中文快捷方式存在。接口依据 [Microsoft IShellLinkW](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ishelllinkw)。

## 验证与发布

Unicode Shell 快捷方式回归通过。修复后的真实 Setup 安装、已安装本地工作台、失败修复、依赖复用、注册与中文快捷方式、保留数据卸载通过。浏览器创作、预览、Frame 与 Remotion 截图/MP4、原生控制中心生命周期、语音异常恢复、实际更新成功与失败恢复也通过；证据在 `.cache/desktop-product-smoke-fb42434f/screens/`、`.cache/desktop-update-smoke-1b608293/` 和 `.cache/windows-v762-{installer,product,update}.log`。

补充修复已停止的 `publish_failed` 记录阻止退出的问题：控制中心分别显示后台任务和待恢复结果，允许带着可恢复的失败记录退出，持续运行的任务仍保护重启。3 项桌面协议回归通过，包含真实 SQLite 关闭和重新打开后的失败记录保留。该修复后的候选为 `.cache/windows-v762-final/FrameStudio-v7.6.2-win-x64-Setup.exe`，1,659,024 字节。

准备推送时发现远端 main 新增并行审查后的性能与 TTS 功能（`f9a1209`），需合入后重新执行最终 Windows 与服务端验收。后续补充正式 CI、Release 资产及镜像摘要。本次不切换生产服务，不执行备份。

合入后 SQLite、语音适配、CLI 与桌面协议 7 项通过；语音界面实际浏览器 2 组通过。新增发布工作流的 Windows 语音界面与 SQLite 检查。新版边界测试在本机首次因文件符号链接权限失败，保持断言并在 Windows 无权限时使用实际目录联接；相关 IO 和缓存 14 项重新通过，0 跳过。语音测试夹具的 Windows Vite 冷启动曾超时，改为明确优化实际使用的依赖、隔离每次缓存并清理本次目录后通过，保留原导航和产品断言。
