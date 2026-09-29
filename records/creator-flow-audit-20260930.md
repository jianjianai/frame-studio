# Frame：创作 AI 全流程审查与修复

日期：2026-09-30（中国时区）。基线：`650fa34`。分支：`feat/creator-flow-20260930`。
工作树：`/home/agentdock/AgentDock/frame-studio-creator-flow`。

## 结论

底层能力已经比较完整，主要问题不是再缺一个渲染器，而是任务内的发现、定位、验证、恢复与交付没有形成清楚的工作流程。已修复两个可直接阻断任务的缺陷：任务主动构建预览后被 progress.json 误判越界，以及平台仓库的 /projects/ 忽略规则令独立作品副本创建失败。其余修改集中在减少工具摸索、重复配置和误判，不改创作风格、不重写引擎、不覆盖其他 AI 的分支。

最终公共检查状态：`pnpm verify` 退出码 0。单元测试 74 项通过；MCP 68 项通过、1 项跳过；服务端 107 项通过、4 项跳过。全部已执行测试零失败；服务端结果包含本次新增的 13 项回归。类型检查、平台检查、播放器构建与 Studio 构建均通过。真实成片流程和冻结依赖的真实执行器额外验收均退出 0。

## 按 AI 的真实操作顺序审查

| 环节 | 原有状况 / 发现 | 处理与验证 |
| --- | --- | --- |
| 接手作品 | 通用 film context 不等于本次任务上下文，AI 仍需自行拼接位置、入口和版本 | 新增 work-tool context：入口、有限文件索引、音轨、镜头、选段、版本引用、诊断和下一步命令 |
| 损坏工程 | 元数据或素材目录坏了时，最需要上下文却可能先得到异常 | 新上下文保持只读，坏元数据/坏素材 JSON 仍返回修复入口和具体诊断；回归覆盖 |
| 旧预览定位 | 旧版本时间码不能直接当作当前版本位置 | 保留只读引用路径，标记 requires_comparison；采样检查要求显式映射到当前 start，不自动回退源码 |
| 创建独立副本 | /projects/ 被平台仓库忽略，git add 直接失败；基线还遗漏部分根配置 | 只解开选定作品目录，补齐 .npmrc / pnpm-workspace.yaml；不 force-add 整个工程，.env 继续不入库 |
| 查看与修改源码 | 已有 read/search/patch、哈希检查、预演与检查点 | 保留并在任务指南内给出顺序；真实工程跑补丁预演、提交、旧哈希拒写和恢复 |
| 任务内预览 | build 写出 /workspace/progress.json，最终 scope 将其当成越界修改 | 仅忽略任务根的 progress.json / .tmp；任意 unexpected.txt 仍拒绝，作品内同名文件仍可被 Git 追踪 |
| 工程检查 | 能力分散，大报告和完整输入清单不适合每次塞进 AI 上下文 | 新增 work-tool check 编排已有结构、类型、单元测试；输出摘要，完整证据存本作品独立 exports 目录 |
| 实时运行 | 正播、暂停、冷跳、倒跳、变速已有实现 | runtime:true 增加短段 playback 和三时间点分镜，复用既有执行器，不另造渲染逻辑 |
| 浏览器测试 | 脚手架推荐根 Playwright project 名称，实际任务副本不一定带根配置 | 改为已有的 film test-e2e；不带根 Playwright 配置的真实验收副本运行通过 |
| 素材发现 | task assets 丢弃 limit/offset，翻不到默认第一页之外 | 保留搜索和分页，约束 1..200，固定当前任务仓库；越权改 repo 无效；非法参数拒绝 |
| 素材接入 | 得到文件并不代表场景或音轨已经引用 | use/speech 保留旧返回字段，增加类型、名称、大小、来源和接入提示；不擅自改画面或字幕 |
| 语音 | 平台已有内置语音，但脚手架先引导另配独立 Edge | 平台任务优先 engines / engine_test / speech；独立 CLI 路线仍保留；没有调用付费语音服务 |
| 多轨与字幕 | 生成音轨、文件音轨、审片分轨和 SRT 已有实现 | 12 秒工程使用 4 音轨和 3 段中文字幕；验证文件音效起止、未到时音轨静音、字幕相对时间 |
| 异常与重试 | 原工具输出裸响应或堆栈，无显式截止时间；写操作结果不确定 | JSON 错误码与 nextAction、180 秒截止、2 MiB 响应预算、拒绝重定向、不自动重放写操作；任务密钥与请求中的密钥脱敏 |
| 审片与交付 | 工具成功不代表作品已被看过、听过，也不代表已有正式 MP4 | 明确区分工程/运行/媒体/视觉/听觉；真实 review、分段 export、verify，未执行的内容检查保留 not_run |
| 取消与恢复 | 项目已有任务取消、重启接续、发布恢复和逆向撤销 | 运行既有 MCP/server 回归；远端 HTTP 超时明确不是服务端取消确认，要求先查询状态避免重复生成 |

## 实际复现和修复

### 1. 主动预览反而令任务失败

使用真实 `previewProgress()` 在临时 Git 基线内写入进度，再调用 `inspectProjectScope()`，修复前得到 `outside_changes`，唯一外部路径是 `progress.json`。证据：`.cache/creator-flow/progress.before.json`。

修复不放宽项目边界：仅在执行器拥有的根文件清单中新增两项，并改为根锚定规则。回归证明根部 unexpected.txt 依然失败、projects/test-film/progress.json 依然记为作品变化。

额外用真实 Docker 执行器验证：脚本化代理先修改作品、读取上下文、构建预览，再做 runtime check；之后执行器自动 scope、structure、project-tests 阶段及 preview-build 均成功。这里 project-tests 命令返回无作品单测的 not_run，不把它描述成有业务单测通过。脚本化代理不是在线 Codex/Claude 模型，也没有付费调用。

