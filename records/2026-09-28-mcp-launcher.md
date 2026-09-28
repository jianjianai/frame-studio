# Windows 一键启动远程 MCP

基线：main `d6faf44b9ac379e0494853fa64ab3c4055acbb71`。新增根目录 `启动MCP.cmd`，由用户双击启动远程 HTTP MCP；使用现有 OAuth/Bearer 与 Cloudflare 配置，不另开一套服务实现。

## 行为

- 自动进入脚本所在目录，检查 Node.js 22.13+；依赖缺失时寻找 pnpm.cmd 或 pnpm.exe，并使用锁文件安装，包含 MCP SDK 所在的开发工具依赖。
- 默认 `.env`，可传入 `.evn` 或带空格的配置路径。首次缺少配置会调用已有 init 生成私有凭据，提示填写后退出；已有配置不会覆盖。
- 先调用现有 check，再调用 serve。保留前台窗口；失败时显示错误并等待按键。启用的 Cloudflare 隧道由原服务统一管理。
- 使用 UTF-8 无 BOM 与 CRLF，兼容 Windows cmd 的中文提示与路径。

## 验证

实际执行 cmd 脚本，使用独占临时工作副本和临时回环端口：

1. 从其他工作目录启动，首次生成 `.env` 后正常退出。
2. 已有配置直接启动，`/healthz` 返回 ready，匿名 `/mcp` 返回 401，Bearer 的真实 MCP 初始化成功。
3. 带空格的自定义 `.evn` 文件路径可正确传递；错误 token 配置返回非零并显示原因。
4. 已有配置内容不变，终端未输出凭据；只结束测试自身进程树并清理独占目录。

公共 `pnpm verify` 使用独立端口 43185 完整运行至浏览器回归：

- 工程检查：5 项目，0 errors / 0 warnings；类型检查与生产构建通过。
- 单元测试：11 个文件、111 项通过；MCP 测试：33 项全部通过。
- 浏览器回归：18 通过、4 失败。失败为 paper-wings 与 sunny-rail 的 phrase-boundary reverse seeks 和 UI reverse determinism，均在 `tests/helpers/frame-match.ts` 的像素一致性断言处失败，通道差超过阈值 1。因此全仓检查未全绿。
- `git diff --check` 通过；脚本为 UTF-8 无 BOM、CRLF。临时目录与测试端口已释放。

完整日志位于忽略的 `.cache/mcp-launcher-verify.log`。本次只新增启动入口与说明，没有修改动画、播放器、图像比较阈值、真实 `.env` 或已经运行的用户服务；独立的脚本启动与认证检查通过。未重新下载已有依赖，首次安装命令的参数通过当前 pnpm CLI 校验。
