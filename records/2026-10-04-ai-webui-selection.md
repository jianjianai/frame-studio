# AI Web UI 替代方案评估

## 范围与运行环境

- 用户要求重新选型：优先热门 GitHub 项目，同时支持真正的 Codex CLI 和 Claude Code；可接受两个独立 UI 作为备选。
- 目标继续保持全平台共享服务、作品页默认当前作品、原生 UI 与 CLI 配置、AI UI 可独立于 FRAME 升级。FRAME 不再维护另一套提供商、密钥、模型和账号登录表单。
- 当前机器就是生产 Docker 所在主机，后续直接使用本机命令，不调用 ovh-docker 插件。
- 评估基线为 `main` / `23b25c6874bfb13cbb04ff95ed13962e09bc56ec`，开始时工作区干净。生产 FRAME 为 8.3.2。
- 本记录只记录选型证据和待解决问题，不代表替代集成已经实现或生产已经切换。

## 选型结论

首选 **T3 Code v0.0.45**，HAPI 为轻量备选。目前已有一个同时支持两种真实 CLI 的合适项目，无需先接入两个产品。

用户已确认体验：**作品侧栏专注当前作品聊天，独立页面保留完整原生工作台**。选择 T3 的依据是实际 CLI 支持、已有项目模型、原生配置、独立 headless 服务及活跃度的组合，性能仍须通过候选运行验收，不能由源码设计直接推断真实资源占用。

计划采用全平台一个 T3 UI/服务；各会话仍可有自己的 Codex app-server 或 Claude 进程。这不等于所有项目共用同一个 Agent 进程。FRAME 只适配作品导航、实际画面/素材引用与已有作品工具，不重写会话引擎或原生设置。

## 已核实候选

数据核查日期：2026-10-04。Star 为查询时的快照，不作为稳定性或接入成本的保证。技术判断基于官方仓库与源码，不以支持同一家模型 API 代替支持其 CLI。

