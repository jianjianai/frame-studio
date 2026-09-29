# Frame MCP / CLI 全流程体验与修复记录

## 范围与隔离

请求：实际使用 Frame MCP 工具，从体验发现问题，在 ovh-docker 的 Frame 项目新建工作区完善 MCP / CLI。

工作树：`/home/agentdock/AgentDock/frame-studio-mcp-cli`。分支：`feat/mcp-cli-experience-20260930`。起点：main `650fa341cc4e1670afd3a51031e0ec25da38a1e0`。创建时主工作树还有另一项同步/版本管理的未提交修改，本任务没有挪用或修改这些内容。

连接的生产 MCP 自报版本为 4.2.0；本分支源代码基线为 V5。线上工具用于复现旧体验，修复后的协议通过独立 PostgreSQL、真实 HTTP、真实 MCP JSON-RPC 和 CLI 子进程验证，不能把隔离验收说成生产已升级。

QA 独立容器：`frame-mcp-cli-dev`、`frame-mcp-cli-pg`；独立网络：`frame-mcp-cli-qa`；数据库：`frame_test_mcp_cli`。普通 QA 容器没有挂载生产数据库、生产目录或 Docker socket。依赖按现有 lockfile 安装，没有新增依赖。补充执行器验收使用单独的一次性 runner，只挂载本工作树与执行器所需 Docker socket；模拟接口端口仅绑定 Docker 网桥地址，不监听宿主机公网地址。

## 实际线上体验

| 流程         | 实际动作与结果                                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 导航与接手   | 调用仓库分页、作品列表、现有作品上下文。上下文混入大量历次构建的 `result.input.files`，并重复返回文件 SHA；指引使用未公开的旧 `project_*` 工具名。                            |
| 安全试验作品 | 新建 `MCP CLI 体验临时作品 20260930`，UUID `a786450b-e167-4c27-8e96-bf6efb073055`，独立分支 `works/work-a786450b`，1.2 秒 canvas 模板。未改原有作品。                         |
| 文件与冲突   | 列文件、读取 `scene.ts`、新增体验记录。再次以 `expectedSha256:null` 创建同名文件正确拒绝。读取缺失记录却回显了 `/data/works/...` 内部路径。                                   |
| 单帧         | 任务 `3759be8e-799a-4b69-bf64-8d85f071a723` 成功，0.5 秒、640×360 PNG，实际通过 MCP 图像内容查看了画面。                                                                      |
| 浏览器       | 取得私有 AI 审片页并打开。实际点击启用声音/播放、暂停、1.5×倍速、进度键盘调整、下一帧、隐藏时间轴。页面/网络/控制台错误列表均为空。仅验证交互，不把静音模板说成完成听感审核。 |
| MP4          | 任务 `3ccb22c8-781f-4a5a-a80e-28f0aa295aae` 成功：640×360、30 FPS、1.2 秒、36 帧，产出 MP4 和渲染报告。该线上模板没有音轨。                                                   |
| 分镜图       | 任务 `c99e2ac4-e920-4f85-8c52-e16cc0e8a9f5` 成功；实际查看 MCP 返回的首帧/末帧拼图与帧号。                                                                                    |
| 版本恢复     | 保存版本 `a9eb24985f574cee61211eb8133534f1322a5ad5`，修改记录后恢复。再次读取 SHA 为 `8a4fe2b82ab44ed2fcbb899d0e85bff0d4f3e78e1aa26d569ff7b050fa49afc8`，与恢复前基线一致。   |
| 同步状态     | 读取当前作品分支状态，未执行 fetch/pull/push；远端尚无该临时分支。                                                                                                            |
| 语音发现     | 列出内置引擎、声线和模型，就绪状态可读。调用一次内置 Kokoro 试听后，连接器在当前对话只提供了零行结果，无法确认这里的音频回传和主观听感。这个边界保留，不计作已听验收。        |
| 清理         | 仅把上述临时作品移入可恢复回收站，返回 `deleted:true`。没有永久删除内容或推送试验分支。关闭本任务创建的浏览器会话；临时试听按服务原有 24 小时策略到期。                       |

