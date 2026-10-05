# FRAME Studio

用 AI 制作视频的工作台。描述你想要的画面，内置的 Claude Code / Codex 编写代码生成动画、配乐和配音；你在旁边实时预览、圈出问题、录音、微调时间轴，最后导出 MP4。

```
新建作品（AI 或空白） → [ 上传素材 → AI 制作 → 实时预览审片 ] 循环 → 导出
```

- **内置 AI**：通过 [Agent Client Protocol](https://agentclientprotocol.com) 驱动 Claude Code 和 Codex。在设置中登录 Claude 或 ChatGPT 账号，或添加任意 Anthropic / OpenAI 兼容 API。聊天面板与 VS Code 的 AI 聊天一致：流式回复、工具调用、文件差异、权限确认、模型与模式切换。
- **AI 看得见、听得到**：FRAME 的 MCP 工具让 AI 渲染画面、拼分镜、分析响度、检查运行错误，并知道你在播放器里正在看哪一秒。
- **实时预览**：保存即更新，不刷新、不丢播放位置。
- **简单的人工编辑**：时间轴上拖动、裁剪、切开图层与音频，编辑字幕和镜头标记；内置代码编辑器。
- **录音**：从播放头开始边看边录，录音直接落在音轨上。
- **配音**：Edge 在线语音、OpenAI 兼容语音接口，或下载离线语音模型（Kokoro、MeloTTS、Piper 等）。
- **版本与同步**：每个作品是 Git 分支，AI 每轮修改自动保存版本、一键撤销；作品库和共享素材库可同步到 GitHub。
- **外部 AI 也能用**：MCP（HTTP / stdio），Claude Desktop、Cursor、Codex 等都可以直接制作作品。

## 快速开始

需要 Node.js 22.13+、Git，以及 Chrome / Chromium（用于 AI 看画面和导出）。

```bash
corepack enable
pnpm install
pnpm build
pnpm start
```

打开 http://127.0.0.1:4310 。首次使用在 设置 → AI 中登录 Claude 或 ChatGPT（本机已登录的 `claude` / `codex` CLI 会被自动识别）。数据保存在 `~/.frame-studio`（可用 `FRAME_HOME` 修改）。

服务器部署见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 文档

- [使用指南](docs/USER-GUIDE.md)：创作流程、时间轴、录音、配音、素材、版本、导出
- [AI 与 MCP](docs/AI.md)：账号登录、自定义 API、聊天、外部 AI 接入、工具列表
- [作品制作指南](docs/guide/overview.md)：作品代码结构与接口（AI 通过 `frame_guide` 工具读取同一份内容）
- [架构](docs/ARCHITECTURE.md)：代码结构与运行原理
- [部署](docs/DEPLOY.md)：Docker、反向代理、环境变量

## 开发

```bash
pnpm dev        # 界面热更新
pnpm check      # 类型检查 + 测试 + 构建
```

开发约定见 [AGENTS.md](AGENTS.md)。
