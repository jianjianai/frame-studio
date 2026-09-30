# Windows 本地模式验证记录 · 2026-09-30

## 范围

新增 Windows 原生托盘入口、SQLite 数据库、原生任务执行、完整工作台静态资源和离线语音包。客户端使用本机 Codex / Claude CLI；缺失时在连接列表中显示不可用。正式发布包由 `desktop/package.ps1 -IncludeSpeech` 构建，并由版本标签触发的 GitHub Actions 上传至同标签 Release。

## 已验证

- `node --test tests/server/local-mode.test.mjs`：2/2 通过。在 Windows 创建作品仓库与作品、读取素材与会话、渲染单帧、导出 1 秒 MP4、构建预览；请求无需工作台密码，跨源写请求被拒绝。
- 内置语音模型逐一合成：Kokoro、Melo、Piper 均返回有效 WAV。语音模型和原生库位于中文路径时，启动器临时映射 ASCII 盘符，退出时清理映射。
- `desktop/package.ps1 -SpeechBundle <已验证模型目录>`：构建完整 Windows 包，运行包内 Node、Git、FFmpeg、pnpm 和三种语音模型检查。此参数仅复用本机已下载的模型；CI 的正式构建使用 `-IncludeSpeech` 从固定来源重新下载。
- `FrameStudio-v7.2.0-win-x64.zip`：1,760,002,347 字节；SHA-256 `0a7607a15ea271a08e83df07b970c6820cf5023c075311e08c4ce700d3afad94`，与随包校验文件一致。ZIP 内检查了托盘、Node、Git、FFmpeg、pnpm、Python、模型、服务端入口和前端入口。
- 从完整包内运行 `node.exe server/local-app.mjs`：`/healthz` 返回 7.2.0，`/api/me` 返回 `localMode: true`，`system_status.speech.ok` 为 true。输入 `exit` 后本机服务关闭，语音进程退出，临时盘符映射被清除。
- 本机 Codex CLI 登录状态和实际一次响应已验证。Claude CLI 登录状态正常，但本机实际请求遇到上游 HTTP 503，不能据此确认 Claude 当时的生成服务可用。

## 公共检查与限制

`pnpm verify` 的类型检查、平台检查和核心 Vitest（93 项）通过；MCP 测试 83 通过、2 失败、1 跳过。失败分别是 Windows 创建符号链接权限 `EPERM` 和预览网络测试出现预期外重复请求（当时同时下载大型语音模型）。因此没有把公共检查记为全通过。

托盘程序由 Windows C# 编译器构建并随包分发；已通过包内服务启动与 HTTP 健康检查。当前自动化环境没有原生桌面点击接口，尚未验证鼠标左键和右键的实际托盘交互。发布包不是安装程序，须先完整解压再运行。