## 修改前后的问题对应

1. **难接手、查参数要翻代码**：增加 `workspace_context` 和 `tool_describe`；CLI 支持 `actions` / `describe`。实际集成测试还发现“只列最近打开”漏掉新作品，已改为显示最新作品概览。
2. **上下文和任务结果过大**：作品上下文默认为 5 条任务摘要，移除构建清单；显式任务分页和紧凑状态保留完整诊断入口。README、作品 AGENTS 和 brief 有界返回，并带截取标记。
3. **局部编辑必须重传全文**：新增目录分页、字面搜索、显式行段读取、带 SHA 的精确补丁和源码删除。补丁按匹配数校验、支持无副作用预演、原子替换单文件；删除保护作品身份文件。
4. **错误缺乏恢复步骤**：缺失/二进制/无效 UTF-8/超大文件/过期产物/上传丢失都有明确错误。默认不把内部绝对路径当作用户提示。
5. **等待和结果读取割裂**：增加 `task_status`，返回 lossless 字符串游标、`hasMore`、终态和后续动作。CLI 等待会读完最终事件页，支持超时/中断；结果保存失败提示重试发布，不重跑 AI。
6. **CLI 预览只给编译任务**：`works_browser --wait` 会接着获取最终预览 URL；已就绪不重复构建，首次强制构建参数不在轮询中重放。
7. **缺少可靠的素材传输流程**：CLI 流式上传、分块恢复和产物下载；新增上传状态与未完成上传清理。begin 支持请求 UUID 去重，完成结果可重取，文件改变或偏移冲突不会继续盲传。
8. **重复分块的边界错误**：拒绝跨越当前末尾的重叠块，避免未写入的零字节被误判为重复块；严格校验非空 canonical base64。
9. **MCP 成功/错误输出不便机器处理**：保留原文本/图像/音频，加上结构化元数据和保守副作用注解；数组文字形状不变，图像 base64 不重复放入 JSON。
10. **旧脚本兼容风险**：不带行段参数的 `works_read` 仍返回完整文件；700 行样本回归验证旧行为。旧列表、任务和诊断接口保留，新增接口按需选择。

## 隔离后的实测覆盖

新增测试文件：

- `tests/server/agent-toolkit.test.mjs`：字节 SHA、BOM/CRLF、读取分页、搜索续查预算、文件路径/链接边界、补丁预演/冲突/原子写、外部修改保护、完整读取兼容、身份文件删除保护。
- `tests/server/platform-cli.test.mjs`：离线帮助、JSON/@file/stdin、令牌/重定向/HTML 错误边界、长事件 ID、终态事件分页、退出码、无自动写重试、下载损坏/并发覆盖保护、分块应答丢失恢复、预览等待。
- `tests/server/agent-toolkit-integration.test.mjs`：真实 PostgreSQL + HTTP 服务 + MCP JSON-RPC + CLI 子进程互通；上传登记/引用/清理、任务去重/忙碌写保护/取消、源码补丁/删除/版本恢复/回收站、结构化 PNG 与过期产物。

新增测试集合：**28 项检查全部通过，0 失败、0 跳过**。其中集成测试的“大构建清单与 PNG 下载”使用明确构造的持久化任务结果夹具，不冒充执行器渲染；真实渲染在上述线上任务、本地 CLI 冒烟和原有 MCP 浏览器测试中覆盖。

另建完全隔离的本地工程，实际执行 14 次 `film` 命令：doctor、list、inspect、context、check --strict、read、search、patch 预演、patch 应用、frame、storyboard、render、verify、playback。全部退出 0。实测短片为 **1 秒、320×180、12 帧 H.264 + AAC 音轨**，FFprobe 双流校验通过；实际打开生成 PNG 检查了修改后画面。临时工程已删除，仅保留审计日志和小型产物。