### 2. 独立作品副本不能创建

把真实平台 .gitignore 放入测试工程，`createProjectWorkspace` 直接报 `The following paths are ignored ... projects`。证据：`.cache/creator-flow/workspace.before.json`。修复后的副本只追踪目标作品，独立修改不触及源作品，Git scope 干净，私有 .env 不在 Git 基线中。

### 3. 工具失败必须提供恢复路径

真实本地 HTTP 服务回归覆盖：503 与 Retry-After、非 JSON 的 502、302 重定向、超大响应、真实截止超时和正常读请求。没有自动重复提交 speech。错误与成功响应中回显的任务凭据、请求 JSON 中的自定义密钥均被脱敏。畸形 JSON 不回显输入；stdin/@file 仍可用于带凭据的请求。

## 真实视频工程，而不只是接口 mock

可复跑脚本：`node tests/creator-acceptance.mjs`。每次创建独立 `.cache/creator-flow/film-<uuid>`，完整保留源码和证据，不触及现有影片。

影片为原创几何动画《创作回路 · 从光点到成片》：12 秒、3 个连续变化的镜头、4 条音轨（2 条浏览器实时生成 + 2 条文件音效）、3 段中文字幕。导出 960×540、24 fps，按 4 秒分段，最终 288 帧完整解码。

流程实际包含新建、素材导入与来源记录、上下文读取、检查点、带哈希补丁、冲突拒绝、恢复预演与应用、作品浏览器测试、短段运行检查、六时间点分镜、含分轨 WAV 与 SRT 的审片包、正式分段导出及媒体验证。

针对 3.5–5.5 秒审片段，第一条转场音效应于相对 0.5 秒开始、0.85 秒结束；第二条转场音效应全段静音；字幕从相对 0.600 秒开始。脚本直接检查 PCM 能量与 SRT，而不以文件存在代替时序正确。

已通过图片工具查看六张分镜：环状光点 → 波形 → 影片画框的变化与字幕可见；这只是抽样视觉检查，不宣称逐帧完整审美验收。未执行主观听觉验收，保留 listening=not_run。

## 验证、证据与复跑

- 新增回归位于 `tests/server/creator-flow.test.mjs`，覆盖边界误报、坏上下文、旧引用、分页、错误与脱敏、真实预检、隔离副本和运行时指纹。
- 真实执行器的脚本化代理位于 `tests/fixtures/creator-executor-agent.mjs`。将其放到仅测试容器可见的 `/tools/codex/1.0.0/node_modules/.bin/codex`，以 task.runtime.tool.version=1.0.0 运行真实 server/executor.mjs；挂载本分支为只读 /opt/frame、独立可写 /workspace，使用 `--network none`。它先 build 再 check，专门验证进度文件回归。
- 最终公共检查：`.cache/creator-flow/verify-frozen.log` 与 `verify-frozen.exit`（0）。
- 最终成片工作流：`.cache/creator-flow/latest-acceptance.json`、`acceptance-final.log` 与 `acceptance-final.exit`。JSON 中记录工程、MP4、分镜、审片和 verification 的准确路径；其中 `/workspace` 对应本工作树。
- 真实执行器最终证据：`.cache/creator-flow/executor-frozen/result.json`、`executor-frozen.log`、`executor-frozen.exit`（0）、作品 records/executor-acceptance.json；结果 status=passed，约 17.7 秒完成执行器流程。无作品单元测试的阶段保留其内层 not_run，不计为作品业务单测通过。

正常维护环境可执行：

```sh
pnpm verify
node --test --test-concurrency=1 tests/server/creator-flow.test.mjs
node tests/creator-acceptance.mjs
```

本次采用独立开发容器、独立内部网络和临时 PostgreSQL 数据库。初期只读挂载共享 node_modules，后续复跑期间实际观察到 lucide-react 入口消失，导致聊天浏览器测试超时和执行器构建失败；失败日志保留在 verify-final.log 与 executor-final.log。这两次失败不计为通过。

最终改为从不可变工具镜像复制独立依赖卷 frame-creator-flow-deps，再只读挂载；Vite 临时缓存单独使用 tmpfs。镜像与本分支锁文件 SHA256 均为 c985323ad83312e89f77c59e2b5c0d2e1b54b4fb523f658ff042beb9104e5c67。pnpm 12 的运行前自动依赖同步试图写入只读卷，故仅在此冻结测试环境设置 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false，实际 pnpm config get 返回 false；不修改仓库配置、依赖版本、锁文件或安装脚本批准策略。正式验收依据 verify-frozen.log 和 verify-frozen.exit。

完整检查的命令会话截止设为 15 分钟，避免远端执行连接的默认超时误导测试状态。未触碰生产数据库、部署栈、现有影片或其他工作树。

## 边界与剩余限制

此次没有调用真实付费模型或外部付费语音，不能把脚本化代理及本地协议回归当作所有供应商联调验收。5 项跳过分别为 MCP 的 sampled preview，以及服务端真实 Codex、Claude、codex-invalid CLI 和 GeneralUser synthesis；原因是对应的真实 CLI 测试开关或 GeneralUser 采样包未就绪，不计作通过。

检查工具改善的是创作过程的可操作性与反馈真实性，不承诺自动获得优秀脚本、音乐或完整的艺术质量评判。长片整体节奏、主观听感、长时内存以及生产重新部署后的表现仍需要对应验收；本次没有发布生产环境。

本分支只做独立修改与提交，不自动合并 main。其他并行分支也修改执行器或公共工具时，应在合并后重跑公共检查和此真实工程脚本。
