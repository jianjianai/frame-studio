# 性能与 TTS 分支合并审核

审核日期：2026-10-01（Asia/Shanghai）。主分支基线：`29ac22e3f6069c4256ee62002eef22f95a796c86`，产品版本 7.6.0。

## 结论

两个分支均值得合并。保留全部分支提交历史，在 main 补齐审核发现的问题，再验证联合源码；本次范围是合并与清理，不发布新版本或切换生产。

| 分支 | 审核时 HEAD | 价值 | 本地合并提交 |
| --- | --- | --- | --- |
| `audit/performance-20260930` | `d2c106a9fc19b31201b673feeade463d13ec4fa9` | 降低 MCP 重复准备、长等待读取、大项目 IO 阻塞；修复锁连接饥饿，复用安全目录索引及渲染输入 | `5de8a8d97b98979b66e1d7c80e902e4316963398` |
| `feat/tts-narration-20260930` | `e77b103e7ee37b697d121c8b7614401d2ebf936b` | 提供商共享能力与适配器、音色发现、中文/电影旁白表达、试听与正式合成一致、进度与取消 | `0c0b0a7bc5399a27dc4f55cdf05e729eaaa32b61` |

## 审核发现及修复

1. **Remotion 缓存排他竞态**：原陈旧 `.control` 检查与递归删除不是原子仲裁。两个请求同时观察旧锁时，后删除者能删除先获锁者的新锁，产生并行编译和发布错误。改用内置 `node:sqlite` 派生缓存互斥文件，排他事务跨异步关键区，busy_timeout=0 配合异步重试，进程死亡由 OS 释放。固定锁 inode 不删除，锁 DB 和 journal/WAL/shm 拒绝软、硬链接；不引入新依赖或业务数据库迁移。新回归使用真实多子进程竞争与强制终止恢复。
2. **豆包请求字段**：原码率 128000 不在当前接口的默认允许值中，采样率层级也不符当前文档。改为官方默认 64000，并把 sample_rate 放到 audio_params；新增 HTTP 边界校验与试听/正式生成参数一致回归。依据：[官方单向流式 HTTP 文档](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)。
3. **音色目录异步过期结果**：切换引擎时，旧目录、分页结果、错误或 finally 曾可覆盖新引擎状态。引入绑定引擎/提供商/地址/模型的请求 generation；目录分页保留首批模型并去重声线。
4. **未保存密钥跨服务传递**：切换提供商或地址时清空密钥草稿并显示提示；保存过程中锁定配置字段。未改变同一提供商/地址留空保留已有密钥的规则。
5. **旧 Node 22 SQLite 兼容问题**：声明支持的 Node 22.17 对 numbered ?n 的位置参数绑定失败，旧 `29ac22e` 同样可复现，并非性能分支新增。改显式命名绑定，忽略 SQL 字面量/注释中的伪占位符，保留乱序、重复、缺口、匿名参数与大整数精度。

MCP 每次交换仍独立持有 server/transport；SQL 锁连接作用域、事务释放、任务断连等待、索引失效、IO worker 边界、资产删除前强制引用刷新均经独立审查。没有发现未解决的合并阻碍。

## 验证

联合性能/TTS 分支及全部审核修复（后分别提交为 `0df690f`、`f39470b`）完成 `pnpm verify`，退出码 0：83 项单元测试通过；MCP 115 项通过、1 项可选 SoundFont 夹具跳过；服务测试 261 项通过、6 项跳过；项目/平台检查、两套 TypeScript 检查及播放器/工作台构建通过。服务跳过包括 3 项真实代理 CLI、1 项 Windows 专属、1 项可选授权 GeneralUser SoundFont、1 项需要 Docker socket 的真实 MCP→Docker→CLI 执行器；不将其称为完整发布验收。

推送前发现远端 main 已推进至 `7839a7924bbf2d337db2fbdeeb350dbf791ae15a`，包含 Windows 控制中心升级与产品版本 7.6.1。保留这些并行提交，合并为 `80c5bcb3c0ca4471aef245ed7297a9966677a936`，重新复审 SQLite/任务逻辑；最终联合源码补跑平台检查、两套 TypeScript 检查、播放器/工作台构建及相关服务/本地模式/TTS/实际 Chromium 测试：60 项通过、1 项 Windows 专属跳过、0 失败。原生 Node 22.17 另跑最终 SQLite 编号绑定、JSON 文本/数值转换及本地状态回归：4 项通过、1 项 Windows 专属跳过、0 失败。没有把此前的全量结果冒充最新远端整合后的全量重跑。

额外聚焦验证：适配器和真实 App/SQLite/HTTP/MCP 15 项通过；实际 Chromium 的表达/取消/移动布局及目录、密钥回归 2 组通过；缓存单元在 Node 22.17 和 Node 24.21 各 6 项通过，真实 Remotion 浏览器缓存 1 项通过；SQLite 新回归 Node 22.17 的 2 项通过，并实际完成服务初始化/读取提供商。Python bridge 语法通过。重复复验不累加成总数。

初次 AgentDock Node 22 集成暴露上述旧 SQLite 绑定缺陷，修复后通过；UI 新测试首轮虚拟 JSX 夹具不被 Vite 导入分析支持，改为标准 React.createElement 夹具后通过，未放宽产品断言。首次失败和最终日志均保留。

## 限制与清理

性能记录的测量采用小样本、合成项目及 Fastify app.inject，不能等同生产网络 P95/P99；原基准采集先于本次互斥修复，不宣称最终代码具有完全相同的数值。新增锁池每服务进程最多 24 个 PostgreSQL 会话，需要纳入后续副本连接预算。云提供商中文听感、计费/地区权限及 Qwen GPU 推理未做真实账号验收，不能把协议测试称为音质验收。

原分支完整记录已随代码合入 `records/performance-20260930/`、`records/performance-optimization-20260930/` 和 `records/tts-narration-upgrade-20260930.md`。本次联合验证与精选原工作树日志保留在 main 的忽略目录 `.cache/branch-review-20261001/`；TTS 聚焦日志在 `.cache/tts-merge-review/`、`.cache/tts-ui-audit/`。测试使用专用 tmpfs PostgreSQL 与无 Docker socket 的隔离工具容器，未使用生产或共享测试数据库；容器结束后自动清理。

联合代码已正常推送 origin/main（`80c5bcb3c0ca4471aef245ed7297a9966677a936`），远端并行 Windows 更新保持完整；审核记录随后单独提交。清理前再次核对两个工作树没有未提交或未跟踪的源码，HEAD 与表中审核值一致，均为 main 的祖先。已用 git worktree remove 删除 frame-studio-performance、frame-studio-tts-narration，用 git branch -d 删除对应本地分支，并删除远端 feat/tts-narration-20260930；性能分支没有远端分支。最终 worktree list 仅剩 main，两目录与两本地/远端分支均已消失，main 依赖目录保留。本次专用测试容器与临时凭据文件已清理；没有进行发布或生产服务切换。
