# FRAME Studio v7.6.3 Windows 控制中心验收

## 修改

延续 [Windows 控制中心返工](windows-control-center-20260930.md) 和 [v7.6.2 合入验收](windows-control-center-v7.6.2-20261001.md)：完整工作台在默认浏览器打开，Windows 原生窗口管理依赖、更新、重启与日志。Setup 自动准备依赖，使用独立缓存和真实 pnpm 安装，SQLite 与本机 Codex/Claude CLI 执行；语音模型按需下载。

v7.6.2 首次 CI 重启断言失败；同一源码的本机复查及 [CI 36753826247](https://github.com/jianjianai/frame-studio/actions/runs/36753826247) 的真实安装、浏览器与原生界面、导出、正常重启、异常恢复和更新验收全部通过。该次完整服务端门禁也通过。复查发现重启代码的旧进程退出回调引用了下一次启动会重置的共享完成状态，停止超时后关闭 Job 又没有等待旧进程结束。该竞争条件需修复；首次失败的证据不足以唯一确定原因，不将重新执行通过当作该失败原因已经消失。

v7.6.3 使就绪、退出和原生消息绑定本次启动实例，旧回调只能完成旧实例的状态；停止超时后仅终止自有 Job，等待旧进程结束再重新启动。Windows 可以重用 PID，验收改为比较已经收到就绪确认的启动实例标识，并验证地址和实际服务数据。新增真实强制终止后立即重启三次的浏览器验收，检查作品和语音每次恢复。测试入口与实例标识输出仅在 `FRAME_DESKTOP_TEST` 开启时启用。

请求停止本任务的 v7.6.2 发布运行时，发布动作已在完成边界执行；运行总体显示 cancelled，实际 GitHub Release 和安装资产仍已生成。保留该版本和不可变标签，继续以 v7.6.3 修复发布，不删除既有资产、不移动标签。本次不切换生产服务器，不执行备份。

## 验证与发布

候选 Setup 为 `.cache/windows-v763/FrameStudio-v7.6.3-win-x64-Setup.exe`，1,749,354 字节，SHA-256 `321d5d7ca312b8009ba3625224627bff958b1e3bc71cfc725c5e73078a04e0b9`。下面补充最终本机验收、CI 与正式发布证明。

本机最终真实 Setup、已安装工作台、失败修复、缓存复用、中文安装路径和 Shell 快捷方式目标、注册及保留数据卸载通过。完整浏览器和原生界面流程通过，包含连续三次强制终止后立即重启、两种渲染器截图及 MP4、编辑与任务保护、正常重启、异常语音恢复、重复启动、端口冲突和窗口收起。更新成功切换、保留上一版、失败恢复、更新后真实启动和缓存复用通过。记录为 `.cache/windows-v763-{build,product,installer,update}.log`，界面证据 `.cache/desktop-product-smoke-afe9cf88/screens/`，更新证据 `.cache/desktop-update-smoke-8e815212/`。

`pnpm verify` 重新执行，93 项单元测试、115 项 MCP 检查、类型检查与两套前端构建通过，MCP 仍有 1 项既有可选 SoundFont 跳过；服务端阶段因本机未配置隔离 PostgreSQL 的 `FRAME_TEST_DATABASE_URL` 返回非零。完整 PostgreSQL 服务端门禁由新标签 CI 执行，未以本机缓存或旧版本 CI 替代。
