# 架构

FRAME Studio 是一个 Node 进程。它同时提供工作台界面、JSON API 与 WebSocket、编译作品的 Vite 开发服务器、MCP 端点，并管理 AI 代理进程和无界面浏览器。

```
浏览器 ─┬─ 工作台界面 (web/)  ──HTTP/WS──┐
        └─ 预览舞台 iframe (src/preview/stage) ─┤
                                              ▼
                                   server/ (单进程)
         ┌───────────┬─────────────┬─────────┴──────┬─────────────┬───────────┐
       works/repos  preview(Vite)  tools ─ MCP /mcp   ai (ACP)      render      speech
       Git 分支     编译作品+热更新   CLI / 内置 AI     Claude/Codex  Chromium    Edge/OpenAI/
                                                       代理进程      +ffmpeg     sherpa-onnx
```

## 数据目录（`FRAME_HOME`，默认 `~/.frame-studio`）

```
settings.json, secrets.json(0600)   设置与密钥（API Key、GitHub 令牌）
repos/<库>/                          作品库：裸 Git 仓库（local = 本地库，其余为 GitHub 克隆）
works/<库>/<作品>/                   作品工作目录 = works/<作品> 分支的 worktree
   projects/<名称>/                  作品文件（这才是作品内容）
   src → 引擎, node_modules → 依赖, docs → 文档     （链接，不提交）
   AGENTS.md, CLAUDE.md, tsconfig.json             （平台生成，不提交；AGENTS.md 是 AI 的会话说明）
   .materials/<素材库>/<路径>                        作品导入的素材库代码（@materials/…）在作品所用版本的副本（平台生成，不提交）
libraries/<库>/                      frame/materials 分支的 worktree：素材库（每个文件夹一个库；作品在 project.ts 的 materials 中引用，用到的文件版本锁定在作品的 materials.lock.json）
experience/<库>/                     frame/experience 分支的 worktree：经验库（每个文件夹一个库，作品在 project.ts 的 experiences 中关联）
exports/<库>/<作品>/                  导出的视频
models/speech/                       下载的语音模型
ai/sessions/                         AI 对话记录（JSONL）、图片、AI 上一轮结束时的作品文件快照
tmp/                                 导出快照、Vite 缓存
cache/covers/<库>/<作品>.webp|.json   首页封面（作品画面或封面图片的缩略图）及其来源版本
```

一个作品 = 一个分支，所以各作品的历史、推送、拉取互不影响。回收站也是分支名：移到回收站把 `works/<id>` 改名为 `trash/<id>`（本机和 GitHub 一起改，GitHub 上的改名是带 `--force-with-lease` 的原子推送）。「释放本地空间」删除已同步作品的本地分支和工作目录，再删除没有本地分支引用的 LFS 文件并 `git gc`。打开作品时检出到唯一的工作目录：编辑器、预览、AI、CLI、MCP 都读写这里的同一份文件。

## 模块（`server/`）

| 模块 | 作用 |
|---|---|
| `app.mjs` | HTTP 服务、路由分发、静态文件、`/files/<库>/<作品>/films/...` 素材服务、WebSocket 事件 |
| `config.mjs` `settings.mjs` | 环境变量、数据目录、设置与密钥 |
| `http.mjs` | 路由器、Range 文件发送、认证（本机免登录 / `FRAME_PASSWORD` / Bearer 令牌 / 内部令牌）、CSRF 与 DNS rebinding 防护 |
| `repos.mjs` `works.mjs` `git.mjs` `github.mjs` | 作品库与作品分支、版本、推送拉取、GitHub API |
| `project-meta.mjs` | 不执行代码地读取/修改 `project.ts` 字面量字段 |
| `documents.mjs` | `visual.json` / `audio.json` 的读取与原子编辑（UI 与 AI 共用） |
| `preview.mjs` | Vite 中间件；拦截作品文件的热更新，改为向舞台发送 `preview-update` |
| `render.mjs` | 无界面 Chromium：渲染帧、分镜、封面画面、响度分析、运行检查、MP4 导出（ffmpeg） |
| `remote-sync.mjs` | 连接 GitHub 的作品库自动同步：保存版本后在后台推送（作品、经验库、素材库分支）；打开作品、手动刷新和推送被拒时只取这个分支和 GitHub 对比，能快进就自动更新，否则广播 `remote-state`（`behind` / `diverged` / `conflict` / `error`），工作台和 AI 的每条消息都会提示；用户选择更新、合并、采用 GitHub 或保留本机；启动后和每半小时补推只领先于 GitHub 的分支 |
| `covers.mjs` | 首页封面：`project.ts` 的 `poster` 图片，或作品在 `posterTime`（不写时自动挑选）的画面。按作品文件的版本缓存；列出作品时在后台逐个重做过期的封面，完成后广播 `work-cover` |
| `checks.mjs` | 作品检查：元数据、TypeScript、素材引用、真实加载 |
| `tools/` | 工具注册表（zod 参数），MCP、CLI、内置 AI 共用 |
| `mcp.mjs` | `/mcp`（Streamable HTTP）与 `/api/tools` |
| `ai/` | ACP 客户端：代理进程池、会话、权限、登录、自定义 API |
| `speech/` | 语音引擎与模型下载 |
| `materials.mjs` `exports.mjs` `tasks.mjs` | 素材库（`/files/<库>/<作品>/materials/...` 按作品锁定的版本取文件：Git blob，LFS 内容按需下载；`@materials/...` 代码导入由 Vite 插件解析到作品根目录 `.materials/` 中的副本，锁定版本或素材库当前版本，锁定时沿导入关系一并锁定）、导出文件、后台任务 |

