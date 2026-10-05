# FRAME Studio 开发约定

这个仓库是 FRAME Studio 本身（平台代码）。用户的视频作品不在这里，而在数据目录（默认 `~/.frame-studio`）的 Git 仓库中，每个作品一个 `works/<id>` 分支。

## 目录

| 路径 | 内容 |
|---|---|
| `server/` | 单进程 Node 服务：HTTP API、WebSocket、Vite 预览、MCP、AI（ACP）、渲染导出、语音 |
| `server/tools/` | FRAME 工具注册表。MCP、CLI、内置 AI 共用；新增 AI 能力从这里加 |
| `server/ai/` | Claude Code / Codex 的 ACP 接入、账号登录、自定义 API、聊天会话 |
| `web/` | 工作台界面（React）：`workbench/` 布局与预览、`views/` 侧边栏、`chat/` AI 聊天、`settings/` |
| `src/engine/` | 作品运行引擎（播放器会话、合成、音频图、各框架适配）。作品通过 `../../src/engine/` 导入，属于公开接口 |
| `src/preview/` | 预览舞台页（stage）与无界面渲染页（render） |
| `bin/frame.mjs` | 命令行：serve、mcp、call、export… |
| `docs/guide/` | 作品制作指南，同时是 `frame_guide` 工具的内容 |
| `deploy/` | Dockerfile 与 compose |

架构说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 约定

- 中文界面与文档；代码注释用英文，简短说明“为什么”。
- 引擎（`src/engine`）是作品依赖的公开接口：改签名时同步更新 `docs/guide` 和受影响的作品；不保留旧格式兼容层，也不做格式升级功能。
- 新的 AI 能力优先做成 `server/tools/` 中的工具：参数用 zod 描述，返回 `{ text, data, images }`，描述写清楚何时使用。
- 服务端写入作品文件只能经过 `confined()`（禁止路径穿越），Git 操作经过 `server/git.mjs`。
- 依赖用 pnpm 管理，版本写死。运行时需要的包放 `dependencies`。
- 修改后运行 `pnpm check`（类型检查、测试、构建）。涉及界面时启动 `pnpm dev` 实际操作一遍。

## 本地调试

```bash
FRAME_HOME=/tmp/frame-dev FRAME_PORT=4311 pnpm dev
```

使用独立的 `FRAME_HOME` 避免影响自己的作品。AI 账号来自本机 `~/.claude`、`~/.codex`（或 `FRAME_AGENT_HOME`）。

## 协作与发布（用户已明确的规则）

- 直接在 `main` 分支开发，不新建工作树。开始前检查并保留已有的未提交修改。
- 按明确的文件清单暂存，检查 diff；不用 `git add .` / `git add -A`，不强推，不擅自 stash/reset/clean 他人的改动。
- 发布更新默认**不做**发布前备份（不导出数据、不归档作品/模型目录）。只有用户另行要求时才备份。涉及不可逆的数据迁移或删除时，先说明影响并确认。
- 发布只替换需要更新的容器；发布后做健康检查和功能验收。一次性任务用 `docker run --rm`，不写成常驻服务。
- 密钥和个人配置不入库；第三方素材保留来源与许可证。
