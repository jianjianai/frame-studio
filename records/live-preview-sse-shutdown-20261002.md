# 实时预览 SSE 关闭生命周期修复（2026-10-02）

## 问题与修改

Fastify 的 HTTP close 会等待持续打开的 SSE 响应；原实现只在客户端请求断开或预览会话关闭时结束响应，而预览管理器的 close 在 app onClose，形成关闭顺序阻塞。

仅修改 `server/live-preview-routes.mjs` 的实时事件路由：每次 install 的私有 closers Set 在 preClose 标记关闭并结束全部响应；关闭后拒绝新增 SSE；单个关闭幂等地删除自身记录、取消心跳、解除 session attach 和全部事件/请求监听；晚到的数据库心跳结果不再写旧响应，慢查询不会叠加下一次心跳。集合不跨应用，不关闭其他 HTTP 服务或全局资源。

## 实际验证

新增 `tests/server/live-preview-shutdown.test.mjs`，真实 Fastify HTTP 监听 OS 分配的 loopback 端口，使用 Node HTTP 保持 SSE 客户端打开，不靠调整测试夹具的浏览器关闭顺序解决问题。

命令：`node --test --test-concurrency=1 tests/server/live-preview-shutdown.test.mjs`。

- 多个打开的 SSE 在 app.close 时先于管理器 onClose 结束；关闭必须在 2 秒以内；生产 attach 计数、releases、Emitter 监听与心跳全部清零。测试还验证未完成数据库查询晚到后没有 ended-response 写入。
- 第一个客户端主动断开时仅清理自己的监听、attach 与心跳；第二个客户端仍收到真实状态事件，随后服务可正常关闭。
- preClose 暂停期间，新 HTTP SSE 请求返回 503，未产生新的 attach。

结果：3/3 通过、exit 0，总时长 652.85ms。`node --check` 两个产品/测试文件均通过。证据：`.cache/paseo-integration/live-preview-shutdown.log`、`.exit`。测试紧急清理仅作用于该实例持有的 socket；通过门槛先执行未主动销毁客户端的 app.close。

本次未运行整套验证、未改官方 Paseo 补丁、未发布或操作生产。产品与测试完成后冻结，由整体发布流程继续验证。