## 预览与热更新

舞台页 `/preview/stage.html` 在 iframe 中运行，只负责画面：通过 `/@fs/<作品>/project.ts` 动态导入作品，用 `createPlayerSession` 播放。工作台通过同源的 `window.__FRAME_STAGE__` 控制播放，舞台用 `postMessage` 回报状态。

保存作品文件时，Vite 的 `hotUpdate` 钩子使改动模块失效并打上时间戳，但阻止整页刷新；服务端合并 120 ms 内的改动后广播 `preview-update`。舞台带时间戳重新导入 `project.ts`，调用 `session.updateProject()` 原地替换场景和音频，播放位置保持不变。素材文件（`public/`）的改动由目录监听发现。

## AI

内置 AI 不自己实现代理，而是通过 ACP（Agent Client Protocol）驱动官方适配器：`@agentclientprotocol/claude-agent-acp`（Claude Agent SDK）和 `@agentclientprotocol/codex-acp`（Codex app-server）。

- 每个“AI 配置 + 模型”一个代理进程，多个会话共用；空闲 15 分钟退出，会话下次发送时通过 `session/resume` 恢复。
- 新会话的工作目录是作品目录，并注入 FRAME MCP（`/mcp`，带只对该作品有效的内部令牌）。代理自己的确认不经过 FRAME 工具（Claude 预先允许，Codex 不询问），由 FRAME 按会话当前模式决定：手动确认和计划模式下，会修改作品的工具先在聊天中请求用户确认（`confirmTool`）。
- 账号登录调用随依赖安装的 `claude` / `codex` 程序（`auth login`、`login --device-auth`），凭据在它们自己的目录（`~/.claude`、`~/.codex`；容器中为 `/data/home`）。
- 自定义 API：Anthropic 兼容接口通过 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` 交给 Claude Code；OpenAI 兼容接口通过 `CODEX_CONFIG` 中的自定义 model provider 交给 Codex。
- 上下文（`ai/context.mjs`）：开始或恢复会话时重新生成作品根目录的 `AGENTS.md`（平台规则、作品需求、关联的经验库，`works.briefProviders` 提供）；每条消息附加 `[FRAME]`，只写 AI 还不知道的：播放位置与选中对象、上一轮之后被改动的作品文件、别人对经验库的修改。会话元数据中的 `context` 记录 AI 已知的经验库文档哈希；MCP 内部令牌带会话 id，工具读写经验库时据此更新。
- 分支（`fork`）：复制到分支点为止的对话记录，并用 ACP `session/fork`（`_meta.jetbrains.air.fork.messageId` 指定分叉点）分叉代理的上下文；会话元数据 `branch` 记录来源和保留的轮数，界面据此显示同一处的多个版本。
- 对话记录保存为原始 ACP 更新的 JSONL，界面把它还原为消息、工具卡片、差异和计划。版本只由用户手动保存（活动栏的版本图标显示未保存的改动数）。

## 导出

导出时先把作品目录复制为快照（之后的编辑不影响导出），用无界面 Chromium 打开 `/preview/render.html` 逐帧截图，音频由 `OfflineAudioContext` 分段渲染为 PCM，一起送入 ffmpeg 编码为 H.264 + AAC 的 MP4。浏览器：`FRAME_BROWSER` → playwright 浏览器 → 系统 Chrome/Chromium；ffmpeg：`FFMPEG_PATH` → 系统 ffmpeg → `ffmpeg-static`。

## 安全边界

- 只监听本机地址时无需登录，但拒绝非本机 Host 头和跨站写请求；监听其他地址必须设置 `FRAME_PASSWORD`。
- 外部 MCP 使用在设置中创建的令牌（可只读）；内部令牌只用于 AI 会话和渲染，且限定作品。
- 所有作品路径经 `confined()` 检查，拒绝路径穿越和指向目录外的链接。作品代码只在浏览器中运行，服务端不执行作品代码。
- AI 代理在作品目录中拥有其自身的文件与命令权限（与在终端中运行 Claude Code / Codex 相同）。
