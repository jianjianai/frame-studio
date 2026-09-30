# Windows 本地模式

Windows 本地包提供完整 FRAME 工作台：作品仓库、素材、预览、导出、语音、对话与 AI 创作。它使用 SQLite、原生子进程和本机回环地址；运行时不需要 Docker、PostgreSQL 或工作台密码。服务器模式仍按 [SERVER.md](SERVER.md) 运行。

## 安装与使用

1. 从平台仓库的 [GitHub Releases](https://github.com/jianjianai/frame-studio/releases) 下载与版本号匹配的 `FrameStudio-v<版本>-win-x64-Setup.exe`（另提供 `.sha256` 校验文件），双击按向导安装。需要 Windows 10/11 x64；默认安装到当前用户目录，无需管理员权限。
2. 安装程序自动检查、下载和校验工具、Python 语音运行环境，并使用 pnpm 安装 Node 依赖。安装窗口显示进度，详细日志在 `%LOCALAPPDATA%\FRAME Studio\installer.log`。完成后创建开始菜单快捷方式与 Windows 卸载入口，可以直接启动工作台。
3. 启动后驻留托盘。左键单击托盘图标在默认浏览器打开工作台，右键选择“退出”会停止本次启动的服务与任务。数据保存在 `%LOCALAPPDATA%\FRAME Studio`，独立于程序目录。
4. 更新时先从托盘退出，再运行新版 Setup。运行环境和 pnpm 缓存继续复用；依赖准备失败时不会切换旧版程序。重新运行安装程序可以修复缺失或无法运行的工具与 Python 组件。通过 Windows“已安装的应用”或开始菜单卸载会移除程序，保留作品、数据库、模型及依赖缓存。

工作台仅监听 `127.0.0.1:43173`，语音服务使用临时分配的本机回环端口。工具与 Python 运行环境位于数据目录的 runtimes 中；Node 依赖由 pnpm 根据锁文件安装，共享数据目录中的 pnpm-store。依赖变化时 pnpm 只下载缺少的包。下载失败可重新运行安装程序重试。预览使用电脑上的 Microsoft Edge 或 Chrome；两者均未安装时，安装程序自动下载专用 Chromium。运行日志保存在 desktop.log 或 speech.log。

## 本机 AI CLI

在 Windows 终端安装并登录 Codex CLI 或 Claude CLI；工作台直接读取该登录状态，不单独保存一份 AI 密码。未安装的 CLI 在“设置 → 提供商与模型 / 创作工具”显示不可用，不能用于新任务。新安装 CLI 后从托盘退出并重新启动工作台，以加载更新后的 PATH；登录后刷新并点击“检查登录”。

本地模式只创建 Codex 和 Claude 两个固定连接，默认使用 CLI 的默认模型；可以为已登录的 CLI 手动添加模型 ID。CLI 的安装与更新在 Windows 终端完成。任务启动后使用 CLI 的现有账号和本机网络环境。

## 数据与功能

`frame.sqlite` 保存工作台状态、会话、任务与事件；SQLite WAL 文件与主密钥也在本地数据目录。作品 Git 仓库、素材、模型和任务产物位于同一数据目录。程序包不携带语音权重，在设置的语音引擎列表中点击“下载模型”，安装后才可试听；也可以上传自定义 Kokoro 模型。模型保存在 models 中，升级后保留。工作台关闭时停止它启动的原生任务与语音服务；任务记录保留，重新启动后可查看并重试中断的任务。

本地模式的 API 限定回环地址与同源请求；没有工作台登录密码。请按普通本机应用保护 Windows 账号和数据目录。GitHub 仓库同步与向作品仓库发布导出仍需要对应的 GitHub 授权和网络连接。

## 发布规则

平台版本由 `package.json` 与 `src/contracts/version.mjs` 定义。推送同版本 `v<版本>` 标签自动触发统一[发布工作流](../.github/workflows/release.yml)：校验版本与源码提交，执行完整服务端门禁和 Windows 实际安装测试，构建并发布两个 Docker 镜像，最后把 Setup.exe 与 SHA-256 发布到同版本 GitHub Release。任一门禁失败都不会创建正式 Release。镜像与安装程序来自同一标签；发布不自动切换生产服务器。

安装程序使用固定版本、SHA-256 校验的 NSIS 编译器构建。缺失的版本化运行环境发布到 windows-runtimes Release，已有组件保持不可变。语音权重不进入安装程序、运行环境组件或服务器镜像。

本地开发运行 `node --test tests/server/local-mode.test.mjs tests/server/model-downloads.test.mjs tests/desktop/dependencies.test.mjs`；`tests/desktop/bootstrap.test.ps1` 检查工具安装、定向修复、缓存复用与摘要失败。pnpm 测试使用本机临时下载源验证真实安装、失败重试、更新复用和增量下载。`tests/desktop/installer.test.ps1` 执行真实 EXE 的安装、已安装工作台测试、失败修复、缓存复用与保留数据卸载；检测到已有用户安装时拒绝执行。正式发布使用 `desktop/package.ps1 -PublishRuntimes`。组件缓存和发布规则见 [安装依赖与可选模型](RUNTIME-DOWNLOADS.md)。
