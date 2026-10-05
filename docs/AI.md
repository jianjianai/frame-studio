# AI 与 MCP

## 内置 AI

FRAME 通过 [Agent Client Protocol](https://agentclientprotocol.com) 运行两种代理：

| 代理 | 账号登录 | API |
|---|---|---|
| Claude Code（claude-agent-acp） | Claude 订阅（Pro/Max/Team） | Anthropic API，或任何 Anthropic 兼容接口 |
| Codex（codex-acp） | ChatGPT 订阅 | OpenAI API，或任何支持 Responses API 的 OpenAI 兼容接口 |

两个代理和它们的 CLI 随 `pnpm install` 安装，不需要另外安装。

### 登录账号

设置 → AI：

- **Claude**：点「登录」，在打开的页面授权后，把页面显示的代码粘贴回来。
- **ChatGPT**：点「登录」，在打开的页面输入显示的设备码。若提示设备码登录未启用，请在 ChatGPT 的安全设置中开启 Codex 设备码授权。

本机已经用 `claude` / `codex` 命令登录过的账号会被直接识别。Docker 中凭据保存在 `/data/home`。

### 自定义 API

设置 → AI → 自定义 API，可从预设（Anthropic、OpenAI、DeepSeek、Kimi、智谱 GLM、OpenRouter）开始，填写接口地址、API Key 和模型列表。

- Anthropic 兼容：由 Claude Code 驱动。模型列表的第一个是默认模型，聊天中可切换。
- OpenAI 兼容：由 Codex 驱动，需要接口支持 Responses API（`/v1/responses`）。
- 切换模型会在新的上下文中继续对话（对话记录保留在界面中）。

### AI 能做什么

AI 在作品目录中工作，拥有读写文件和运行命令的能力（与在终端中使用 Claude Code / Codex 相同），另外连接了 FRAME 工具（见下表）。作品根目录的 `AGENTS.md` / `CLAUDE.md` 告诉 AI 作品结构与工作流程；作品自己的 `projects/<名称>/AGENTS.md` 记录需求。

权限模式（聊天底部选择）：

- Claude：接受编辑（默认）、手动确认、计划、自动、跳过权限。
- Codex：自动审查（默认）、工作区读写、只读、完全访问。

## 外部 AI 通过 MCP 使用 FRAME

### HTTP

地址 `http://<主机>:4310/mcp`（Streamable HTTP）。本机未设置密码时无需令牌；否则在 设置 → MCP 中创建令牌，请求头加 `Authorization: Bearer <令牌>`。

```bash
claude mcp add --transport http frame http://127.0.0.1:4310/mcp --header "Authorization: Bearer <令牌>"
```

### stdio

```json
{ "mcpServers": { "frame": { "command": "node", "args": ["/path/to/frame-studio/bin/frame.mjs", "mcp"] } } }
```

`frame mcp` 会连接正在运行的 Studio（`FRAME_URL`，默认 `http://127.0.0.1:4310`，需要时设置 `FRAME_TOKEN`）；没有运行时在进程内启动一个。`--work <id>` 限定只操作一个作品，`--read-only` 只提供只读工具。

### 命令行

```bash
frame tools                                   # 列出工具
frame call work_context '{"work":"ab12cd34"}' # 调用任意工具
frame call preview_frames '{"work":"ab12cd34","times":[1,5]}' --out ./shots
frame export ab12cd34 --width 1920
```

## 工具

| 工具 | 作用 |
|---|---|
| `frame_guide` | 制作指南（接口与示例），按主题读取 |
| `works_list` / `work_create` / `work_update` | 列出、新建作品，修改标题、时长、镜头标记等 |
| `work_context` | 作品现状：元数据、文件、素材、图层、音轨、未保存修改、用户正在看的位置、最近检查 |
| `work_check` | 类型、素材引用、真实浏览器加载并渲染几帧和一段音频 |
| `preview_frames` / `storyboard` | 渲染指定时间的画面 / 带时间标注的分镜总览图 |
| `preview_audio` | 一段混音的响度、静音段、削波 |
| `files_list` / `file_read` / `file_write` / `file_edit` / `file_move` / `file_delete` | 作品文件操作（外部 AI 使用；内置 AI 用自己的文件工具） |
| `assets_list` / `asset_import` / `library_list` | 素材与共享素材库 |
| `layers_get` / `layers_edit` | visual.json 图层 |
| `audio_get` / `audio_edit` / `audio_place` | audio.json 混音 |
| `speech_voices` / `speech_synthesize` | 配音；`lines` + `place` + `subtitles` 一次生成整段旁白、排上音轨并写字幕 |
| `subtitles_edit` | 字幕：整体替换、追加（替换重叠的旧字幕）、按时间段删除 |
| `versions_list` / `version_save` / `version_diff` / `version_restore` | 版本 |
| `export_video` / `task_status` / `exports_list` | 导出 MP4 |

工具设计约定（新增工具时遵守）：

- 返回给 AI 的文字要能直接行动：报错说明哪里错、应该怎么改；运行错误的位置是作品源码的 `文件:行:列`。
- 自定义文字之外 AI 还需要的小数据（如 `sha256`）放在 `meta`，所有客户端都会收到。
- 参数结构很大时（`layers_edit`、`audio_edit` 的文档操作）用 `publicInput` 向客户端公布精简结构，详细格式写进 `docs/guide`，并用 `guide` 指向该主题；服务端仍按完整结构校验。
- 会覆盖或删除内容的工具标记 `destructive`。
