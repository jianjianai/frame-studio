# Codex 账号模型分支合并审核 · 2026-09-30

分支 `fix/codex-account-models`，原提交 `e6df370`。结论：值得合并，未发现阻塞实现问题。

原生 Codex app-server 只进行 initialize、account/read、model/list，读取账号可用模型与明确宣告的参数，不进行推理。专用进程有总时间、2 MiB 响应、10 页/200 模型边界；账号类型、分页游标循环、协议失败与空目录均受控，CLI/上游错误不原样呈现。

同步复用账号独立环境、清除 API Key 干扰，连接锁合并同时刷新；读取最新配置，按 config 与 auth_generation 做 CAS，保留手动名称、禁用状态、参数覆盖与默认选择。失败保留账号及既有模型。UI 展示目录状态、来源、默认模型、同步/重试与登录阶段。

## 验证

- codex-model-catalog、provider-metadata、codex-account-browser：14 项通过，0 失败、0 跳过。包含原 12 项后端测试、1 项 UI 流程，以及新增 1 项真实 SQLite 三种竞争场景：读取期间配置更新、账号身份代次变化、最终 UPDATE 前配置变化，验证保存保护生效。
- 实际 Chromium 与 React，模拟 WebSocket，覆盖自动同步、重试、参数/默认选择、账号新建与手机登录布局；查看桌面和手机截图。原生协议用独立 fixture 子进程，未读取真实账号或连接实际 Codex 服务。
- check:platform（129 文件）、typecheck:platform、build:studio、git diff --check 通过。
- 合并后保留 AccessSettings 与 ToolSettings、新作品库 sort 和同步操作；最终联合版本再做相关集成检查。

检查使用隔离容器、临时 SQLite 和模拟账号，不挂载生产数据、Docker socket或账号目录。遵守轻量测试要求，不执行全量发布流程，不部署生产。
