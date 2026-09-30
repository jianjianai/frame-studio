# 创作工具更新分支合并审核 · 2026-09-30

审核分支：`feat/creator-tool-updates`，原提交 `0a05f3f`。结论：值得合并，完成修复与轻量验证后纳入 main。

## 审核结论

固定官方 npm 包、受限版本号与元数据响应、15 分钟成功缓存/1 分钟失败缓存、并发检查合并、先解析 latest 再固定任务版本，避免任意安装地址和执行时漂移。安装使用临时目录，验证实际 CLI 版本后原子切换 current，失败保留现有选择；界面覆盖手动版本、历史、进度、错误重试、本地模式与窄屏。

发现并修复：

- 原队列仅排除 queued/running。回归测试证明 cancelling 中可启动另一安装。操作层与持锁的最终任务准入同步阻止 cancelling/publishing/publish_failed，避免未结束安装或未保存结果与新安装重叠。
- publish_failed 使用现有 task_retry_publish 保存同一结果，界面阻止再次安装并提供“重试保存结果”。浏览器断言没有新 tools_update 调用。
- 官方版本服务的受控 502 提示原先被通用错误脱敏隐藏。仅将本模块固定错误标记可显示及可重试，原始网络/上游错误继续替换。

## 本次验证

在独立测试容器中共享只读依赖，不挂载 Docker socket、账号目录或生产数据，不安装真实 CLI 包。

- `node --test tests/server/tool-installation.test.mjs tests/server/tool-updates.test.mjs tests/server/tool-settings-browser.test.mjs`：11 项通过，0 失败、0 跳过。
- 先运行新增回归得到 2 项失败，再修复；覆盖 API 错误投影与 SQLite 实际任务锁定。
- 真实 Chromium、实际 React/Vite、模拟 WebSocket：latest/手动版本、输入保留、任务进度、失败重试、结果恢复、历史日志、localMode、390px 无横向溢出、无 pageerror。查看桌面与手机截图。
- `pnpm typecheck:platform`、`pnpm build:studio`、`git diff --check` 通过。最终提示文字调整后再次运行浏览器与 Studio 构建。

遵守用户要求只做相关轻量检查，没有运行全量发布流程或触碰生产服务。合并保留当前 main 的权限设置、回收站以及并行 Remotion 发布记录。
