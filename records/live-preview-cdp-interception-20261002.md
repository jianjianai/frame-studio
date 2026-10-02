# 实时预览 CDP 拦截测试生命周期修复 · 2026-10-02

## 实际失败

候选源 `6c8c71163af2` 的正式门禁在 `v8-live-preview-browser.test.mjs` 报 `unhandledRejection`：`Fetch.continueRequest: Invalid InterceptionId`。旧测试将 async 函数直接交给 CDP EventEmitter，未接收其 Promise；`Fetch.disable` 又早于在途命令排空，导致关闭竞态。产品预览与缓存路径无确证缺陷，本轮不修改产品。

原候选日志 `.cache/paseo-821/candidate-attempt-6c8c71163af2/candidate-verify-release-20261002T012935Z-84cdcc2c.log` 和既有源归档保留不变。

## 仅测试夹具修改

`tests/server/v8-live-preview-browser.test.mjs` 增加本测试专用的命令监督：

1. 同步事件回调立即登记每个待执行 Promise，捕获错误留待验证，避免孤立异步拒绝。
2. 停止时先移除 requestPaused 监听，排空已登记命令，再 Fetch.disable。关闭 Promise 可重复等待；正常与异常 finally 均在关闭浏览器之前执行此顺序。
3. 仅当命令为 continueRequest、错误精确为 Invalid InterceptionId，并且同一 networkId 有 `Network.loadingFailed(canceled:true)` 证据时，允许分类为已取消请求。错误事件可以晚于拒绝到达，分类留到关闭协议回合结束。取消标志 false、缺省、错误 ID 或其他协议错误均不放行；未知错误由 AggregateError 使测试失败。
4. 只有真实 failRequest 成功后才记录已中断 URL，强化一次实际中断的证明。原有 450ms RTT、8 秒热更新、传输量、缓存复用、音频/时间保持、离线恢复及草稿隔离断言均保留。

追加 6 个确定性用例：关闭前排空与监听释放、晚到匹配取消、无关联 ID、其他协议错误、同 ID false+ERR_ABORTED、同 ID 缺省 canceled+ERR_ABORTED。

## 当前源码实际验证

frame-development Node **24.21.0**，独立随机端口和新建自有 `frame_test_v8_cdp_<uuid>` 数据库：

- 原实际 V8 浏览器目标 + V8 压缩代理/原始素材/存活 Worker 目标 + 浏览器完整缓存/Range/Worker/Worklet/断网更新目标 + 6 个 fixture 用例：**9/9 PASS，0 skip，exit 0**，总耗时 64581.82ms。
- 原实际 V8 目标 47715.11ms；450ms RTT 冷启动 12803ms，热更新 **2944ms、5984 bytes**；实际未缓存模块中断后自动恢复，同一 AudioContext、暂停位置和最新画面保持正确。
- 证据 `.cache/paseo-821/v8-cdp-browser-target.log`、`.exit`。
- 测试仅在自有新数据库执行其 TRUNCATE，既有开发和正式 gate 数据库未复用。finally 只终止该数据库自身连接并 DROP，cleanup exit 0，证据 `.cache/paseo-821/v8-cdp-browser-cleanup.log`、`.exit`。数据库 URL 只在进程内改 pathname，未输出密码或环境。
- 只读同伴复审确认 tracked 关闭顺序、严格取消分类和原门槛未放宽；公开改动仅该测试与本记录。

没有修改源码 pin、既有候选归档、正式门禁日志、标签或生产环境。此结果证明当前工作区修复，后续完整候选门禁仍由发布方运行。