日志和本地样本（忽略目录，不随 Git 提交）：

- `.cache/mcp-cli-qa/final-toolkit-tests.log`
- `.cache/mcp-cli-qa/local-cli-smoke.log`
- `.cache/mcp-cli-qa/local-smoke/commands.json`
- `.cache/mcp-cli-qa/local-smoke/ffprobe.json`
- `.cache/mcp-cli-qa/local-smoke/cli-frame.png`
- `.cache/mcp-cli-qa/local-smoke/cli-film.mp4`

第一次核心验收遇到测试容器数字 UID 没有可写 HOME，Chromium crashpad 启动失败。为本任务设置独立可写 HOME/XDG 目录后，重新执行通过；没有删测试、降级断言或用生产环境绕过问题。

## 最终全量验收与交付

代码提交：`372a9056a0238fd5f52f6dffd1ce536058d70abb`，`feat(mcp): complete discoverable authoring and resilient CLI workflows`。

最终命令：`pnpm verify`；退出码 **0**；独立测试库，完整日志 `.cache/mcp-cli-qa/verify-final.log`。

| 验收                                                   | 结果                                                                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| 工程检查、平台语法/相对导入、TypeScript 与平台类型检查 | 通过                                                                   |
| Vitest                                                 | 9 个测试文件，74 通过，0 失败                                          |
| MCP                                                    | 68 通过，0 失败，1 个可选音色库测试跳过                                |
| 播放器和工作台生产构建                                 | 均通过                                                                 |
| 服务端/真实浏览器                                      | 122 通过，0 失败；起初跳过 3 个 Docker 执行器测试与 1 个可选音色库测试 |
| 补充 Docker 执行器                                     | 下面的 3 项随后全部补跑通过，0 跳过                                    |

补充执行器使用 `deploy/Dockerfile` 从代码提交 `372a905` 构建隔离候选镜像 `frame-studio:mcp-cli-qa`。镜像构建成功，**没有上传镜像仓库或部署生产**。设置 `FRAME_TEST_EXECUTOR=1`、独立测试库、准确的 `FRAME_TEST_HOST_ROOT` 后，执行 `node --test --test-concurrency=1 --test-reporter=tap tests/server/executor-durable.test.mjs`，3 项全部通过：

- 真实 Codex CLI + 确定性模拟模型：完成编辑、验证和预览发布，控制服务重启后仍恢复任务；2 次模型请求，10 条事件。
- 真实 Claude CLI + 确定性模拟模型：相同耐久性和发布检查通过；2 次模型请求，12 条事件。
- 真实 Codex 越界修改：在应用或发布之前拒绝，用户作品未被越界产物覆盖。

这里使用的是候选镜像内真正的 CLI 进程，不是模拟 CLI；模型 API 为完全隔离的测试应答，不消费真实模型账号。构建和执行日志分别在 `.cache/mcp-cli-qa/candidate-build.log`、`.cache/mcp-cli-qa/executor-final.log`。一次性执行器 runner 和子任务容器由测试清理。

综合普通验收和补测，只有 **2 个依赖未配置的 GeneralUser 音色库的可选用例** 没有运行；其他上述用例均实际执行。未把缺少可选库的用例删除、改为强制通过，也没有把这组结果表述为已完成生产发布。

发布边界：本任务不修改生产部署，不自动合并 main，不进行 GitHub 推送；需要审核合并和按发布门禁部署后，新工具才会出现在当前生产 MCP 连接。没有借体验测试调用收费模型、修改现有模型/引擎配置、永久清理素材或执行用户仓库同步推送。生产连接中的语音试听展示仍需在部署后单独确认。

稳定操作文档：`docs/PLATFORM-TOOLS.md`，已从 README 和作品平台文档链接。
