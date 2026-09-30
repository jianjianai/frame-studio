# Windows 本地模式

Windows 本地包提供完整 FRAME 工作台：作品仓库、素材、预览、导出、语音、对话与 AI 创作。它使用 SQLite、原生子进程和本机回环地址；运行时不需要 Docker、PostgreSQL 或工作台密码。服务器模式仍按 [SERVER.md](SERVER.md) 运行。

## 安装与使用

1. 从平台仓库的 [GitHub Releases](https://github.com/jianjianai/frame-studio/releases) 下载与版本号匹配的 `FrameStudio-v<版本>-win-x64.zip` 及 `.sha256`，校验 SHA-256 后完整解压到普通文件夹。
2. 双击 `FrameStudio.exe`。程序启动 SQLite、语音服务和工作台后常驻托盘；左键单击托盘图标在默认浏览器打开工作台，右键选择“退出”会停止本次启动的服务与任务。
3. 第一次使用时，工作台数据自动保存在 `%LOCALAPPDATA%\FRAME Studio`。更新版本时先从托盘退出，然后将新版解压到新文件夹运行。数据目录独立于程序目录。

工作台仅监听 `127.0.0.1:43173`，语音服务使用临时分配的本机回环端口。如果端口被占用或包内文件缺失，托盘会显示启动失败，详细原因保存在 `%LOCALAPPDATA%\FRAME Studio\desktop.log` 或 `speech.log`。客户端包自带 Node.js、pnpm、Git、FFmpeg、Python 语音依赖及内置模型；浏览器预览使用电脑上的 Microsoft Edge 或兼容 Chromium。

## 本机 AI CLI

在 Windows 终端安装并登录 Codex CLI 或 Claude CLI；工作台直接读取该登录状态，不单独保存一份 AI 密码。未安装的 CLI 在“设置 → 提供商与模型 / 创作工具”显示不可用，不能用于新任务。安装或登录后返回工作台刷新并点击“检查登录”。

本地模式只创建 Codex 和 Claude 两个固定连接，默认使用 CLI 的默认模型；可以为已登录的 CLI 手动添加模型 ID。CLI 的安装与更新在 Windows 终端完成。任务启动后使用 CLI 的现有账号和本机网络环境。

## 数据与功能

`frame.sqlite` 保存工作台状态、会话、任务与事件；SQLite WAL 文件与主密钥也在本地数据目录。作品 Git 仓库、素材、语音自定义模型和任务产物位于同一数据目录。内置语音模型随程序包提供，自定义语音模型写在数据目录中。工作台关闭时停止它启动的原生任务与语音服务；任务记录保留，重新启动后可查看并重试中断的任务。

本地模式的 API 限定回环地址与同源请求；没有工作台登录密码。请按普通本机应用保护 Windows 账号和数据目录。GitHub 仓库同步与向作品仓库发布导出仍需要对应的 GitHub 授权和网络连接。

## 发布规则

平台版本由 `package.json` 与 `src/contracts/version.mjs` 定义。推送同版本 `v<版本>` 标签后，独立的 Windows [发布工作流](../.github/workflows/release.yml)先在 Windows 验证 SQLite 和原生帧导出，再构建包含语音模型的 ZIP 与 SHA-256，最后创建或更新同标签的 GitHub Release。失败的构建不会发布客户端文件。服务器镜像发布流程独立。

本地开发可运行 `node --test tests/server/local-mode.test.mjs` 验证 SQLite 和原生导出；`desktop/package.ps1` 构建无语音模型的包用于代码与依赖检查，正式发布必须使用 `-IncludeSpeech` 并完成语音服务验证。