| 项目 | GitHub 热度 | 实际执行方式 | 对 FRAME 的判断 |
| --- | ---: | --- | --- |
| [T3 Code](https://github.com/pingdotgg/t3code) | 约 24.7k | Codex app-server；Claude Agent SDK；独立 `t3 serve` Web 服务 | 首选；已有目录可以直接使用，默认当前作品聊天仍需小入口适配 |
| [HAPI](https://github.com/tiann/hapi) | 5,175 | 原生 CLI 包装；Codex app-server；共享 Hub 与 Runner | 轻量备选，稳定 v0.30.7 支持审批、提问、中断与恢复；当前作品范围需要导航适配 |
| [Happy](https://github.com/slopus/happy) | 24,004 | 原生 CLI 包装，Codex app-server | 真正支持两种 CLI；自托管可行，但额外身份、E2EE 配对与默认目录适配增加 FRAME 接入成本 |
| [CloudCLI](https://github.com/siteboon/claudecodeui) | 13,930 | Claude Agent SDK；Codex SDK 的 exec/runStreamed | 支持两种 CLI，但目前 Codex 聊天的交互审批有缺口，不能按完整 app-server UI 评价 |
| [AionUi](https://github.com/iOfficeAI/AionUi) | 33,304 | 多种 CLI/Agent 集成，另有无 Electron 的 Web 主机 | 存在 headless 方案；当前 Docker 构建入口与重构后的脚本不一致，需要额外修复 |
| [pi-web](https://github.com/agegr/pi-web) | 7,046 | Pi coding agent 的 createAgentSessionFromServices | 界面方向可参考，但不是 Codex CLI / Claude Code CLI 的直接 UI |

### CloudCLI 的具体边界

核查提交：`dc7cb6c6dcd22988f3241e10303298046ead351e`。

- `server/modules/providers/list/codex/codex-runtime.provider.ts` 明确记录 exec 无法进行交互式审批；`codex-app-server.client.ts` 主要补 SDK 未提供的 thread/fork 等操作，不能据此声称聊天已有完整 app-server 交互。
- 外部 `/api/agent` 路线为 Claude/Codex 固定使用 bypassPermissions，不能当作保留原生审批语义的 FRAME 发送接口。
- 插件公开契约提供 tab、项目/会话上下文与 RPC，但明确不允许操作聊天系统。FRAME 画面/素材引用与发送边界不能仅靠该插件契约接入。
- 项目同步使用固定的 `~/.codex` / `~/.claude`，自定义原生 home 的支持需要进一步改动。
- 项目查询有 SQLite 分页和 watcher 增量，但完整 `/api/projects` 刷新仍重新扫描 provider 会话；部分会话标题提取读取整个 JSONL。不能把分页列表与底层扫描成本混为一谈。

来源：[Codex runtime](https://github.com/siteboon/claudecodeui/blob/dc7cb6c6dcd22988f3241e10303298046ead351e/server/modules/providers/list/codex/codex-runtime.provider.ts)、[插件契约](https://github.com/cloudcli-ai/cloudcli-plugin-starter#constraints)。

### T3 Code 的已确认能力

稳定发行：[v0.0.45](https://github.com/pingdotgg/t3code/releases/tag/v0.0.45)，2026-10-02。官方说明仍将项目视为早期软件，不能把热度或版本发布等同于 FRAME 生产验收。

- Linux 可通过 `t3 serve` 启动独立 Web 服务，不要求 Electron、手机 App 或云服务。
- Codex 支持现有 CLI 登录及 `CODEX_HOME`；Claude 支持现有登录、`CLAUDE_CONFIG_DIR` 与原生配置。设置和认证属于运行 Agent 的机器。
- 原生设置可管理提供商实例、模型和 CLI 路径，适合替换 FRAME 重复的配置表单。
- 原生权限、问题回答、恢复和停止有明确 UI 与协议语义；可以沿用用户选择的权限模式，不增加 FRAME 的额外审批流程。
- 原生 RPC 提供独立 shell/thread 订阅；查看一个对话不需要加载所有对话的完整历史。命令接受回执与后续执行结果分离，持久状态提交后才发布事件。
- 服务及 CLI 有独立升级入口；Docker 接入应使用独立镜像和持久目录，而不是再次打包进 FRAME 运行时。
- 项目可由现成 `t3 project add <path> --title ...` 注册；正在运行时使用原生服务命令，不需要 FRAME 写 T3 的 SQLite。会话目录解析为 `thread.worktreePath ?? project.workspaceRoot`，`defaultThreadEnvMode` 默认 `local`，无需额外 worktree。
- 原生默认按 Git repository 分组。同一远端仓库的多个 FRAME 作品目录可能被合并展示；现成 `separate` 分组按 environment 与规范化 cwd 区分，接入必须使用该模式或对应作品覆盖，不能用 Git remote 代替作品身份。
- `/projects/:projectKey` 是项目设置入口；`/` 默认恢复最近项目草稿。作品页默认当前作品的聊天以及紧凑侧栏布局仍需要明确的入口适配，不是现成 iframe 参数。
- HTTP 服务和浏览器 cookie 本身不强制 TLS；同源 primary 使用 browser-session-cookie，不要求云连接的 DPoP。主 UI 没有阻止 iframe 的全局 X-Frame-Options / frame-ancestors；Codex 登录 callback 页单独禁止嵌入，应在原生独立窗口完成。普通非 localhost HTTP 的 UUID/附件等交互仍须真实候选验收。
- Web 的 BrowserHistory 没有子路径 basename，原生 API target 按 origin 根路径解析，HTML 有绝对资源路径。同源 `/ai/` 部署需要集中适配 router、资源、API 与 WebSocket；单纯 HTML 替换或增加 Vite asset base 不能代表完整子路径支持。
- 本机生产只读版本检查得到 Node `v24.21.0`、Codex CLI `0.158.0`、Claude Code `2.1.283`。尚未运行 T3 候选，也未执行真实账号推理或 UI 验收。

来源：[安装说明](https://github.com/pingdotgg/t3code/blob/v0.0.45/docs/user/install.md)、[Codex 配置](https://github.com/pingdotgg/t3code/blob/v0.0.45/docs/user/providers-codex.md)、[Claude 配置](https://github.com/pingdotgg/t3code/blob/v0.0.45/docs/user/providers-claude.md)、[架构](https://github.com/pingdotgg/t3code/blob/v0.0.45/docs/internals/overview.md)、[升级说明](https://github.com/pingdotgg/t3code/blob/v0.0.45/docs/user/updating.md)。

具体代码证据：[Codex 执行](https://github.com/pingdotgg/t3code/blob/v0.0.45/apps/server/src/provider/Layers/CodexSessionRuntime.ts)、[Claude 执行](https://github.com/pingdotgg/t3code/blob/v0.0.45/apps/server/src/provider/Layers/ClaudeAdapter.ts)、[目录解析](https://github.com/pingdotgg/t3code/blob/v0.0.45/apps/server/src/checkpointing/Utils.ts)、[项目命令](https://github.com/pingdotgg/t3code/blob/v0.0.45/apps/server/src/cli/project.ts)、[默认 workspace](https://github.com/pingdotgg/t3code/blob/v0.0.45/packages/contracts/src/t3ProjectFile.ts)、[项目分组](https://github.com/pingdotgg/t3code/blob/v0.0.45/packages/client-runtime/src/state/projectGrouping.ts)。

可复用原生 HTTP/RPC：`GET /api/orchestration/shell`、分页的 `GET /api/orchestration/threads/:threadId`、`POST /api/orchestration/dispatch`，以及 `orchestration.subscribeShell` / `subscribeThread` 的 sequence 恢复。FRAME 不应直接写 T3 数据库。[HTTP 合约](https://github.com/pingdotgg/t3code/blob/v0.0.45/packages/contracts/src/environmentHttp.ts)、[RPC 合约](https://github.com/pingdotgg/t3code/blob/v0.0.45/packages/contracts/src/orchestration.ts)。

## 现有实现问题登记

这些是本次需求直接涉及的结构问题，未在选型阶段擅自修改生产或删除旧数据。

1. `server/paseo-manager.mjs` 与当前部署按作品启动 daemon、保存 home/control；与用户要求的全平台共享服务不一致。
2. `server/connections.mjs`、FRAME 模型设置和 Paseo profile 同步共同形成第二套配置权威；与用户已选择的原生 UI/CLI 配置不一致。
3. `deploy/Dockerfile` 将 Paseo server/Web UI 构建进 FRAME 镜像；原生服务升级会迫使 FRAME 一起构建和发布。
4. `scripts/runtime-identity.mjs` 包含 Paseo 集成源码，原生 UI 变化被耦合到 FRAME 的创作运行时身份。
5. 当前 `docs/AI-WORKBENCH.md`、`docs/PASEO.md` 中的按作品 daemon 与 FRAME 提供商配置说明已被这次用户需求取代；应随最终实现修改，不能继续当作新方案约束。
6. `docs/OVH-DEVELOPMENT.md` 的旧远端路径/操作方式与当前环境不一致。本次直接在本机执行；该独立文档整理尚未实施。
7. `atomicPaseoJson()` 只在 `finally` 关闭 handle；写入、sync 或 rename 失败不会删除本次 `.tmp`。这是独立的失败路径清理优化点，本次仅登记，不修改旧实现。
8. `observeBinding()` 每次把新的 `checkedAt` 写入 `nativeSummary` 与 `lastObserved`；`updateRuntime()` 无变化比较，每次更新 `updated`，绑定表的 AFTER UPDATE 触发器发布 `frame_changes`。即使实际运行状态不变也会写数据库并刷新订阅。替代服务的状态观察应使用共享订阅、按业务变化更新，避免把每个作品的心跳变成全局通知；旧实现的独立优化本次未执行。

## 接入验收边界

任何候选都不是 FRAME 现成插件；原生支持与需要开发的适配应分开验收。

- 全平台一个 UI 服务，作品/对话由原生项目与会话身份绑定。
- 打开作品默认显示该作品的会话；新建、恢复、引用、停止都校验同一个作品目录。
- 直接编辑已有 canonical 工作区，不另建 AI 草稿或默认 worktree。
- 复用已有作品工具、实时预览与 revision 验证；保留画面/素材引用的真实显示版本与发送回执语义。
- 保留原生会话和旧配置资料，不能编造通用跨产品会话迁移。涉及删除或不可逆迁移时另行明确影响。
- AI UI 服务单独升级；FRAME、UI 服务和 Codex/Claude CLI 各自有明确版本与兼容检查。升级前检查活动会话。
- 不新加 TLS、域名白名单或云账号配置要求；沿用当前 FRAME 访问入口。
- 正式切换必须完成候选构建、项目范围/恢复/停止/引用测试及上线后真实验收；不自动做发布前大备份。

## 资源清理

已停止尚未实施的 Paseo 共享服务工作。仅清理本次代理创建的 `.cache/paseo-shared-service-64c17dad-1915-46a8-90e6-ff12cddf6d69` 与对应路径文件；未清理其他缓存、生产容器、作品数据或旧镜像。

本阶段只新增本记录，没有运行代码修改，因此没有运行 FRAME 发布测试。只读源码、正式发行与链接检查构成选型依据，不代替上述接入验收。
