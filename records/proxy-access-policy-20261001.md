# 入口访问策略交给反向代理 · 2026-10-01

## 要求与基线

用户要求删除 Invalid request origin，以及项目内限制域名和 TLS 的访问策略，统一交给反向代理。按当前 AGENTS.md 直接在 main 开发，基线 cbc01c2；开始时工作区干净，远端 main 与本地一致。

## 修改

- 删除登录、会话 API 写入、本地模式、OAuth 表单和 WebSocket 的 Origin/Host 检查。
- 删除远程 MCP 的 Host/Origin 白名单、全局回调域名白名单，以及 HTTP 仅限回环地址的要求。
- 平台 OAuth 动态注册接受任意 HTTP(S) 客户端回调；独立 MCP 同样按客户端登记的回调完成授权，不再要求 FRAME_OAUTH_REDIRECT_URIS。
- 删除平台和远程 MCP 的入口限流、密码失败临时锁定，以及入口 CSP、页面嵌入和 Referrer/CORP 限制。移除 @fastify/rate-limit 依赖及锁文件项。
- 平台信任代理转发头；会话和 OAuth Cookie 按实际请求协议生成 Secure 标记。规范地址只用于生成链接和 OAuth issuer/resource。
- CLI 与兼容语音服务支持任意域名或 IP 的 HTTP(S) 地址；--allow-http 作为兼容输入保留。
- 旧 FRAME_MCP_ALLOWED_ORIGINS 与 FRAME_OAUTH_REDIRECT_URIS 被忽略，旧环境配置可继续启动。
- 文档统一指向 docs/ACCESS-POLICY.md，清理旧的域名与 HTTPS 必填说明。
- 身份、Token、OAuth PKCE、精确注册回调绑定、有效期与撤销协议仍可用；作品代码隔离和数据写入边界继续用于执行及数据正确性。

## 实际验证

- pnpm verify 成功：类型检查与两个前端构建通过；Vitest 161 项通过；MCP 121 项通过、1 项可选音色库测试跳过；服务端 343 项通过、6 项按运行环境跳过，零失败。
- 跳过项涉及 Windows 本地执行、可选音色库、专用 Docker 执行器及对应真实 CLI 发布门禁；普通 verify 不作为生产发布验收。
- 完整验证完成后，针对最终取消全局回调白名单的修改重新运行 tests/mcp/remote.test.mjs：12 项通过，零跳过；平台 144 文件语法/相对导入检查及 typecheck:platform 通过。
- 覆盖缺少 Origin、Origin: null、HTTP/HTTPS 别名、替代 Host、代理协议与规范地址不一致、实际 WebSocket 握手和推送、真实浏览器 OAuth 授权、HTTP 回调、连续错误密码后合法授权、错误凭据/非法 URL 以及 OAuth 重放/撤销。
- 冻结锁文件离线校验通过，采用 --trust-lockfile 使用原有已锁定依赖摘要；校验前后锁文件 SHA-256 一致。常规离线策略校验缺少既有 caniuse-lite 元数据，本次没有重解析或升级其他依赖。
- git diff --check 通过；开发容器生成目录所有者恢复为 10001:10001。

日志在忽略的 .cache/proxy-access-verify.log、proxy-access-final-mcp.log、proxy-access-final-check.log、proxy-access-lockfile.log。

## 交付范围

本轮交付 main 源码与验证记录；未发布新版本或切换生产容器，没有数据库迁移。
