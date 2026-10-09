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
- 一个对话固定使用一个 AI 配置和自定义 API 的一个模型（换了就是另一个上下文）：在对话中选择其他的，会新建一个对话。模型、模式、思考强度的切换立即显示；AI 进程空闲退出后的对话在下次启动时应用。

### AI 能做什么

AI 在作品目录中工作，拥有读写文件和运行命令的能力（与在终端中使用 Claude Code / Codex 相同），另外连接了 FRAME 工具（见下表）。

权限模式（聊天底部选择）：

- Claude：接受编辑（默认）、手动确认、计划、自动、跳过权限。
- Codex：自动审查（默认）、工作区读写、只读、完全访问。

手动确认（Claude 的“手动确认”、Codex 的“只读”）和计划模式下，AI 用 FRAME 工具修改作品（图层、混音、字幕、配音、素材、经验库等）之前，也会在聊天中请求确认；读取和预览类工具不需要确认。用户拒绝后 AI 会停下来询问，而不是换个方式继续改。

### AI 知道什么

**会话说明**：每次开始或恢复对话时，FRAME 重新生成作品根目录的 `AGENTS.md`（Claude Code 通过 `CLAUDE.md` 导入，Codex 直接读取）：

- 平台规则：作品结构、工作流程、工具用法。
- 作品自己的需求与约定：`projects/<名称>/AGENTS.md` 的原文（超过 6 KB 时只放开头）。
- 关联的经验库（可以多个）：按作品里的顺序，预算（12 KB）够的放全部文档，其余的放 README 和其他文档的目录（标题 + 第一句），AI 按需用 `experience_read` 阅读全文。

文档逐字放在代码块里，AI 可以直接复制原文做精确修改。整份说明不超过 Codex 读取 `AGENTS.md` 的 32 KiB 上限，代理压缩上下文后仍然保留。

**每条消息**：消息后面附一段 `[FRAME]`，只写 AI 还不知道的，没有变化就不写：

- 播放位置；时间轴上选中的对象（图层、音频片段、音轨、字幕、镜头标记，带名称和时间）；编辑器中打开的文件。
- 上一轮之后用户或其他对话改动过的作品文件，提醒 AI 先读最新内容再改，不要覆盖用户的修改。
- 经验库的变化：用户或其他对话新增、修改、删除的文档（小文档附最新全文）；作品新关联的经验库附上内容，取消关联的说明一句。AI 自己读过、写过的不再重复；经验库改名不算变化。

服务端按对话记录 AI 已经知道的经验库内容（每篇文档的哈希，以及读过全文还是只看过目录），恢复对话后继续沿用。

**上下文用量与压缩**：两个代理都在每轮结束时报告上下文用量（`usage_update`），聊天输入框显示为圆圈。「压缩上下文」发送代理自己的 `/compact` 命令（斜杠命令原样发送，不附加 `[FRAME]`）。压缩之后（手动或自动），服务端认为 AI 只确定记得会话说明里的内容，之后经验库的变化重新完整告诉它。

**分支**：从某条 AI 回复分支或修改之前的消息时，新对话复制到那里为止的对话记录（和其中的图片），并用代理自己的 `session/fork` 在那条回复之后分叉 AI 的上下文（Claude 和 Codex 都支持）；修改消息则在分叉后发送新内容。分支点之后被丢弃的轮次改过的文件不会回退，分支的第一条消息会告诉 AI 这一点。

**已发布的作品**：只能查看，但可以继续聊天（复盘、整理经验）。作品文件在磁盘上设为只读（`projects/` 和根目录的受版本管理文件），代理自己的编辑工具也改不了；FRAME 工具中会修改作品的都会被拒绝（导出和经验库工具除外）；每条消息的 `[FRAME]` 都会说明作品已发布。

**工具**：Claude Code 直接加载常用的 FRAME 工具（`CORE_TOOLS`），其余在需要时通过工具搜索加载。内置 AI 的会话只能操作当前作品，工具没有 `work` 参数；它用自己的工具读写作品文件，所以工具列表里没有 `files_list` / `files_batch`，MCP 说明也只是一句话（完整用法在会话说明里）。

