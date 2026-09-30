# FRAME Studio v7.6.1 Windows 控制中心验收与发布

## 交付范围

工作台在默认浏览器打开，Windows 原生控制中心负责运行状态、依赖下载与修复、重启、自动更新、日志与退出。托盘左键打开浏览器，右键提供控制中心及退出菜单。安装包移除 WebView2，保留完整浏览器工作台。使用 SQLite 和 Windows 原生任务；工具、Python 与 pnpm 缓存独立于程序保存，语音模型按需下载。

合入远端 v7.6.0 的作品库、账号、设置与 Remotion 功能，正式版本使用 v7.6.1。首次 GitHub 账号授权所需 CLI 单独按官方版本与摘要下载，已有可用 CLI 直接复用。新安装的 Codex/Claude CLI 在重启后重新读取系统 PATH。

## 本地验收

- 真实 NSIS Setup、原生安装向导、快捷方式、卸载注册、失败修复、缓存复用与保留数据卸载通过。
- 完整浏览器流程通过：免密码首次创作、CLI 状态、预览、原生截图与 MP4、Remotion 截图与 MP4、未保存编辑及繁忙任务保护、稳定地址重启、SQLite 作品保留、重复启动、控制中心收起、异常退出与语音恢复。
- 实际已校验 Setup 更新通过：版本目录与入口切换、上一程序保留、缓存复用。依赖失败时保留工作程序、注册和数据；更新后的程序启动与退出通过。
- 续传、忽略 Range、中断重试、摘要与来源校验、篡改拒绝、自动更新开关持久化在本轮较早候选上通过，正式标签工作流再次执行这些检查。
- 新增 GitHub CLI 的真实下载、官方摘要、健康检查与缓存复用通过；PowerShell 5 回归同时断言首次返回唯一可用 PATH，避免提取日志污染返回值。
- 本机 CLI 参数边界、桌面协议及 SQLite 回归共 6 项通过，0 失败、0 跳过。
- `pnpm verify` 工程检查、93 项 Vitest、87 项 MCP（86 通过、1 项既有可选跳过）和构建通过；服务端阶段因本机未配置隔离的 `FRAME_TEST_DATABASE_URL` 返回非零，完整 PostgreSQL 与 Docker 执行门禁交由标签 CI 执行，不记作本地全量通过。
- Windows 当前 200% 缩放下检查实际安装向导、四个控制中心页面与浏览器界面图像，文字与操作控件可见。

本机证据：`.cache/desktop-product-smoke-4acb212b/screens/`、`.cache/desktop-update-smoke-c281da3b/`，日志 `.cache/windows-v761-complete-{product,installer,update}.log`、`.cache/windows-v761-verify.log`、`.cache/windows-v761-local-regression.log`、`.cache/windows-github-cli-regression.log`。测试使用隔离的 FRAMEStudioTest 注册表与快捷方式，完成后卸载测试程序，保留证据和缓存。

候选 Setup 大小 1,654,494 字节；正式资产由同一标签 CI 重新构建，以正式 Release 的摘要为准。异常语音盘符清理检查记录中的目标路径，只释放本应用创建的映射，不处理其他程序盘符。

## 发布状态

本次发布不切换生产服务器，不执行备份。正式标签工作流需先通过 Windows 实际安装/使用/更新验收和完整服务端门禁，再发布同版本安装程序及 App、Speech Docker 镜像。发布完成后补充 CI、正式资产和镜像摘要。
