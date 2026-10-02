# 8.2.3 播放意图取消修复 · 2026-10-02

## 原因与修改

8.2.2 生产验收最后一个作品的暂停等待超时，独立同作品播放/暂停随后 3/3 通过。没有将该次生产超时认定为本缺陷的复现。

独立实际浏览器夹具仅延迟自有场景 render，复制的 Player、player-session、AudioTransport、FrameRenderer 与真实来源 SHA 相同。旧实现的 API play → pause → render 完成、以及界面启动 → 第二次点击暂停 → render 完成，都实际重新播放。准备画面之前尚未调用 AudioTransport.play，其 pause 不能取消上层迟到续体。

本次修改：

- player-session 统一播放意图代次和 starting 状态，覆盖 API、UI、初始自动播放和恢复会话。恢复在收到命令时占用意图，初始化及渲染完成后仍需属于当前请求且画面已提交，才能启动。
- 暂停、单帧、跳转、来源更新、隐藏、错误和销毁取消过时启动。旧 finally 不清掉新加载提示，已销毁实例不发布迟到状态。
- Player 的按钮、键盘、父页命令、选段、逐帧、时间线、画质及导出入口共用 session，捕获原实例处理异步错误。
- 普通播放和内部缓冲时的跳转、热更新保留 Transport 原续播机制，不把缓冲导致的 clock 暂停认作用户暂停。
- 已运行的重复 play 不重新创建音频代次；准备时复用原 Promise，内部缓冲等待原准备或同意图取消。先检查 buffering，再检查 playing，覆盖最后一次原生 resume 尚未完成的窗口。
- 没有新增时钟或修改 AudioTransport、用户作品。提交、版本和生产操作由主流程负责。

## 实际验证

独立 Vite 59915，Node 24，生产环境变量，无数据库或模型调用。

tests/server/player-intent-browser.test.mjs 最终 7/7 PASS、0 skip、12.395 秒（六个子项及父项）：

1. API pause/seek/frame 取消 render 等待中的启动，释放后保持暂停和时间稳定。
2. UI 准备期间第二次点击暂停；取消 A 后启动 B，A 的迟到完成不清掉 B 加载提示。
3. 父页 restore-session 在初始化和画面等待期间被暂停取消；正常暂停恢复及播放恢复仍工作。
4. 正常变速跳转、真实慢帧缓冲下 seek/update 保持续播；重复 play 保持音频代次和图实例。延迟真实 AudioContext.resume，验证 playing 与 buffering 同时为 true 时重复 play 仍等待原 Promise。
5. 页面隐藏和来源更新取消待启动。
6. 初始自动播放被暂停取消；销毁及替换后旧请求不启动，也不向旧实例回调。

最终 pnpm typecheck exit 0、git diff --check PASS。独立 session 审查 READY。独立 Space 键测试由浏览器审查者另行记录。

夹具 finally 关闭自有页面、浏览器、Vite、UUID 目录。实际后查确认夹具不存在，59915 可重新绑定并立即释放。

## 证据和限制

最终浏览器日志 .cache/paseo-823/player-intent-target-final.log：
SHA-256 9501dcfa352e2a2396c0f960b189f7894cdeab2bd9627a4b552fd7217636c47f。

最终类型日志 .cache/paseo-823/player-intent-typecheck-final.log：
SHA-256 8366207267355d3e3d5bf3bf6e8c94c5f93f6078c34f08973fa2b38cdda6cc92。

私有记录 .cache/paseo-823/player-intent-focused.json：
SHA-256 ac8e94e8cfc31925daca9b0a62e4a2e30b21ef28bc5a968a1dbf406ca987ea48。

初两轮直接挂载 session 的夹具未在 production 环境显式暴露调试 API，准备等待超时。首轮命令在 91.47 秒被工具超时中止，只有部分工具 stdout，没有完整落盘日志；第二轮 3 项通过、4 项失败，工具会话 session-b6ad0070a286336530684405 保留失败输出。修正夹具后 7/7 通过；随后补上独立审查发现的 buffering/playing 顺序边界，并重新 7/7 通过。没有降低断言。

本记录是聚焦浏览器和类型证据，不替代候选镜像完整门禁、实际生产验收，也不把独立确认的异步缺陷等同于原生产超时根因。

最终公开文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| src/ui/Player.tsx | 52a2d8d3ab8f3dc8e717f518d239c037cab905481f15cccec71df65bec2c9404 |
| src/engine/player-session.ts | 76b19e8766f8fc350915ae83d6997ec04e8206edead4a1441c8ca9f0c968a759 |
| tests/server/player-intent-browser.test.mjs | 02f7ad4484d9d00999c22fc327abe4b937ad8715445e206f17ecef5595f9c934 |
