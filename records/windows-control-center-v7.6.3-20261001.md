# FRAME Studio v7.6.3 Windows 控制中心验收

## 修改

延续 [Windows 控制中心返工](windows-control-center-20260930.md) 和 [v7.6.2 合入验收](windows-control-center-v7.6.2-20261001.md)：完整工作台在默认浏览器打开，Windows 原生窗口管理依赖、更新、重启与日志。Setup 自动准备依赖，使用独立缓存和真实 pnpm 安装，SQLite 与本机 Codex/Claude CLI 执行；语音模型按需下载。

v7.6.2 首次 CI 重启断言失败；同一源码的本机复查及 [CI 36753826247](https://github.com/jianjianai/frame-studio/actions/runs/36753826247) 的真实安装、浏览器与原生界面、导出、正常重启、异常恢复和更新验收全部通过。该次完整服务端门禁也通过。复查发现重启代码的旧进程退出回调引用了下一次启动会重置的共享完成状态，停止超时后关闭 Job 又没有等待旧进程结束。该竞争条件需修复；首次失败的证据不足以唯一确定原因，不将重新执行通过当作该失败原因已经消失。

v7.6.3 使就绪、退出和原生消息绑定本次启动实例，旧回调只能完成旧实例的状态；停止超时后仅终止自有 Job，等待旧进程结束再重新启动。Windows 可以重用 PID，验收改为比较已经收到就绪确认的启动实例标识，并验证地址和实际服务数据。新增真实强制终止后立即重启三次的浏览器验收，检查作品和语音每次恢复。测试入口与实例标识输出仅在 `FRAME_DESKTOP_TEST` 开启时启用。

本任务停止 v7.6.2 复现运行 `36753826247`，其总体及镜像、发布作业显示 cancelled。并行的原标签运行 `36751995846` 第 2 次重试全部成功并生成正式 GitHub Release 和安装资产。保留该版本和不可变标签，继续以 v7.6.3 修复发布，不删除既有资产、不移动标签。本次不切换生产服务器，不执行备份。

## 验证与发布

候选 Setup 为 `.cache/windows-v763/FrameStudio-v7.6.3-win-x64-Setup.exe`，1,749,354 字节，SHA-256 `321d5d7ca312b8009ba3625224627bff958b1e3bc71cfc725c5e73078a04e0b9`。下面补充最终本机验收、CI 与正式发布证明。

本机最终真实 Setup、已安装工作台、失败修复、缓存复用、中文安装路径和 Shell 快捷方式目标、注册及保留数据卸载通过。完整浏览器和原生界面流程通过，包含连续三次强制终止后立即重启、两种渲染器截图及 MP4、编辑与任务保护、正常重启、异常语音恢复、重复启动、端口冲突和窗口收起。更新成功切换、保留上一版、失败恢复、更新后真实启动和缓存复用通过。记录为 `.cache/windows-v763-{build,product,installer,update}.log`，界面证据 `.cache/desktop-product-smoke-afe9cf88/screens/`，更新证据 `.cache/desktop-update-smoke-8e815212/`。

`pnpm verify` 重新执行，93 项单元测试、115 项 MCP 检查、类型检查与两套前端构建通过，MCP 仍有 1 项既有可选 SoundFont 跳过；服务端阶段因本机未配置隔离 PostgreSQL 的 `FRAME_TEST_DATABASE_URL` 返回非零。完整 PostgreSQL 服务端门禁由新标签 CI 执行，未以本机缓存或旧版本 CI 替代。

### 标签与 CI

实际不可变标签源码为 `47adcabe8f5d96436744aca9ac726365d31608ef`，推送标签自动触发 [Release 36757400618](https://github.com/jianjianai/frame-studio/actions/runs/36757400618)。英文 Windows 的真实依赖准备、下载/续传/摘要、Unicode Shell 快捷方式、真实安装与失败修复、9 项语音界面和 SQLite 检查、全部浏览器及原生界面流程（含连续三次强制结束后立即重启）和实际更新成功/失败恢复全部通过。原始日志 `.cache/release-v763-windows-ci.log`，已下载原生页面及浏览器截图 `.cache/release-v763-ci-product/`。

第一次 Linux 服务端作业停留在环境依赖准备约 20 分钟。取消后日志确认 Azure Ubuntu 镜像下载持续缓慢，`mesa-libgallium` 10.8 MB 下载近 2 分钟，最后停留于 `fonts-noto-cjk` 61.2 MB 下载，尚未进入应用测试。这是依赖镜像的基础设施耗时，不记为应用测试失败或通过。日志 `.cache/release-v763-verify-stall.log`；只重新执行服务端作业及其后续发布作业，保留已经通过的同一源码 Windows 结果和安装资产。

### 正式发布证明

该运行的第 2 次执行最终全部成功，2026-09-30 19:01:04 UTC 完成；源码始终为上述 `47adcab`。新的 runner 正常完成依赖、候选镜像和完整门禁：83 项公共单元测试、115 项 MCP 检查、类型及两套前端构建通过；271 项 PostgreSQL 服务端测试通过，0 失败。MCP 有 1 项既有可选音色包跳过，服务端的 2 项跳过为 Windows 本地模式（本次 Windows CI 已实际验收）和既有可选 GeneralUser 音色包。原始完整日志 `.cache/release-v763-verify-ci.log`。

[正式 Release v7.6.3](https://github.com/jianjianai/frame-studio/releases/tag/v7.6.3) 已于 19:01:01 UTC 发布。已实际下载 [Windows Setup](https://github.com/jianjianai/frame-studio/releases/download/v7.6.3/FrameStudio-v7.6.3-win-x64-Setup.exe) 及其校验文件，正式资产为 1,748,016 字节，SHA-256 `ab6346860bb4ec18889020dbd30816a6950fbf8615167ba140ccbdc9291906e7`；与 `.sha256`、GitHub 资产摘要和大小一致，并核对了 GitHub 标签指向的实际提交。下载在 `.cache/release-v763-official/`，证明 `.cache/release-v763-assets-proof.json`。本机候选与正式 CI 编译资产的摘要分开记录，不混用。

GitHub 的正式更新源 `releases/latest` 已实际返回 `v7.6.3` 和相同的两份安装资产，自动更新可发现本次版本。

通过 GHCR Registry API 实际读取以下版本标签、镜像配置及 `sha-47adcabe8f5d96436744aca9ac726365d31608ef` 标签；每个镜像的版本标签与提交标签摘要一致，`org.opencontainers.image.revision` 均为上述真实源码提交，平台 `linux/amd64`。证明 `.cache/release-v763-images-proof.json`。

| 镜像 | 实际发布摘要 |
| --- | --- |
| `ghcr.io/jianjianai/frame-studio/app:7.6.3` | `sha256:14f84784e0dfc584f6735b0e81a7ce341bd1f33bb15d2d4999db7f21bf76c25b` |
| `ghcr.io/jianjianai/frame-studio/speech:7.6.3` | `sha256:955388bcddf80a60c75a066dc16dafd1b1b49dcc3db3b1ba3660c4db6116f643` |

本次通过推送 `v*` 标签实际证明了 Windows Setup、App/Speech 镜像和匹配 Release 的完整自动发布链。仅执行发布及读取验证，没有执行本次版本的生产切换，没有执行备份。保留并行工作提交的 `records/production-7.6.2-20261001.md`。