## 外部 AI 通过 MCP 使用 FRAME

### HTTP

地址 `http://<主机>:4310/mcp`（Streamable HTTP）。本机未设置密码时无需认证；否则用 OAuth（见下节），或在 设置 → MCP 中创建令牌，请求头加 `Authorization: Bearer <令牌>`。

```bash
claude mcp add --transport http frame http://127.0.0.1:4310/mcp --header "Authorization: Bearer <令牌>"
```

### OAuth

支持 MCP 授权规范的客户端（Claude 网页版/桌面版自定义连接器、ChatGPT、Claude Code、Cursor、MCP Inspector 等）只需填写地址 `https://<域名>/mcp`：

1. 客户端访问 `/mcp` 得到 401，按 `WWW-Authenticate` 找到 `/.well-known/oauth-protected-resource/mcp` 和 `/.well-known/oauth-authorization-server`。
2. 客户端在 `/oauth/register` 动态注册，然后打开 `/oauth/authorize`（必须使用 PKCE S256）。
3. 授权页上输入 Studio 密码（已登录则不需要），选择 **读写/只读** 和 **全部作品/某一个作品**，点「允许」。
4. 客户端用授权码在 `/oauth/token` 换取访问令牌（1 小时）和刷新令牌（每次使用后轮换；90 天未使用失效）。

已授权的应用列在 设置 → MCP 接入，撤销后立即失效。OAuth 令牌只能调用 FRAME 工具（`/mcp`），不能访问 Studio 的其他接口和作品文件。

网页版客户端（如 claude.ai）从公网连接，需要 HTTPS 反向代理、`FRAME_PUBLIC_URL` 和 `FRAME_PASSWORD`（见 [DEPLOY.md](DEPLOY.md)）。本机未设置密码时 `/mcp` 对本机进程开放，客户端不会触发 OAuth。

### stdio

```json
{ "mcpServers": { "frame": { "command": "node", "args": ["/path/to/frame-studio/bin/frame.mjs", "mcp"] } } }
```

