# AI 能力发现分支合并审核 · 2026-10-01

## 结论

值得合并。审核固定提交 `8182053cd6c868de7c228d23b124bc867b4f532a`（`feat/ai-capability-discovery-20261001`），基线及合并前远端 main 均为 `76e689c4c12f12cd040758f11d31664931955ed7`。两路独立只读审查分别检查实现、运行时接口与作者文档，未发现阻塞缺陷。完整维护校验通过后，将该提交和下述措辞修正合入 main。

## 合并价值与边界

- 统一 CLI、本地/平台 MCP 和任务内 Agent 的能力目录、过滤参数及严格 schema；创建前即可只读发现，无需项目或凭据。
- 29 项能力覆盖视觉、媒体、动画和音频；默认仍为空白 composition，不预选艺术风格或 2D/3D 引擎。
- 接手提示区分 Remotion React 根、Canvas 文档与 FrameScene 接入；明确 audio.json 的混音权威，避免 AI 修改已失效的旧字段。
- 素材结果明确 MIDI/SF2、模型、字体、JSON/Lottie 和文件媒体的下一步接入方式；导入素材不会自动启用播放。
- 音频引擎/处理器元数据抽为纯模块，保持原有内容和顺序，并核对实际处理器 schema。
- 新测试覆盖跨入口目录/schema 一致性、严格参数、只读接手，以及素材和 Remotion 权威边界。分支不修改依赖锁文件、数据库结构或版本号。

## 审核修正

`templates/engineering.md` 将“未声明音频文档的旧工程才使用”改为“未声明音频文档的工程使用”。新建的 `--audio generated` 工程同样可以使用 audioTracks/loadAudio，原句过于绝对。该修正已包含在完整验证输入中。

## 新鲜验证

对固定提交的 git archive 加上述措辞修正执行原样 `pnpm verify`，退出码 **0**，没有降低断言或跳过命令。

| 检查 | 结果 |
| --- | --- |
| 项目检查、平台语法检查 | 通过 |
| 应用及平台 TypeScript 检查 | 均通过 |
| 单元测试 | 13 个文件，111 通过 |
| MCP 测试 | 120 项，119 通过，1 条件跳过，0 失败 |
| 应用与 Studio 构建 | 均通过 |
| 服务端测试 | 294 项，288 通过，6 条件跳过，0 失败 |

共 **518 通过、7 条件跳过、0 失败**。跳过项为采样音色浏览器测试、GeneralUser 音色库测试、Windows 本地模式，以及四项真实 CLI/Docker 执行器测试；这些场景未由本次环境验证。

验证使用固定工具镜像 `sha256:43b5807e9a4db3f1265512f3f95df171091b774641acc1df495dc4cd42148470`，Node 24.21.0 / pnpm 12.4.2。主仓库依赖只读挂载，Vite 缓存独立 tmpfs；独立 PostgreSQL 18 数据库、内部网络及端口 59267，无生产挂载和 Docker socket。运行结束后本任务容器与网络均已清理。

结束后逐一比对 archive 中的 763 个普通文件，验证源码与固定提交加上述修正一致。完整日志位于 OVH 主机 `/opt/frame-ai-capability-review-20261001/verify.log`，SHA-256 为 `870395f5b872f1774fce9c9fd4b2ab266a0c2b7aa976444af080df59fcb4b52c`。

首轮误挂载空工作树依赖，检查未能启动；第二轮因只读依赖目录缺少可写 Vite 缓存挂载而失败。修正验证环境后重新执行完整命令得到上述结果；两次环境失败日志保留在同目录，不计为通过。

## 清理范围

仅清理 `/home/agentdock/AgentDock/frame-studio-ai-capabilities` 及 `feat/ai-capability-discovery-20261001`。删除前要求：main 已推送并包含固定审核提交，目标 HEAD 未变且工作树干净；使用普通 `git worktree remove` 和 `git branch -d`，不强制删除。合并前核对远端不存在同名分支。

保留 `frame-studio-live-preview-v8` / `feat/live-preview-v8` 和其他任务资源。本任务执行审核、合并和目标清理，不发布生产。
