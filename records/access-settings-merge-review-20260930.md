# 访问设置分支合并审核 · 2026-09-30

- 审核分支：`fix/access-settings`，原始提交 `933542f`。
- 主线基线：`5a9d970`；在原工作树合入主线，无冲突，保留 Remotion 执行器修复。
- 结论：值得合并。OAuth 列表在 LIMIT 之前排除已撤销记录，数据库撤销信息及令牌族保护仍保留；连接入口、授权列表、令牌管理和空/错误状态有明确使用价值。
- 审核修复：创建令牌弹窗在打开后聚焦名称输入框，成功后聚焦复制按钮；成功视图使用独立弹窗实例，清除此前关闭请求产生的“操作仍在进行”提示。只改访问设置组件。

## 本轮验证

- `git diff --check`、`node --check server/oauth.mjs`、`pnpm typecheck:platform`、最终 `pnpm build:studio` 通过。
- 定向服务端：`tests/server/api.test.mjs`、`tests/server/realtime-oauth.test.mjs`、`tests/server/oauth-browser.test.mjs` 共 3 项通过，0 失败、0 跳过。
- 真实工作台和数据库的 Chromium 定向交互共 10 组通过：101 条较新撤销记录不会挤掉有效/过期授权；桌面布局；MCP 地址复制与失败提示；撤销失败保留记录及成功后刷新；查询重试；令牌创建失败保留输入；处理中禁止关闭及明文仅显示一次；令牌撤销与 OAuth 空状态；手机布局与键盘焦点/Escape；无浏览器异常。
- 已检查 1440×1000 桌面与 390×844 手机截图，无页面横向溢出。
- 仅使用本次独立 Docker 网络、临时 PostgreSQL `frame_test_access_review` 和测试数据，不访问生产数据或真实 GitHub 作品分支。首次非 root Chromium 因测试镜像用户目录不可写启动失败，改用隔离测试容器 root 后通过。
- 按原任务要求采用轻量定向验证，没有运行全量 verify 或生产发布；以上结果仅覆盖此次改动及相关访问接口。