`frame mcp` 会连接正在运行的 Studio（`FRAME_URL`，默认 `http://127.0.0.1:4310`，需要时设置 `FRAME_TOKEN`）；没有运行时在进程内启动一个。`--work <id>` 限定只操作一个作品（工具不再有 `work` 参数，限定作品的令牌和 OAuth 授权也一样），`--read-only` 只提供只读工具。

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
| `works_list` / `work_create` / `work_update` | 列出、新建作品，修改标题、时长、镜头标记、封面画面等 |
| `work_delete` | 请求删除作品：只做标记，用户在首页作品列表中确认（移到回收站）或保留 |
| `work_context` | 作品现状：元数据、需求、关联的经验库、文件、素材、图层、音轨、未保存修改、用户正在看的位置、最近检查、最近的导出、是否已发布、和 GitHub 的同步状态（外部 AI 调用时当场和 GitHub 比较，需要先处理的情况写在 `warnings`；内置 AI 的会话说明里已有需求和经验库，这里只给经验库目录） |
| `work_check` | 类型、素材引用、真实浏览器加载并渲染几帧和一段音频 |
| `preview_frames` | 渲染画面：`times` 指定时刻，或 `count`（加 `start`/`end`）均匀取样；4 张以内分开返回，更多拼成一张带时间标注的总览图（`work_check` 的 `frames: true` 也会附上检查时渲染的 5 个时刻） |
| `preview_audio` | 一段混音或一个音频文件（`src`）的响度、静音段、削波；`beats: true` 给出 BPM、节拍点和最强的起音（ffmpeg 解码，mel 频带起音强度 + 自相关测速 + 动态规划找节拍） |
| `search` | 和 grep 一样按内容判断文本文件（8 MB 以内），整行都搜、长行只显示匹配附近；文字或正则、多个关键词、整词、跨行、区分大小写、glob / exclude、前后上下文、每文件上限；范围可选作品、作品用到的素材库文件（锁定的版本）、素材库当前版本、经验库、制作指南、引擎源码；返回 文件:行号 和上下文 |
| `files_list` / `files_batch` | 作品文件（外部 AI 使用；内置 AI 的工具列表里没有它们，用自己的文件工具）：一次调用对一个或多个文件读、写、精确替换、删除、移动；默认能做的都做、失败的逐项说明（同一文件前面失败则后面跳过），`atomic` 时全部成功才写入；`check` / `frames` 改完直接检查并看画面 |
| `asset_import` / `asset_view` | 作品自己的素材（public/，列表在 `work_context`）：导入网址、base64（小文件）、本机模式下的服务器文件，`items` 一次导入多个，服务器模式不能从内网地址导入；查看图片、视频素材本身（多个拼成带编号的总览图，视频按时间点抽帧） |
| `upload_link` | AI 所在电脑上的文件：返回一次性上传地址（15 分钟、用一次），AI 用 curl 上传到作品 public/ 或素材库，文件不经过对话 |
| `materials_list` / `materials_link` / `materials_use` | 素材库：查看、关联或取消关联（也可新建）、锁定用到的文件版本并拿到 `materials/<库>/<文件>` 地址 |
| `material_read` / `material_write` | 读取素材库文件；修改素材库（`put` 放入网址、作品文件或文本内容，`edit` 精确修改文本，`move`、`delete`，一次可以多个操作），每次修改都是素材库的一个版本。素材库里的代码由作品 `import … from "@materials/<库>/<路径>"` 直接导入 |
| `layers_get` / `layers_edit` | visual.json 图层（读取时每层一行、省略默认值；`update` 嵌套对象逐项合并） |
| `audio_get` / `audio_edit` / `audio_place` | audio.json 混音（`update` 只改给出的字段；`audio_place` 返回片段 id） |
| `speech_voices` / `speech_synthesize` | 配音；`lines` + `place` + `subtitles` 一次生成整段旁白、排上音轨并写字幕 |
| `experience_read` / `experience_write` | 作品关联的经验库：照着做，过程中随时整理经验（`write` / `edit` / `delete` / `move`，一次可以改几篇；未保存状态） |
| `experience_link` / `experience_commit` | 关联、取消关联或新建经验库；把经验库的修改保存为版本（可选推送到 GitHub） |
| `subtitles_edit` | 字幕：整体替换、追加（替换重叠的旧字幕）、按时间段删除 |
| `versions_list` / `version_save` / `version_diff` / `version_restore` | 版本 |
| `export_video` / `task_status` | 导出 MP4（`wait` 秒数内等它完成）；完成时返回 1 小时有效的下载地址（`/api/downloads/<令牌>`，本机模式另给文件路径） |

工具设计约定（新增工具时遵守）：

- 返回给 AI 的文字要能直接行动：报错说明哪里错、应该怎么改；运行错误的位置是作品源码的 `文件:行:列`。
- 有自定义文字时，MCP 客户端只收到文字和 `meta`，收不到 `data`：AI 接下来要用的 id、地址都要写进文字；小数据（如 `sha256`）放在 `meta`。
- 参数结构很大时（`layers_edit`、`audio_edit` 的文档操作）用 `publicInput` 向客户端公布精简结构，详细格式写进 `docs/guide`，并用 `guide` 指向该主题；服务端仍按完整结构校验。
- 会覆盖或删除内容的工具标记 `destructive`。
- 制作作品时几乎每次都用到的工具加入 `CORE_TOOLS`（`server/tools/registry.mjs`），Claude Code 不用先搜索就能调用。
- 作品从 `ctx.scope.work` 或 `work` 参数得到（`workArg`）；限定作品的会话里 `work` 参数对 AI 隐藏，描述中不要要求传它。
- 内置 AI 自己读写了哪些需要跟踪的内容（目前是经验库文档），通过 `ctx.scope.session` 告诉 `services.ai`，下一条消息就不会再当作变化提醒它。
